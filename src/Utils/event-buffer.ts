import EventEmitter from 'events'
import type { waproto } from '../../WAProto/index.js'
import type {
	BaileysEvent,
	BaileysEventEmitter,
	BaileysEventMap,
	BufferedEventData,
	Chat,
	ChatUpdate,
	Contact,
	WAMessage,
	WAMessageKey
} from '../Types'
import { WAMessageStatus } from '../Types'
import { trimUndefined } from './generics'
import type { ILogger } from './logger'
import { updateMessageWithReaction, updateMessageWithReceipt } from './messages'
import { isRealMessage, shouldIncrementChatUnread } from './process-message'

const BUFFERABLE_EVENT = [
	'messaging-history.set',
	'chats.upsert',
	'chats.update',
	'chats.delete',
	'contacts.upsert',
	'contacts.update',
	'messages.upsert',
	'messages.update',
	'messages.delete',
	'messages.reaction',
	'message-receipt.update',
	'groups.update'
] as const

type BufferableEvent = (typeof BUFFERABLE_EVENT)[number]

/**
 * A map that contains a list of all events that have been triggered
 *
 * Note, this can contain different type of events
 * this can make processing events extremely efficient -- since everything
 * can be done in a single transaction
 */
type BaileysEventData = Partial<BaileysEventMap>

const BUFFERABLE_EVENT_SET = new Set<BaileysEvent>(BUFFERABLE_EVENT)

type BaileysBufferableEventEmitter = BaileysEventEmitter & {
	/** Use to process events in a batch */
	process(handler: (events: BaileysEventData) => void | Promise<void>): () => void
	/**
	 * starts buffering events, call flush() to release them
	 * */
	buffer(): void
	/** buffers all events till the promise completes */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	createBufferedFunction<A extends any[], T>(work: (...args: A) => Promise<T>): (...args: A) => Promise<T>
	/**
	 * flushes all buffered events
	 * @returns returns true if the flush actually happened, otherwise false
	 */
	flush(): boolean
	/** is there an ongoing buffer */
	isBuffering(): boolean
	/** destroy the event buffer, clearing all resources */
	destroy(): void
}

/**
 * The event buffer logically consolidates different events into a single event
 * making the data processing more efficient.
 */
const MAX_HISTORY_CACHE_SIZE = 10000 // Limit the history cache size to prevent memory bloat

const addHistoryCacheKey = (historyCache: Set<string>, key: string) => {
	// AunuBaileys (2.1.0, HB-310): the cap was declared but never enforced — a long history sync grew the dedup set without bound. Clearing only weakens dedup (a duplicate may be re-emitted once); no data is lost.
	if (historyCache.size >= MAX_HISTORY_CACHE_SIZE) {
		historyCache.clear()
	}

	historyCache.add(key)
}

export const makeEventBuffer = (logger: ILogger): BaileysBufferableEventEmitter => {
	const ev = new EventEmitter()
	const historyCache = new Set<string>()

	let data = makeBufferData()
	let isBuffering = false
	let bufferTimeout: NodeJS.Timeout | null = null
	let flushPendingTimeout: NodeJS.Timeout | null = null // Add a specific timer for the debounced flush to prevent leak
	let bufferCount = 0
	// AunuBaileys (2.2.0, HB-359): incremented at the start of every
	// buffering session. The 100ms flush timers armed by
	// createBufferedFunction capture the generation they belong to —
	// a timer left over from a previous session must never flush the
	// NEXT session early (its guards only consulted the global
	// counter, which the new session also satisfies).
	let bufferGeneration = 0
	const BUFFER_TIMEOUT_MS = 30000 // 30 seconds

	// take the generic event and fire it as a baileys event
	ev.on('event', (map: BaileysEventData) => {
		for (const event in map) {
			// AunuBaileys (1.0.81, HB-227/HB-228/HB-229 + 1.0.84
			// HB-264, re-applied P3): dispatch PER LISTENER with an
			// individual guard. A single ev.emit stops at the first
			// listener that throws \u2014 every later listener silently
			// missed the emit (a throwing logger registered before
			// the host's saveCreds made credential updates vanish),
			// and in timer/async contexts the throw became an
			// uncaught exception that killed the process. Log the
			// error and keep dispatching; the payload is unchanged.
			// rawListeners returns the once-wrappers themselves, so
			// once semantics are preserved.
			const listeners = ev.rawListeners(event)
			for (const listener of listeners) {
				try {
					const result = (listener as (...args: any[]) => unknown).call(ev, map[event as keyof BaileysEventMap])
					// AunuBaileys (2.2.0, HB-264 addendum): the guard
					// above only ever caught SYNCHRONOUS throws. An
					// async listener's rejection floated out of this
					// dispatcher as an unhandledRejection — fatal by
					// default on Node >= 15, and uncatchable by the
					// host (it happens on the library's stack). Attach
					// a catch to any thenable result; dispatch is
					// fire-and-forget by design.
					if (result && typeof (result as { catch?: unknown }).catch === 'function') {
						;(result as Promise<unknown>).catch(err =>
							logger.error({ err, event }, 'error in async event listener \u2014 dispatch continues')
						)
					}
				} catch (err) {
					logger.error({ err, event }, 'error in event listener \u2014 dispatch continues')
				}
			}
		}
	})

	function buffer() {
		if (!isBuffering) {
			logger.debug('Event buffer activated')
			isBuffering = true
			bufferCount = 0
			bufferGeneration += 1

			// AunuBaileys (2.2.0, HB-359): a debounced flush armed by
			// the PREVIOUS session must not fire into this one.
			if (flushPendingTimeout) {
				clearTimeout(flushPendingTimeout)
				flushPendingTimeout = null
			}

			if (bufferTimeout) {
				clearTimeout(bufferTimeout)
			}

			bufferTimeout = setTimeout(() => {
				if (isBuffering) {
					logger.warn('Buffer timeout reached, auto-flushing')
					flush()
				}
			}, BUFFER_TIMEOUT_MS)
		} else if (flushPendingTimeout) {
			// AunuBaileys (2.3.0, HB-359 addendum): new work starting in
			// the SAME session supersedes a debounced flush armed by
			// work that already finished — left armed, the timer fired
			// mid-work (its generation guard still matched) and ended
			// the session under the replacement work. The new work's
			// own completion arms a fresh timer.
			clearTimeout(flushPendingTimeout)
			flushPendingTimeout = null
		}

		// Always increment count when requested
		bufferCount++
	}

	function flush() {
		if (!isBuffering) {
			return false
		}

		// AunuBaileys (2.3.0, HB-359 addendum): a NESTED flush must not
		// end an outer buffering session. processNodeWithBuffer pairs
		// buffer()/flush() around every live stanza, so the first live
		// stanza inside an outer session (initial sync, offline drain)
		// used to flush everything, clear the 30s session timeout and
		// leave the rest of the window unbuffered. Release one nesting
		// level instead — the buffered data stays for the outer
		// owner's flush, which proceeds once the count is back to <= 1
		// (createBufferedFunction completions flush at 0 the same way).
		if (bufferCount > 1) {
			bufferCount -= 1
			logger.debug({ bufferCount }, 'nested flush: released one buffer level, session continues')
			return false
		}

		logger.debug({ bufferCount }, 'Flushing event buffer')
		isBuffering = false
		bufferCount = 0

		// Clear timeout
		if (bufferTimeout) {
			clearTimeout(bufferTimeout)
			bufferTimeout = null
		}

		if (flushPendingTimeout) {
			clearTimeout(flushPendingTimeout)
			flushPendingTimeout = null
		}

		// AunuBaileys (1.0.84, HB-130 + addendum, re-applied P3b): the
		// history dedup set only has to live for ONE buffering
		// session. It used to survive every flush (cleared only past
		// a size cap or in destroy()), so a second history sync
		// inside the same socket lifetime silently dropped every
		// already-known chat — and every already-known message key,
		// even when that message's content had changed. Dedup for
		// THIS session's appends already happened above; the next
		// session starts empty.
		historyCache.clear()

		const newData = makeBufferData()
		const chatUpdates = Object.values(data.chatUpdates)
		let conditionalChatUpdatesLeft = 0
		for (const update of chatUpdates) {
			if (update.conditional) {
				conditionalChatUpdatesLeft += 1
				newData.chatUpdates[update.id!] = update
				delete data.chatUpdates[update.id!]
			}
		}

		const consolidatedData = consolidateEvents(data)
		// AunuBaileys (HB-279, P4): { all: true } message deletes are
		// buffered separately (see append) — capture them from the OLD
		// buffer before the swap and emit each as its own event after
		// the consolidated batch, so a keys-form delete in the same
		// batch cannot crowd them out of the single map slot.
		const messageDeleteAllList = Object.values(data.messageDeleteAll)
		// AunuBaileys (1.0.81, HB-166 + HB-224, re-applied P3b): swap
		// the fresh buffer in BEFORE emitting, and guard the emit.
		// The old order assigned `data = newData` after the emit, so
		// (a) an event a listener re-buffered during the flush emit
		// landed in the OLD buffer object and was silently discarded
		// with it, and (b) a throw mid-emit left the whole batch in
		// `data`, to be delivered a second time by the next flush.
		// With the swap first, re-buffered events survive to the next
		// flush and the emitted batch is detached no matter what a
		// listener does.
		data = newData
		if (Object.keys(consolidatedData).length) {
			try {
				ev.emit('event', consolidatedData)
			} catch (err) {
				logger.error({ err }, 'error emitting flushed events')
			}
		}

		for (const deleteAll of messageDeleteAllList) {
			try {
				ev.emit('event', { 'messages.delete': deleteAll })
			} catch (err) {
				logger.error({ err }, 'error emitting flushed messages.delete (all) event')
			}
		}

		logger.trace({ conditionalChatUpdatesLeft }, 'released buffered events')

		return true
	}

	return {
		process(handler) {
			const listener = async (map: BaileysEventData) => {
				await handler(map)
			}

			ev.on('event', listener)
			return () => {
				ev.off('event', listener)
			}
		},
		emit<T extends BaileysEvent>(event: BaileysEvent, evData: BaileysEventMap[T]) {
			// Check if this is a messages.upsert with a different type than what's buffered
			// If so, flush the buffered messages first to avoid type overshadowing
			if (event === 'messages.upsert') {
				const { type } = evData as BaileysEventMap['messages.upsert']
				const existingUpserts = Object.values(data.messageUpserts)
				if (existingUpserts.length > 0) {
					const bufferedType = existingUpserts[0]!.type
					if (bufferedType !== type) {
						logger.debug({ bufferedType, newType: type }, 'messages.upsert type mismatch, emitting buffered messages')
						// Emit the buffered messages with their correct type
						ev.emit('event', {
							'messages.upsert': {
								messages: existingUpserts.map(m => m.message),
								type: bufferedType
							}
						})
						// Clear the message upserts from the buffer
						data.messageUpserts = {}
					}
				}
			}

			if (isBuffering && BUFFERABLE_EVENT_SET.has(event)) {
				append(data, historyCache, event as BufferableEvent, evData, logger)
				return true
			}

			return ev.emit('event', { [event]: evData })
		},
		isBuffering() {
			return isBuffering
		},
		buffer,
		flush,
		createBufferedFunction(work) {
			return async (...args) => {
				buffer()
				try {
					const result = await work(...args)
					// If this is the only buffer, flush after a small delay
					if (bufferCount === 1) {
						const generation = bufferGeneration
						setTimeout(() => {
							// AunuBaileys (2.3.0, HB-359 addendum): the
							// fire-time guard used to require
							// bufferCount === 1 — satisfied EXACTLY when
							// replacement work had started in the same
							// session (the finally below already dropped
							// the count to 0, new work raised it back to
							// 1), so the timer flushed mid-work. Only
							// flush when no work is running anymore.
							if (isBuffering && bufferCount === 0 && generation === bufferGeneration) {
								flush()
							}
						}, 100) // Small delay to allow nested buffers
					}

					return result
				} catch (error) {
					throw error
				} finally {
					bufferCount = Math.max(0, bufferCount - 1)
					if (bufferCount === 0) {
						// Only schedule ONE timeout, not 10,000
						if (!flushPendingTimeout) {
							const generation = bufferGeneration
							flushPendingTimeout = setTimeout(() => {
								flushPendingTimeout = null
								// AunuBaileys (2.3.0, HB-359 addendum):
								// the generation alone does not prove the
								// session is idle — replacement work in
								// the same generation raises the count
								// again, and this timer must not flush
								// underneath it. That work's completion
								// arms its own timer.
								if (generation === bufferGeneration && bufferCount === 0) {
									flush()
								}
							}, 100)
						}
					}
				}
			}
		},
		on: (...args) => ev.on(...args),
		off: (...args) => ev.off(...args),
		removeAllListeners: (...args) => ev.removeAllListeners(...args),
		destroy() {
			// Clear buffer timeout
			if (bufferTimeout) {
				clearTimeout(bufferTimeout)
				bufferTimeout = null
			}

			if (flushPendingTimeout) {
				clearTimeout(flushPendingTimeout)
				flushPendingTimeout = null
			}

			// Clear history cache
			historyCache.clear()
			// Reset buffer data
			data = makeBufferData()
			isBuffering = false
			bufferCount = 0
			// Remove all listeners
			ev.removeAllListeners()
			logger.debug('Event buffer destroyed')
		}
	}
}

const makeBufferData = (): BufferedEventData => {
	return {
		historySets: {
			chats: {},
			messages: {},
			contacts: {},
			isLatest: false,
			empty: true
		},
		chatUpserts: {},
		chatUpdates: {},
		chatDeletes: new Set(),
		contactUpserts: {},
		contactUpdates: {},
		messageUpserts: {},
		messageUpdates: {},
		messageReactions: {},
		messageDeletes: {},
		messageDeleteAll: {},
		messageReceipts: {},
		groupUpdates: {}
	}
}

function append<E extends BufferableEvent>(
	data: BufferedEventData,
	historyCache: Set<string>,
	event: E,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	eventData: any,
	logger: ILogger
) {
	switch (event) {
		case 'messaging-history.set':
			for (const chat of eventData.chats as Chat[]) {
				const id = chat.id || ''
				const existingChat = data.historySets.chats[id]
				if (existingChat) {
					// AunuBaileys (2.3.0, HB-394): the same chat can
					// legitimately arrive twice in one session
					// (INITIAL_BOOTSTRAP, then RECENT) and the second
					// snapshot is the fresher one — activity between
					// the two generations makes its fields newer. Only
					// endOfHistoryTransferType used to be copied; the
					// rest (name, conversationTimestamp, unreadCount,
					// archived, ...) was discarded and the flush
					// delivered the stale first copy. Merge the new
					// snapshot's present fields over the stored one.
					Object.assign(existingChat, trimUndefined(chat))
					absorbingChatUpdate(existingChat, true)
				}

				if (!existingChat && !historyCache.has(id)) {
					data.historySets.chats[id] = chat
					addHistoryCacheKey(historyCache, id)

					absorbingChatUpdate(chat, true)
				}
			}

			for (const contact of eventData.contacts as Contact[]) {
				const existingContact = data.historySets.contacts[contact.id]
				if (existingContact) {
					Object.assign(existingContact, trimUndefined(contact))
				} else {
					const historyContactId = `c:${contact.id}`
					const hasAnyName = contact.notify || contact.name || contact.verifiedName
					if (!historyCache.has(historyContactId) || hasAnyName) {
						data.historySets.contacts[contact.id] = contact
						addHistoryCacheKey(historyCache, historyContactId)
					}
				}
			}

			for (const message of eventData.messages as WAMessage[]) {
				const key = stringifyMessageKey(message.key)
				const existingMsg = data.historySets.messages[key]
				if (!existingMsg && !historyCache.has(key)) {
					data.historySets.messages[key] = message
					addHistoryCacheKey(historyCache, key)
				}
			}

			data.historySets.empty = false
			data.historySets.syncType = eventData.syncType
			if (eventData.pastParticipants?.length) {
				const merged = new Map<string, waproto.IPastParticipants>()
				const sigOf = (p: waproto.IPastParticipant) => `${p.userJid || ''}:${p.leaveTs || ''}:${p.leaveReason || ''}`
				const ingest = (entry: waproto.IPastParticipants) => {
					const key = entry.groupJid ?? JSON.stringify(entry)
					const existing = merged.get(key)
					if (!existing) {
						merged.set(key, { ...entry, pastParticipants: [...(entry.pastParticipants || [])] })
						return
					}

					const seen = new Set((existing.pastParticipants || []).map(sigOf))
					for (const p of entry.pastParticipants || []) {
						const sig = sigOf(p)
						if (!seen.has(sig)) {
							existing.pastParticipants!.push(p)
							seen.add(sig)
						}
					}
				}

				for (const entry of data.historySets.pastParticipants || []) ingest(entry)
				for (const entry of eventData.pastParticipants) ingest(entry)

				data.historySets.pastParticipants = [...merged.values()]
			}

			data.historySets.progress = eventData.progress
			data.historySets.chunkOrder = eventData.chunkOrder
			data.historySets.peerDataRequestSessionId = eventData.peerDataRequestSessionId
			data.historySets.isLatest = eventData.isLatest || data.historySets.isLatest

			break
		case 'chats.upsert':
			for (const chat of eventData as Chat[]) {
				const id = chat.id || ''
				let upsert = data.chatUpserts[id]
				if (id && !upsert) {
					upsert = data.historySets.chats[id]
					if (upsert) {
						logger.debug({ chatId: id }, 'absorbed chat upsert in chat set')
					}
				}

				if (upsert) {
					upsert = concatChats(upsert, chat)
				} else {
					upsert = chat
					data.chatUpserts[id] = upsert
				}

				absorbingChatUpdate(upsert)

				if (data.chatDeletes.has(id)) {
					data.chatDeletes.delete(id)
				}
			}

			break
		case 'chats.update':
			for (const update of eventData as ChatUpdate[]) {
				const chatId = update.id!
				const conditionMatches = update.conditional ? update.conditional(data) : true
				if (conditionMatches) {
					delete update.conditional

					// if there is an existing upsert, merge the update into it
					const upsert = data.historySets.chats[chatId] || data.chatUpserts[chatId]
					if (upsert) {
						concatChats(upsert, update)
					} else {
						// merge the update into the existing update
						const chatUpdate = data.chatUpdates[chatId] || {}
						data.chatUpdates[chatId] = concatChats(chatUpdate, update)
					}
				} else if (conditionMatches === undefined) {
					// condition yet to be fulfilled
					data.chatUpdates[chatId] = update
				}
				// otherwise -- condition not met, update is invalid

				// if the chat has been updated
				// ignore any existing chat delete
				if (data.chatDeletes.has(chatId)) {
					data.chatDeletes.delete(chatId)
				}
			}

			break
		case 'chats.delete':
			for (const chatId of eventData as string[]) {
				if (!data.chatDeletes.has(chatId)) {
					data.chatDeletes.add(chatId)
				}

				// remove any prior updates & upserts
				if (data.chatUpdates[chatId]) {
					delete data.chatUpdates[chatId]
				}

				if (data.chatUpserts[chatId]) {
					delete data.chatUpserts[chatId]
				}

				if (data.historySets.chats[chatId]) {
					delete data.historySets.chats[chatId]
				}

				// AunuBaileys (2.3.0, HB-404): a message that arrived
				// BEFORE the delete in this session is pre-delete —
				// consolidateEvents emits chats.delete BEFORE
				// messages.upsert in fixed category order, so without
				// this the flush delivered the delete first and the
				// older upsert after it, and the store's notify
				// handler recreated the chat with a phantom unread
				// (append type: the message itself survived
				// loadMessage). Drop every buffered message event for
				// this chat, the mirror of the keys-form
				// messages.delete dropping its upsert above. Only
				// events already buffered are dropped — a message
				// arriving AFTER the delete in the same session is
				// newer and must still recreate the chat, which the
				// fixed emit order already delivers correctly
				// (delete, then upsert).
				dropBufferedMessagesForChat(chatId)
			}

			break
		case 'contacts.upsert':
			for (const contact of eventData as Contact[]) {
				let upsert = data.contactUpserts[contact.id]
				if (!upsert) {
					upsert = data.historySets.contacts[contact.id]
					if (upsert) {
						logger.debug({ contactId: contact.id }, 'absorbed contact upsert in contact set')
					}
				}

				if (upsert) {
					upsert = Object.assign(upsert, trimUndefined(contact))
				} else {
					upsert = contact
					data.contactUpserts[contact.id] = upsert
				}

				if (data.contactUpdates[contact.id]) {
					// AunuBaileys (1.0.84, HB-182, re-applied P3b): the pending update
					// merges INTO the upsert. The old direction merged the contact into
					// the pending update object and then deleted that object — the
					// merged result went nowhere, and fields only the update carried
					// silently vanished from the flushed upsert.
					Object.assign(upsert, data.contactUpdates[contact.id])
					delete data.contactUpdates[contact.id]
				}
			}

			break
		case 'contacts.update':
			const contactUpdates = eventData as BaileysEventMap['contacts.update']
			for (const update of contactUpdates) {
				const id = update.id!
				// merge into prior upsert
				const upsert = data.historySets.contacts[id] || data.contactUpserts[id]
				if (upsert) {
					Object.assign(upsert, update)
				} else {
					// merge into prior update
					const contactUpdate = data.contactUpdates[id] || {}
					data.contactUpdates[id] = Object.assign(contactUpdate, update)
				}
			}

			break
		case 'messages.upsert':
			const { messages, type } = eventData as BaileysEventMap['messages.upsert']
			for (const message of messages) {
				// AunuBaileys (2.3.0, HB-379): a clear-chat
				// ({ all: true }) buffered EARLIER in this session must
				// not wipe a message that arrived after it. Flush emits
				// the consolidated map first and the delete-all events
				// after it regardless of arrival order, so without this
				// the newer message was delivered and then cleared.
				// The later upsert cancels the pending delete-all for
				// its chat — the reverse order already resolves at
				// append time (a later keys-delete drops the upsert).
				const remoteJid = message.key.remoteJid
				if (remoteJid && data.messageDeleteAll[remoteJid]) {
					delete data.messageDeleteAll[remoteJid]
				}

				const key = stringifyMessageKey(message.key)
				let existing = data.messageUpserts[key]?.message
				if (!existing) {
					existing = data.historySets.messages[key]
					if (existing) {
						logger.debug({ messageId: key }, 'absorbed message upsert in message set')
					}
				}

				if (existing) {
					message.messageTimestamp = existing.messageTimestamp
				}

				if (data.messageUpdates[key]) {
					logger.debug('absorbed prior message update in message upsert')
					Object.assign(message, data.messageUpdates[key].update)
					delete data.messageUpdates[key]
				}

				if (data.historySets.messages[key]) {
					data.historySets.messages[key] = message
				} else {
					data.messageUpserts[key] = {
						message,
						type: type === 'notify' || data.messageUpserts[key]?.type === 'notify' ? 'notify' : type
					}
				}
			}

			break
		case 'messages.update':
			const msgUpdates = eventData as BaileysEventMap['messages.update']
			for (const { key, update } of msgUpdates) {
				const keyStr = stringifyMessageKey(key)
				const existing = data.historySets.messages[keyStr] || data.messageUpserts[keyStr]?.message
				if (existing) {
					// AunuBaileys (2.2.0, HB-370): the buffered
					// message's key is its identity — a messages.update
					// carrying a foreign key (the REVOKE producer
					// attaches the protocol message's key) must not
					// re-key the buffered upsert before it is emitted.
					const { key: _updateKey, ...restUpdate } = update as Partial<WAMessage>
					Object.assign(existing, restUpdate)
					// if the message was received & read by us
					// the chat counter must have been incremented
					// so we need to decrement it
					if (update.status === WAMessageStatus.READ && !key.fromMe) {
						decrementChatReadCounterIfMsgDidUnread(existing)
					}
				} else {
					const msgUpdate = data.messageUpdates[keyStr] || { key, update: {} }
					Object.assign(msgUpdate.update, update)
					data.messageUpdates[keyStr] = msgUpdate
				}
			}

			break
		case 'messages.delete':
			const deleteData = eventData as BaileysEventMap['messages.delete']
			if ('keys' in deleteData) {
				const { keys } = deleteData
				for (const key of keys) {
					const keyStr = stringifyMessageKey(key)
					if (!data.messageDeletes[keyStr]) {
						data.messageDeletes[keyStr] = key
					}

					if (data.messageUpserts[keyStr]) {
						delete data.messageUpserts[keyStr]
					}

					if (data.messageUpdates[keyStr]) {
						delete data.messageUpdates[keyStr]
					}
				}
			} else if ('all' in deleteData && deleteData.all && typeof deleteData.jid === 'string') {
				// AunuBaileys (HB-279, P4): the { all: true } form used
				// to fall into a bare TODO branch — append swallowed
				// it while emit() still claimed the event was
				// buffered, so a clear-chat published during buffering
				// (history sync / offline drain) never reached any
				// listener. Buffer it per-jid like the keys form; it
				// is re-emitted as its own event at flush time (see
				// flush), since one consolidated map slot cannot hold
				// both delete shapes.
				data.messageDeleteAll[deleteData.jid] = { jid: deleteData.jid, all: true }
			}

			break
		case 'messages.reaction':
			const reactions = eventData as BaileysEventMap['messages.reaction']
			for (const { key, reaction } of reactions) {
				// AunuBaileys (1.0.86, HB-187, re-applied P3b): a reaction whose
				// target key is missing (an optional proto field) threw a raw
				// TypeError inside stringifyMessageKey — after the delivery receipt
				// had already been sent, so the stanza also earned a NACK 500 and
				// the reaction was lost. A key-less reaction has no target; skip it.
				if (!key) {
					continue
				}

				const keyStr = stringifyMessageKey(key)
				const existing = data.messageUpserts[keyStr]
				if (existing) {
					updateMessageWithReaction(existing.message, reaction)
				} else {
					data.messageReactions[keyStr] = data.messageReactions[keyStr] || { key, reactions: [] }
					updateMessageWithReaction(data.messageReactions[keyStr], reaction)
				}
			}

			break
		case 'message-receipt.update':
			const receipts = eventData as BaileysEventMap['message-receipt.update']
			for (const { key, receipt } of receipts) {
				const keyStr = stringifyMessageKey(key)
				const existing = data.messageUpserts[keyStr]
				if (existing) {
					updateMessageWithReceipt(existing.message, receipt)
				} else {
					data.messageReceipts[keyStr] = data.messageReceipts[keyStr] || { key, userReceipt: [] }
					updateMessageWithReceipt(data.messageReceipts[keyStr], receipt)
				}
			}

			break
		case 'groups.update':
			const groupUpdates = eventData as BaileysEventMap['groups.update']
			for (const update of groupUpdates) {
				const id = update.id!
				// AunuBaileys (1.0.86, HB-176, re-applied P3b): a second update for
				// the same group inside one buffer window used to be discarded
				// whole — the merge only ran when no update was stored yet, so a
				// subject change followed by a description change delivered only
				// the subject. Merge into the stored update, like chats.update.
				data.groupUpdates[id] = Object.assign(data.groupUpdates[id] || {}, update)
			}

			break
		default:
			throw new Error(`"${event}" cannot be buffered`)
	}

	function dropBufferedMessagesForChat(chatId: string) {
		for (const keyStr of Object.keys(data.messageUpserts)) {
			if (data.messageUpserts[keyStr]?.message.key.remoteJid === chatId) {
				delete data.messageUpserts[keyStr]
			}
		}

		for (const keyStr of Object.keys(data.messageUpdates)) {
			if (data.messageUpdates[keyStr]?.key.remoteJid === chatId) {
				delete data.messageUpdates[keyStr]
			}
		}

		for (const keyStr of Object.keys(data.messageReactions)) {
			if (data.messageReactions[keyStr]?.key.remoteJid === chatId) {
				delete data.messageReactions[keyStr]
			}
		}

		for (const keyStr of Object.keys(data.messageReceipts)) {
			if (data.messageReceipts[keyStr]?.key.remoteJid === chatId) {
				delete data.messageReceipts[keyStr]
			}
		}

		for (const keyStr of Object.keys(data.historySets.messages)) {
			if (data.historySets.messages[keyStr]?.key.remoteJid === chatId) {
				delete data.historySets.messages[keyStr]
			}
		}
	}

	function absorbingChatUpdate(existing: Chat, fromHistorySet = false) {
		const chatId = existing.id || ''
		const update = data.chatUpdates[chatId]
		if (update) {
			const conditionMatches = update.conditional ? update.conditional(data) : true
			if (conditionMatches) {
				delete update.conditional
				logger.debug({ chatId }, 'absorbed chat update in existing chat')
				// AunuBaileys (2.3.0, HB-393): capture BEFORE the merge
				// — concatChats assigns the merged result back into the
				// update object, overwriting its unreadCount.
				const updateUnreadCount = update.unreadCount
				Object.assign(existing, concatChats(update as Chat, existing))
				// AunuBaileys (2.3.0, HB-393): a pending app-state
				// update absorbed into a HISTORY snapshot overlays
				// state newer than the snapshot itself — an absolute
				// unreadCount (0 mark-read, -1 mark-unread) in such an
				// update must win over the snapshot's count, not be
				// summed into it by concatChats. Live upserts are not
				// snapshots: a message arriving after the read must
				// still count, so this only applies to history chats.
				if (fromHistorySet && typeof updateUnreadCount === 'number' && updateUnreadCount <= 0) {
					existing.unreadCount = updateUnreadCount
				}

				delete data.chatUpdates[chatId]
			} else if (conditionMatches === false) {
				logger.debug({ chatId }, 'chat update condition fail, removing')
				delete data.chatUpdates[chatId]
			}
		}
	}

	function decrementChatReadCounterIfMsgDidUnread(message: WAMessage) {
		// decrement chat unread counter
		// if the message has already been marked read by us
		const chatId = message.key.remoteJid!
		// AunuBaileys (2.3.0, HB-390): the chat may live ONLY in the
		// history set — messaging-history.set stores it there, and a
		// chats.update for it merges into that same object instead of
		// creating a chatUpdates entry. The old lookup missed those
		// chats entirely, so a READ receipt during history sync never
		// decremented and the flushed chat kept a phantom +1.
		const chat = data.historySets.chats[chatId] || data.chatUpdates[chatId] || data.chatUpserts[chatId]
		if (
			isRealMessage(message) &&
			shouldIncrementChatUnread(message) &&
			typeof chat?.unreadCount === 'number' &&
			chat.unreadCount > 0
		) {
			logger.debug({ chatId: chat.id }, 'decrementing chat counter')
			chat.unreadCount -= 1
			if (chat.unreadCount === 0) {
				delete chat.unreadCount
			}
		}
	}
}

function consolidateEvents(data: BufferedEventData) {
	const map: BaileysEventData = {}

	if (!data.historySets.empty) {
		map['messaging-history.set'] = {
			chats: Object.values(data.historySets.chats),
			messages: Object.values(data.historySets.messages),
			contacts: Object.values(data.historySets.contacts),
			pastParticipants: data.historySets.pastParticipants,
			syncType: data.historySets.syncType,
			progress: data.historySets.progress,
			isLatest: data.historySets.isLatest,
			chunkOrder: data.historySets.chunkOrder,
			peerDataRequestSessionId: data.historySets.peerDataRequestSessionId
		}
	}

	const chatUpsertList = Object.values(data.chatUpserts)
	if (chatUpsertList.length) {
		map['chats.upsert'] = chatUpsertList
	}

	const chatUpdateList = Object.values(data.chatUpdates)
	if (chatUpdateList.length) {
		map['chats.update'] = chatUpdateList
	}

	const chatDeleteList = Array.from(data.chatDeletes)
	if (chatDeleteList.length) {
		map['chats.delete'] = chatDeleteList
	}

	const messageUpsertList = Object.values(data.messageUpserts)
	if (messageUpsertList.length) {
		const type = messageUpsertList[0]!.type
		map['messages.upsert'] = {
			messages: messageUpsertList.map(m => m.message),
			type
		}
	}

	const messageUpdateList = Object.values(data.messageUpdates)
	if (messageUpdateList.length) {
		map['messages.update'] = messageUpdateList
	}

	const messageDeleteList = Object.values(data.messageDeletes)
	if (messageDeleteList.length) {
		map['messages.delete'] = { keys: messageDeleteList }
	}

	const messageReactionList = Object.values(data.messageReactions).flatMap(({ key, reactions }) =>
		reactions.flatMap(reaction => ({ key, reaction }))
	)
	if (messageReactionList.length) {
		map['messages.reaction'] = messageReactionList
	}

	const messageReceiptList = Object.values(data.messageReceipts).flatMap(({ key, userReceipt }) =>
		userReceipt.flatMap(receipt => ({ key, receipt }))
	)
	if (messageReceiptList.length) {
		map['message-receipt.update'] = messageReceiptList
	}

	const contactUpsertList = Object.values(data.contactUpserts)
	if (contactUpsertList.length) {
		map['contacts.upsert'] = contactUpsertList
	}

	const contactUpdateList = Object.values(data.contactUpdates)
	if (contactUpdateList.length) {
		map['contacts.update'] = contactUpdateList
	}

	const groupUpdateList = Object.values(data.groupUpdates)
	if (groupUpdateList.length) {
		map['groups.update'] = groupUpdateList
	}

	return map
}

function concatChats<C extends Partial<Chat>>(a: C, b: Partial<Chat>) {
	if (
		b.unreadCount === null && // neutralize unread counter
		a.unreadCount! < 0
	) {
		a.unreadCount = undefined
		b.unreadCount = undefined
	}

	if (typeof a.unreadCount === 'number' && typeof b.unreadCount === 'number') {
		b = { ...b }
		// AunuBaileys (2.3.0, HB-393): unreadCount 0 is an ABSOLUTE
		// mark-read value (processSyncAction emits read ? 0 : -1), not
		// a delta — summing it into the pending count swallowed the
		// read whole (N + 0 = N) and the flushed chat stayed unread.
		// Only positive counts are deltas and accumulate; 0 assigns,
		// and a negative sentinel keeps passing through untouched.
		if (b.unreadCount! > 0) {
			b.unreadCount = Math.max(b.unreadCount!, 0) + Math.max(a.unreadCount, 0)
		}
	}

	return Object.assign(a, b)
}

const stringifyMessageKey = (key: WAMessageKey) => `${key.remoteJid},${key.id},${key.fromMe ? '1' : '0'}`

// AunuCore fork backport: in-memory store dari Baileys 6.6.0, dikonversi ke ESM untuk basis 6.7.x
// Ported to TypeScript for the AunuBaileys v7 tree (2.0.0); behaviour identical to the v6 module.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { proto } from '../../WAProto/index.js'
import { KeyedDB } from './keyed-db.js'
import type { Comparable } from './keyed-db.js'
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js'
import type makeWASocket from '../Socket/index.js'
import type {
	BaileysEventEmitter,
	Chat,
	ConnectionState,
	Contact,
	GroupMetadata,
	PresenceData,
	WAMessage,
	WAMessageCursor,
	WAMessageKey
} from '../Types/index.js'
import type { Label } from '../Types/Label.js'
import type { LabelAssociation } from '../Types/LabelAssociation.js'
import { LabelAssociationType } from '../Types/LabelAssociation.js'
import type { ILogger } from '../Utils/logger.js'
import { toNumber, updateMessageWithReaction, updateMessageWithReceipt } from '../Utils/index.js'
import { jidNormalizedUser } from '../WABinary/index.js'
import makeOrderedDictionary from './make-ordered-dictionary.js'
import { ObjectRepository } from './object-repository.js'

type WASocket = ReturnType<typeof makeWASocket>

export const waChatKey = (pin: boolean) => ({
	key: (c: Chat) =>
		(pin ? (c.pinned ? '1' : '0') : '') +
		(c.archived ? '0' : '1') +
		(c.conversationTimestamp ? c.conversationTimestamp.toString(16).padStart(8, '0') : '') +
		c.id,
	compare: (k1: string, k2: string) => k2.localeCompare(k1)
})

export const waMessageID = (m: WAMessage) => m.key.id || ''

export const waLabelAssociationKey: Comparable<LabelAssociation, string> = {
	key: (la: LabelAssociation) =>
		la.type === LabelAssociationType.Chat ? la.chatId + la.labelId : la.chatId + (la as any).messageId + la.labelId,
	compare: (k1: string, k2: string) => k2.localeCompare(k1)
}

const makeMessagesDictionary = () => makeOrderedDictionary(waMessageID)

const predefinedLabels: { [_: string]: Label } = Object.freeze({
	'1': {
		id: '1',
		name: 'New customer',
		predefinedId: '1',
		color: 1,
		deleted: false
	},
	'2': {
		id: '2',
		name: 'New order',
		predefinedId: '2',
		color: 2,
		deleted: false
	},
	'3': {
		id: '3',
		name: 'Pending payment',
		predefinedId: '3',
		color: 3,
		deleted: false
	},
	'4': {
		id: '4',
		name: 'Paid',
		predefinedId: '4',
		color: 4,
		deleted: false
	},
	'5': {
		id: '5',
		name: 'Order completed',
		predefinedId: '5',
		color: 5,
		deleted: false
	}
})

export type BaileysInMemoryStoreConfig = {
	chatKey?: Comparable<Chat, string>
	labelAssociationKey?: Comparable<LabelAssociation, string>
	logger?: ILogger
}

type MessagesDictionary = ReturnType<typeof makeMessagesDictionary>

const makeInMemoryStore = ({ logger: _logger, chatKey, labelAssociationKey }: BaileysInMemoryStoreConfig) => {
	chatKey = chatKey || waChatKey(true)
	labelAssociationKey = labelAssociationKey || waLabelAssociationKey
	const logger: ILogger = _logger || DEFAULT_CONNECTION_CONFIG.logger.child({ stream: 'in-mem-store' })

	const chats: any = new KeyedDB(chatKey, (c: Chat) => c.id as string)
	const messages: { [_: string]: MessagesDictionary } = {}
	const contacts: { [_: string]: Contact } = {}
	const groupMetadata: { [_: string]: GroupMetadata } = {}
	const presences: { [id: string]: { [participant: string]: PresenceData } } = {}
	const state = { connection: 'close' } as ConnectionState
	const labels = new ObjectRepository<Label>(predefinedLabels)
	const labelAssociations: any = new KeyedDB(labelAssociationKey, (labelAssociationKey as any).key)

	const assertMessageList = (jid: string) => {
		if (!messages[jid]) {
			messages[jid] = makeMessagesDictionary()
		}

		return messages[jid]!
	}

	const contactsUpsert = (newContacts: Contact[]) => {
		const oldContacts = new Set(Object.keys(contacts))
		for (const contact of newContacts) {
			oldContacts.delete(contact.id)
			contacts[contact.id] = Object.assign(contacts[contact.id] || {}, contact)
		}

		return oldContacts
	}

	const labelsUpsert = (newLabels: Label[]) => {
		for (const label of newLabels) {
			labels.upsertById(label.id, label)
		}
	}

	/**
	 * binds to a BaileysEventEmitter.
	 * It listens to all events and constructs a state that you can query accurate data from.
	 * Eg. can use the store to fetch chats, contacts, messages etc.
	 * @param ev typically the event emitter from the socket connection
	 */
	const bind = (ev: BaileysEventEmitter) => {
		ev.on('connection.update', update => {
			Object.assign(state, update)
		})

		ev.on('messaging-history.set', ({ chats: newChats, contacts: newContacts, messages: newMessages, isLatest }) => {
			if (isLatest) {
				chats.clear()
				for (const id in messages) {
					delete messages[id]
				}
			}

			const chatsAdded = chats.insertIfAbsent(...newChats).length
			logger.debug({ chatsAdded }, 'synced chats')

			const oldContacts = contactsUpsert(newContacts)

			if (isLatest) {
				for (const jid of oldContacts) {
					delete contacts[jid]
				}
			}

			logger.debug({ deletedContacts: isLatest ? oldContacts.size : 0, newContacts }, 'synced contacts')

			for (const msg of newMessages) {
				const jid = msg.key.remoteJid!
				const list = assertMessageList(jid)
				list.upsert(msg, 'prepend')
			}

			logger.debug({ messages: newMessages.length }, 'synced messages')
		})

		ev.on('contacts.upsert', contacts => {
			contactsUpsert(contacts)
		})

		ev.on('contacts.update', updates => {
			for (const update of updates) {
				if (update.id && contacts[update.id]) {
					Object.assign(contacts[update.id]!, update)
					// AunuBaileys (1.0.84, HB-245): a picture
					// notification arrives as imgUrl 'changed' /
					// 'removed' — a sentinel, not a URL. Drop the
					// cached URL instead of storing the sentinel:
					// fetchImageUrl used to hand the literal string
					// 'changed' to the host as the avatar URL, and
					// writeToFile persisted the poison to disk.
					if (update.imgUrl === 'changed' || update.imgUrl === 'removed') {
						delete contacts[update.id]!.imgUrl
					}
				} else {
					logger.debug({ update }, 'got update for non-existant contact')
				}
			}
		})

		ev.on('chats.upsert', newChats => {
			// AunuBaileys (HB-278, P4): a bulk upsert used to abort on
			// the first chat whose waChatKey sort key collided with an
			// existing one — every healthy chat AFTER it in the batch
			// was lost with it. Isolate per entry (HB-134 pattern).
			for (const chat of newChats) {
				try {
					chats.upsert(chat)
				} catch (err) {
					logger.warn({ chatId: chat.id, err }, 'aunu: skipped a chat upsert whose sort key collided')
				}
			}
		})

		ev.on('chats.update', updates => {
			for (let update of updates) {
				// AunuBaileys (HB-278, P4): KeyedDB.update deletes the
				// entry from its dict+array BEFORE re-inserting under
				// the new sort key — when that insert throws on a key
				// collision, the chat is GONE from the store. Snapshot
				// first (the update mutates the stored object in
				// place, so the snapshot must be a copy), and on
				// failure restore the pre-update chat under its old
				// key, which the delete just freed.
				const snapshot = chats.get(update.id)
				const snapshotCopy = snapshot ? { ...snapshot } : undefined
				try {
					const result = chats.update(update.id, (chat: Chat) => {
						if (update.unreadCount && update.unreadCount > 0) {
							const unreadCount = update.unreadCount
							update = { ...update }
							update.unreadCount = (chat.unreadCount || 0) + unreadCount
						}

						Object.assign(chat, update)
					})
					if (!result) {
						logger.debug({ update }, 'got update for non-existant chat')
					}
				} catch (err) {
					logger.warn({ update, err }, 'aunu: chat update failed; restoring the pre-update chat')
					if (snapshotCopy && !chats.get(update.id)) {
						try {
							chats.upsert(snapshotCopy)
						} catch (restoreErr) {
							logger.warn({ update, err: restoreErr }, 'aunu: failed to restore the chat after a failed update')
						}
					}
				}
			}
		})

		ev.on('labels.edit', label => {
			if (label.deleted) {
				return labels.deleteById(label.id)
			}

			// WhatsApp can store only up to 20 labels
			if (labels.count() < 20) {
				return labels.upsertById(label.id, label)
			}

			logger.error('Labels count exceed')
		})

		ev.on('labels.association', ({ type, association }) => {
			switch (type) {
				case 'add':
					labelAssociations.upsert(association)
					break
				case 'remove':
					labelAssociations.delete(association)
					break
				default:
					console.error(`unknown operation type [${type}]`)
			}
		})

		ev.on('presence.update', ({ id, presences: update }) => {
			presences[id] = presences[id] || {}
			Object.assign(presences[id]!, update)
		})

		ev.on('chats.delete', deletions => {
			for (const item of deletions) {
				if (chats.get(item)) {
					chats.deleteById(item)
				}
			}
		})

		ev.on('messages.upsert', ({ messages: newMessages, type }) => {
			switch (type) {
				case 'append':
				case 'notify':
					for (const msg of newMessages) {
						const jid = jidNormalizedUser(msg.key.remoteJid!)
						const list = assertMessageList(jid)
						list.upsert(msg, 'append')

						if (type === 'notify') {
							if (!chats.get(jid)) {
								ev.emit('chats.upsert', [
									{
										id: jid,
										conversationTimestamp: toNumber(msg.messageTimestamp),
										unreadCount: 1
									}
								])
							}
						}
					}

					break
			}
		})

		ev.on('messages.update', updates => {
			for (const { update, key } of updates) {
				const list = assertMessageList(jidNormalizedUser(key.remoteJid!))
				if (update?.status) {
					const listStatus = list.get(key.id!)?.status
					if (listStatus && update?.status <= listStatus) {
						logger.debug({ update, storedStatus: listStatus }, 'status stored newer then update')
						delete update.status
						logger.debug({ update }, 'new update object')
					}
				}

				const result = list.updateAssign(key.id!, update as Partial<WAMessage>)
				if (!result) {
					logger.debug({ update }, 'got update for non-existent message')
				}
			}
		})

		ev.on('messages.delete', item => {
			if ('all' in item) {
				const list = messages[item.jid]
				list?.clear()
			} else {
				const jid = item.keys[0]!.remoteJid
				const list = jid ? messages[jid] : undefined
				if (list) {
					const idSet = new Set(item.keys.map(k => k.id))
					list.filter(m => !idSet.has(m.key.id))
				}
			}
		})

		ev.on('groups.update', updates => {
			for (const update of updates) {
				const id = update.id
				if (id && groupMetadata[id]) {
					Object.assign(groupMetadata[id]!, update)
				} else {
					logger.debug({ update }, 'got update for non-existant group metadata')
				}
			}
		})

		ev.on('group-participants.update', ({ id, participants, action }) => {
			const metadata = groupMetadata[id]
			if (metadata) {
				switch (action) {
					case 'add':
						// AunuBaileys (1.0.84, HB-237): skip ids
						// that are already listed. The metadata is
						// usually populated by a fetch that already
						// contains the member, and a redelivery
						// replays the notification — both used to
						// push a duplicate entry every single time,
						// without bound.
						for (const participant of participants as any[]) {
							const participantId = typeof participant === 'string' ? participant : participant.id
							if (!metadata.participants.some(p => p.id === participantId)) {
								metadata.participants.push({ id: participantId, isAdmin: false, isSuperAdmin: false } as any)
							}
						}

						break
					case 'demote':
					case 'promote':
						for (const participant of metadata.participants) {
							if ((participants as any[]).some((p: any) => (typeof p === 'string' ? p : p.id) === participant.id)) {
								participant.isAdmin = action === 'promote'
							}
						}

						break
					case 'remove':
						metadata.participants = metadata.participants.filter(
							p => !(participants as any[]).some((x: any) => (typeof x === 'string' ? x : x.id) === p.id)
						)
						break
				}
			}
		})

		ev.on('message-receipt.update', updates => {
			for (const { key, receipt } of updates) {
				const obj = key.remoteJid ? messages[key.remoteJid] : undefined
				const msg = obj?.get(key.id!)
				if (msg) {
					updateMessageWithReceipt(msg, receipt)
				}
			}
		})

		ev.on('messages.reaction', reactions => {
			for (const { key, reaction } of reactions) {
				// AunuBaileys (1.0.86, HB-187 addendum): a key-less
				// reaction (host-emitted, or delivered unbuffered)
				// dereferenced key.remoteJid bare here and threw
				// inside the listener. It has no target; skip it.
				if (!key?.remoteJid) {
					continue
				}

				const obj = messages[key.remoteJid]
				const msg = obj?.get(key.id!)
				if (msg) {
					updateMessageWithReaction(msg, reaction)
				}
			}
		})
	}

	const toJSON = () => ({
		chats,
		contacts,
		messages,
		labels,
		labelAssociations
	})

	const fromJSON = (json: any) => {
		// AunuBaileys (1.0.84, HB-134 + HB-142 + addenda): every
		// stage — and every entry — is isolated. One poisoned
		// message entry used to throw out of fromJSON mid-loop:
		// that jid's remaining messages and EVERY later jid were
		// silently lost on every boot, while the stages before
		// the throw stayed applied and readFromFile logged
		// "starting with an empty store" — a claim the state did
		// not match. A missing/null contacts stage threw the
		// same way (Object.values of undefined), and a poisoned
		// contacts/labels entry aborted every stage after it.
		// Wrong-typed stages now read as empty, unusable entries
		// are skipped, and a bad message entry is caught per
		// entry with a warning — the healthy remainder of the
		// file always loads.
		if (!json || typeof json !== 'object') {
			return
		}

		const entriesOf = (value: any) => (Array.isArray(value) ? value : []).filter(e => !!e && typeof e === 'object')
		const valuesOf = (value: any): any[] => (value && typeof value === 'object' ? Object.values(value) : [])
		// AunuBaileys (HB-274, P4): the chats stage used to bulk-upsert —
		// two stored chats whose waChatKey sort keys collide (pin +
		// archived + ts-hex + id, no separator) made KeyedDB throw
		// 'duplicate key', aborting fromJSON and losing the WHOLE
		// store on every boot. Isolate per entry, like the messages
		// stage below (HB-134): skip the colliding entry, keep the rest.
		for (const chat of entriesOf(json.chats)) {
			try {
				chats.upsert(chat)
			} catch (err) {
				logger.warn({ chatId: (chat as Chat).id, err }, 'aunu: skipped a chat entry whose sort key collided while loading the store')
			}
		}
		labelAssociations.upsert(...entriesOf(json.labelAssociations))
		contactsUpsert(valuesOf(json.contacts).filter((c: any) => !!c && typeof c === 'object' && typeof c.id === 'string'))
		labelsUpsert(valuesOf(json.labels).filter((l: any) => !!l && typeof l === 'object' && typeof l.id === 'string'))
		const messageSets = json.messages && typeof json.messages === 'object' ? json.messages : {}
		for (const jid in messageSets) {
			const entries = messageSets[jid]
			if (!Array.isArray(entries)) {
				continue
			}

			const list = assertMessageList(jid)
			for (const msg of entries) {
				try {
					list.upsert(proto.WebMessageInfo.fromObject(msg) as WAMessage, 'append')
				} catch (err) {
					logger.warn({ jid, err }, 'aunu: skipped an unreadable message entry while loading the store')
				}
			}
		}
	}

	return {
		chats,
		contacts,
		messages,
		groupMetadata,
		state,
		presences,
		labels,
		labelAssociations,
		bind,
		/** loads messages from the store, if not found -- uses the legacy connection */
		loadMessages: async (jid: string, count: number, cursor: WAMessageCursor) => {
			const list = assertMessageList(jid)
			const mode = !cursor || 'before' in cursor ? 'before' : 'after'
			const cursorKey = !!cursor ? ('before' in cursor ? cursor.before : cursor.after) : undefined
			const cursorValue = cursorKey ? list.get(cursorKey.id!) : undefined

			let messages: WAMessage[]
			// AunuBaileys (1.0.84, HB-177): a count of 0 means
			// "no messages" — the slicing below used
			// slice(-count), and slice(-0) is slice(0), so
			// loadMessages(jid, 0) returned the chat's ENTIRE
			// history (and negative counts mis-sliced as well).
			// Every other path in this function already resolves
			// to []. An absent count keeps the legacy behaviour.
			if (typeof count === 'number' && count <= 0) {
				return [] as WAMessage[]
			}

			if (list && mode === 'before' && (!cursorKey || cursorValue)) {
				if (cursorValue) {
					const msgIdx = list.array.findIndex(m => m.key.id === cursorKey?.id)
					messages = list.array.slice(0, msgIdx)
				} else {
					messages = list.array
				}

				const diff = count - messages.length
				if (diff < 0) {
					messages = messages.slice(-count) // get the last X messages
				}
			} else {
				messages = []
			}

			return messages
		},
		/**
		 * Get all available labels for profile
		 *
		 * Keep in mind that the list is formed from predefined tags and tags
		 * that were "caught" during their editing.
		 */
		getLabels: () => {
			return labels
		},
		/**
		 * Get labels for chat
		 *
		 * @returns Label IDs
		 **/
		getChatLabels: (chatId: string) => {
			return labelAssociations.filter((la: LabelAssociation) => la.chatId === chatId).all()
		},
		/**
		 * Get labels for message
		 *
		 * @returns Label IDs
		 **/
		getMessageLabels: (messageId: string) => {
			const associations = labelAssociations.filter((la: any) => la.messageId === messageId).all()
			return associations.map(({ labelId }: any) => labelId)
		},
		loadMessage: async (jid: string, id: string) => messages[jid]?.get(id),
		mostRecentMessage: async (jid: string) => {
			const message = messages[jid]?.array.slice(-1)[0]
			return message
		},
		fetchImageUrl: async (jid: string, sock: WASocket | undefined) => {
			const contact = contacts[jid]
			if (!contact) {
				return sock?.profilePictureUrl(jid)
			}

			// AunuBaileys (1.0.84, HB-245): a store file written
			// before this fix can still carry the 'changed' /
			// 'removed' sentinel as imgUrl — treat it as no
			// cached URL and fetch fresh; never hand a sentinel
			// back as an avatar URL. A real cached URL is still
			// returned as-is (and a fresh fetch re-caches it).
			if (typeof contact.imgUrl === 'undefined' || contact.imgUrl === 'changed' || contact.imgUrl === 'removed') {
				contact.imgUrl = await sock?.profilePictureUrl(jid)
			}

			return contact.imgUrl
		},
		fetchGroupMetadata: async (jid: string, sock: WASocket | undefined) => {
			if (!groupMetadata[jid]) {
				const metadata = await sock?.groupMetadata(jid)
				if (metadata) {
					groupMetadata[jid] = metadata
				}
			}

			return groupMetadata[jid]!
		},
		fetchMessageReceipts: async ({ remoteJid, id }: WAMessageKey) => {
			const list = remoteJid ? messages[remoteJid] : undefined
			const msg = list?.get(id!)
			return msg?.userReceipt
		},
		toJSON,
		fromJSON,
		writeToFile: (path: string) => {
			// AunuBaileys (1.0.84, HB-120 + addendum): every
			// other persistence writer in the lib is atomic and
			// 0600 (auth files HB-116, the lid store); this one
			// wrote the full chat/contact/message history
			// world-readable AND non-atomically — a crash
			// mid-write left a truncated file the next boot read
			// as corrupt and discarded wholesale. Write a
			// per-pid temp file, then rename it over the target.
			const tmpPath = `${path}.tmp-${process.pid}`
			writeFileSync(tmpPath, JSON.stringify(toJSON()), { mode: 0o600 })
			renameSync(tmpPath, path)
		},
		readFromFile: (path: string) => {
			if (existsSync(path)) {
				logger.debug({ path }, 'reading from file')
				const jsonStr = readFileSync(path, { encoding: 'utf-8' })
				let json: any
				try {
					json = JSON.parse(jsonStr)
				} catch (err) {
					// AunuBaileys: a corrupt store file must not crash
					// the boot — start empty and say so.
					logger.error({ path, err }, 'store file is corrupt; starting with an empty store')
					return
				}

				// AunuBaileys (1.0.70): valid JSON with the wrong shape
				// ({}, null, [], null fields) used to crash here — the
				// JSON.parse guard from 1.0.66 only covered syntax.
				// Validate the shape, then still guard fromJSON itself.
				if (!json || typeof json !== 'object' || !Array.isArray(json.chats)) {
					logger.error({ path }, 'store file has an unexpected shape (missing chats array); starting with an empty store')
					return
				}

				try {
					fromJSON(json)
				} catch (err) {
					logger.error({ path, err }, 'store file could not be applied; starting with an empty store')
					return
				}
			}
		}
	}
}

export default makeInMemoryStore

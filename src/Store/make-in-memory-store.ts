// AunuCore fork backport: in-memory store dari Baileys 6.6.0, dikonversi ke ESM untuk basis 6.7.x
// Ported to TypeScript for the AunuBaileys v7 tree (2.0.0); behaviour identical to the v6 module.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { waproto } from '../../WAProto/index.js'
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
	GroupParticipant,
	PresenceData,
	WAMessage,
	WAMessageCursor,
	WAMessageKey
} from '../Types/index.js'
import type { Label } from '../Types/Label.js'
import type { LabelAssociation } from '../Types/LabelAssociation.js'
import { LabelAssociationType } from '../Types/LabelAssociation.js'
import type { ILogger } from '../Utils/logger.js'
import { toNumber, trimUndefined, updateMessageWithReaction, updateMessageWithReceipt } from '../Utils/index.js'
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
	// AunuBaileys (2.4.0, HB-445 + HB-278 addendum 2): the parts used
	// to be concatenated with no separator, so two different
	// (chatId, messageId, labelId) triples could share one sort key —
	// and because this key doubles as the KeyedDB id, the second
	// association silently overwrote the first instead of throwing.
	// '\0' cannot appear in a JID, message id or label id, so the
	// boundaries are now unambiguous.
	key: (la: LabelAssociation) =>
		la.type === LabelAssociationType.Chat
			? la.chatId + '\0' + la.labelId
			: la.chatId + '\0' + (la as any).messageId + '\0' + la.labelId,
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
			if (!contact || typeof contact.id !== 'string' || !contact.id) {
				continue
			}

			oldContacts.delete(contact.id)
			// AunuBaileys (2.4.0, HB-411 addendum 2 + 4): producers emit
			// contacts with fields set to undefined (verifiedName from
			// a message without a verified-name child, phoneNumber /
			// name from a LID contact action, an absorbed pending
			// contacts.update) — Object.assign copied the undefined
			// over the stored value and erased it. undefined means
			// "not carried by this payload", never a deletion, so
			// strip it before merging (on a copy — do not mutate the
			// caller's contact).
			const cleanContact = { ...contact }
			trimUndefined(cleanContact)
			contacts[contact.id] = Object.assign(contacts[contact.id] || {}, cleanContact)
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

				// AunuBaileys (2.4.0, HB-373 addendum 2): the wipe only
				// cleared chats/messages/contacts — presences,
				// groupMetadata and label associations of the previous
				// account/session survived and kept being served for
				// chats that are not in the new sync. They are rebuilt
				// from live traffic / fetches, so wipe them too. Label
				// associations survive only for chats the new sync
				// carries; the label definitions themselves are
				// account-level and stay.
				for (const id in presences) {
					delete presences[id]
				}

				for (const id in groupMetadata) {
					delete groupMetadata[id]
				}

				const newChatIds = new Set(newChats.map(c => c.id))
				for (const association of labelAssociations
					.filter((la: LabelAssociation) => !newChatIds.has(la.chatId))
					.all()) {
					labelAssociations.delete(association)
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
					// AunuBaileys (2.4.0, HB-411 addendum 2): strip
					// undefined fields first — see contactsUpsert.
					Object.assign(contacts[update.id]!, trimUndefined({ ...update }))
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
				// AunuBaileys (2.2.0, HB-278 addendum): KeyedDB.upsert
				// deletes the existing entry BEFORE inserting — when
				// the insert then throws on a sort-key collision (with
				// a DIFFERENT chat whose key the new key prefixes),
				// the upserted chat itself was already gone and the
				// catch above only logged it. Snapshot first and
				// restore on failure, mirroring chats.update below
				// (KeyedDB's delete-before-insert order is deliberate
				// and stays — see keyed-db.ts).
				const snapshot = chats.get(chat.id)
				const snapshotCopy = snapshot ? { ...snapshot } : undefined
				try {
					// AunuBaileys (2.5.0, HB-411 addendum 6, second
					// layer): KeyedDB.upsert replaces the stored row
					// whole, so an upsert carrying an explicit
					// undefined field would store that undefined. The
					// buffer now trims merges (concatChats), but a
					// direct unbuffered upsert from any producer must
					// be normalised the same way the chats.update
					// handler below already does (2.4.0 HB-411) —
					// undefined means "not carried".
					chats.upsert(trimUndefined({ ...chat }) as Chat)
				} catch (err) {
					logger.warn({ chatId: chat.id, err }, 'aunu: skipped a chat upsert whose sort key collided')
					if (snapshotCopy && !chats.get(chat.id)) {
						try {
							chats.upsert(snapshotCopy)
						} catch (restoreErr) {
							logger.warn({ chatId: chat.id, err: restoreErr }, 'aunu: failed to restore the chat after a failed upsert')
						}
					}
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
						} else if (update.unreadCount === -1) {
							// AunuBaileys (2.3.0, HB-393 addendum): -1 is
							// the mark-unread SENTINEL (chat-utils: read
							// ? 0 : -1 — "unread, count unknown"), not a
							// count. Storing it literally poisoned the
							// next real message's +1 delta into
							// (-1) + 1 = 0 — a phantom read. Normalise
							// it to "count unknown" (field cleared, the
							// same end state the buffer's concatChats
							// clamping produces) so the next delta
							// counts from 0.
							update = { ...update }
							delete update.unreadCount
							chat.unreadCount = undefined
						}

						// AunuBaileys (2.4.0, HB-411): a stub without
						// parameters emits chats.update with name /
						// description set to undefined — assigning it
						// erased the known chat name. undefined means
						// "not carried", so strip it before merging.
						Object.assign(chat, trimUndefined({ ...update }))
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
			// AunuBaileys (2.3.0, HB-396): the cap gate used to count
			// the label being edited itself, so at 20 labels a RENAME
			// of an existing id — which adds nothing — was refused
			// exactly like a brand-new label. An existing id always
			// passes; the cap only gates genuinely new labels.
			if (labels.findById(label.id) || labels.count() < 20) {
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

				// AunuBaileys (2.3.0, HB-373): the chat row was the
				// only thing dropped — its messages, presences and
				// label associations stayed behind, so loadMessage /
				// mostRecentMessage / getChatLabels kept serving a
				// chat that no longer exists and the structures grew
				// with every deleted chat for the socket's lifetime.
				delete messages[item]
				delete presences[item]
				// AunuBaileys (2.4.0, HB-373 addendum): groupMetadata
				// was the one per-chat structure the 2.3.0 cleanup
				// missed — fetchGroupMetadata kept serving the
				// deleted group's cached metadata.
				delete groupMetadata[item]
				for (const association of labelAssociations.filter((la: LabelAssociation) => la.chatId === item).all()) {
					labelAssociations.delete(association)
				}
			}
		})

		ev.on('chats.lock', ({ id, locked }) => {
			// AunuBaileys (2.3.0, HB-397): processSyncAction emits
			// chats.lock for lockChatAction, but nothing consumed it
			// and the store never persisted the state — a chat locked
			// or unlocked on another device was invisible through
			// store.chats. Persist it on the chat (Chat.locked). The
			// field is not part of the chat sort key, so the update
			// cannot collide on re-insert.
			const result = chats.update(id, (chat: Chat) => {
				chat.locked = locked
			})
			if (!result) {
				logger.debug({ id, locked }, 'got lock update for non-existant chat')
			}
		})

		ev.on('messages.upsert', ({ messages: newMessages, type }) => {
			switch (type) {
				case 'append':
				case 'notify':
					for (const msg of newMessages) {
						const jid = jidNormalizedUser(msg.key.remoteJid!)
						const list = assertMessageList(jid)
						// AunuBaileys (2.5.0, HB-2026-1113-223 addendum 7):
						// a redelivered CIPHERTEXT stub (empty message)
						// must not replace a stored copy that still has
						// its content — the redelivery only proves the
						// ratchet no longer holds the key, not that the
						// content is gone. Skip the upsert; the notify
						// / unread handling below still runs (it already
						// excludes stubs). A stub still inserts when
						// nothing is stored, and content still replaces
						// a stub (see the controls in test/32).
						const existing = msg.key.id ? list.get(waMessageID(msg)) : undefined
						if (
							existing?.message &&
							!msg.message &&
							msg.messageStubType === waproto.WebMessageInfo.StubType.CIPHERTEXT
						) {
							logger?.warn(
								{ id: msg.key.id, remoteJid: jid },
								'skipping CIPHERTEXT stub upsert over a stored message with content (redelivery past the dedup window)'
							)
						} else {
							list.upsert(msg, 'append')
						}

						if (type === 'notify') {
							if (!chats.get(jid)) {
								// AunuBaileys (2.4.0, HB-431): the
								// hard-coded unreadCount: 1 also fired
								// for our OWN messages (sent from
								// another device) and for stubs —
								// processMessage's own rule
								// (shouldIncrementChatUnread) only
								// counts incoming non-stub messages.
								// The chat is still created, just
								// without the phantom unread.
								const countsAsUnread = !msg.key.fromMe && !msg.messageStubType
								ev.emit('chats.upsert', [
									{
										id: jid,
										conversationTimestamp: toNumber(msg.messageTimestamp),
										...(countsAsUnread ? { unreadCount: 1 } : {})
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

				// AunuBaileys (2.2.0, HB-370): a stored message's key
				// is its identity — never a legitimate update payload.
				// The REVOKE producer (process-message) attaches the
				// PROTOCOL message's own key as update.key; assigning
				// it re-keyed the dict entry, so the revoked message
				// vanished from loadMessage(targetId) and surfaced
				// under the protocol id. Strip key before assigning.
				const safeUpdate = { ...(update as Partial<WAMessage>) }
				delete safeUpdate.key
				const result = list.updateAssign(key.id!, safeUpdate)
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
					// AunuBaileys (2.4.0, HB-411 + addenda 3): stub
					// producers emit fields set to undefined (subject /
					// desc / inviteCode from a parameter-less stub,
					// author / authorPn / authorUsername from a
					// PN-only actor) — assigning them erased the stored
					// values. undefined means "not carried", so strip
					// it before merging.
					Object.assign(groupMetadata[id]!, trimUndefined({ ...update }))
				} else {
					logger.debug({ update }, 'got update for non-existant group metadata')
				}
			}
		})

		ev.on('group-participants.update', ({ id, participants, action, author }) => {
			const metadata = groupMetadata[id]
			if (metadata) {
				// AunuBaileys (2.4.0, HB-460 + HB-2026-1112-40 addendum 4
				// store facet): resolve every entry to an id first and
				// drop the ones that carry no identity at all (a forged
				// stub can emit '{}' / { id: null }). An id-less entry
				// used to be pushed as a phantom participant no
				// legitimate traffic could address or remove, and an
				// id-less 'remove' swept entries by undefined ===
				// undefined.
				const resolved: { raw: GroupParticipant | string; participantId: string }[] = []
				for (const participant of participants as (GroupParticipant | string)[]) {
					const participantId = typeof participant === 'string' ? participant : participant?.id
					if (typeof participantId === 'string' && participantId) {
						resolved.push({ raw: participant, participantId })
					}
				}

				// AunuBaileys (2.4.0, HB-406): producers (fetch +
				// notifications) populate `admin`
				// ('admin' | 'superadmin' | null) and never
				// isAdmin/isSuperAdmin, while this handler used to
				// write ONLY the legacy pair — a split-brain where
				// `admin` stayed stale until the next full fetch.
				// Keep both shapes in sync on every write.
				const syncAdminFlags = (participant: GroupParticipant) => {
					participant.isAdmin = participant.admin === 'admin' || participant.admin === 'superadmin'
					participant.isSuperAdmin = participant.admin === 'superadmin'
				}

				switch (action) {
					case 'add':
						// AunuBaileys (1.0.84, HB-237): skip ids
						// that are already listed. The metadata is
						// usually populated by a fetch that already
						// contains the member, and a redelivery
						// replays the notification — both used to
						// push a duplicate entry every single time,
						// without bound.
						for (const { raw, participantId } of resolved) {
							const existing = metadata.participants.find(p => p.id === participantId)
							if (existing) {
								// AunuBaileys (2.4.0, HB-406): a
								// redelivered add for a known member
								// still carries fresh fields — merge
								// the defined ones instead of dropping
								// the whole object.
								if (typeof raw !== 'string') {
									Object.assign(existing, trimUndefined({ ...raw }))
									if (typeof raw.admin !== 'undefined' || typeof raw.isAdmin !== 'undefined') {
										if (typeof raw.admin === 'undefined') {
											existing.admin = raw.isSuperAdmin ? 'superadmin' : raw.isAdmin ? 'admin' : null
										}

										syncAdminFlags(existing)
									}
								}
							} else if (typeof raw === 'string') {
								metadata.participants.push({ id: participantId, admin: null, isAdmin: false, isSuperAdmin: false })
							} else {
								// AunuBaileys (2.4.0, HB-406): keep the
								// producer's object (admin, phoneNumber,
								// lid, username) instead of reducing it
								// to { id, isAdmin, isSuperAdmin }.
								const entry: GroupParticipant = { ...trimUndefined({ ...raw }), id: participantId }
								if (typeof entry.admin === 'undefined') {
									entry.admin = entry.isSuperAdmin ? 'superadmin' : entry.isAdmin ? 'admin' : null
								}

								syncAdminFlags(entry)
								metadata.participants.push(entry)
							}
						}

						break
					case 'demote':
					case 'promote':
						for (const participant of metadata.participants) {
							if (resolved.some(({ participantId }) => participantId === participant.id)) {
								if (action === 'promote') {
									// promoting a superadmin must not
									// downgrade it to a plain admin
									if (participant.admin !== 'superadmin') {
										participant.admin = 'admin'
									}
								} else {
									// AunuBaileys (2.4.0, HB-406): a
									// demote clears admin entirely —
									// a demoted superadmin becomes
									// null, not 'admin'.
									participant.admin = null
								}

								syncAdminFlags(participant)
							}
						}

						break
					case 'remove':
						metadata.participants = metadata.participants.filter(
							p => !resolved.some(({ participantId }) => participantId === p.id)
						)
						// AunuBaileys (2.4.0, HB-373 addendum 3): the
						// removed member's presence entry stayed
						// behind forever — drop it with the member.
						if (presences[id]) {
							for (const { participantId } of resolved) {
								delete presences[id]![participantId]
							}
						}

						break
					case 'modify':
						// AunuBaileys (2.4.0, HB-406): 'modify' (number
						// change) was ignored entirely — the old number
						// stayed listed and the new one never appeared.
						// The producer sends the OLD ids as the
						// participants and the NEW id as the author.
						metadata.participants = metadata.participants.filter(
							p => !resolved.some(({ participantId }) => participantId === p.id)
						)
						if (typeof author === 'string' && author && !metadata.participants.some(p => p.id === author)) {
							metadata.participants.push({ id: author, admin: null, isAdmin: false, isSuperAdmin: false })
						}

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
					list.upsert(waproto.WebMessageInfo.fromObject(msg) as WAMessage, 'append')
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
			// AunuBaileys (2.1.0, HB-177 addendum): NaN/Infinity used to slip past the <= 0 check (NaN <= 0 is false) and return the whole history — a non-finite count means no messages.
			if (typeof count === 'number' && (!Number.isFinite(count) || count <= 0)) {
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
			// AunuBaileys (2.2.0, HB-365): fsync before the rename
			// and the directory after it — tmp+rename alone is
			// atomic but not durable across an OS crash. Best-
			// effort, like the other writers.
			try {
				const fd = openSync(tmpPath, 'r')
				try {
					fsyncSync(fd)
				} finally {
					closeSync(fd)
				}
			} catch {
				// best-effort durability
			}

			renameSync(tmpPath, path)

			try {
				const dirFd = openSync(path.slice(0, path.lastIndexOf('/') + 1) || '.', 'r')
				try {
					fsyncSync(dirFd)
				} finally {
					closeSync(dirFd)
				}
			} catch {
				// directory fsync unsupported on some platforms
			}
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

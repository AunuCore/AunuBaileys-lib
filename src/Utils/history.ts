import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { createInflate, inflate } from 'zlib'
import { waproto } from '../../WAProto/index.js'
import type { Chat, Contact, HistorySyncSink, LIDMapping, WAMessage } from '../Types'
import { WAMessageStubType } from '../Types'
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser } from '../WABinary'
import { toNumber } from './generics'
import type { ILogger } from './logger.js'
import { normalizeMessageContent } from './messages'
import { downloadContentFromMessage } from './messages-media'

const inflatePromise = promisify(inflate)

const extractPnFromMessages = (messages: waproto.IHistorySyncMsg[]): string | undefined => {
	for (const msgItem of messages) {
		const message = msgItem.message
		// Only extract from outgoing messages (fromMe: true) in 1:1 chats
		// because userReceipt.userJid is the recipient's JID
		if (!message?.key?.fromMe || !message.userReceipt?.length) {
			continue
		}

		const userJid = message.userReceipt[0]?.userJid
		if (userJid && (isPnUser(userJid) || isHostedPnUser(userJid))) {
			return userJid
		}
	}

	return undefined
}

export const downloadHistory = async (msg: waproto.Message.IHistorySyncNotification, options: RequestInit) => {
	const stream = await downloadContentFromMessage(msg, 'md-msg-hist', { options })
	// Pipe decrypted stream directly through zlib inflate
	// This avoids allocating an intermediate buffer for the compressed data
	const inflater = createInflate()
	const chunks: Buffer[] = []
	inflater.on('data', (chunk: Buffer) => chunks.push(chunk))
	await pipeline(stream, inflater)

	const buffer = Buffer.concat(chunks)
	const syncData = waproto.HistorySync.decode(buffer)
	return syncData
}

export const processHistoryMessage = (item: waproto.IHistorySync, logger?: ILogger) => {
	const messages: WAMessage[] = []
	const contacts: Contact[] = []
	const chats: Chat[] = []
	const lidPnMappings: LIDMapping[] = []

	logger?.trace({ progress: item.progress }, 'processing history of type ' + item.syncType?.toString())

	// Extract LID-PN mappings for all sync types
	for (const m of item.phoneNumberToLidMappings || []) {
		if (m.lidJid && m.pnJid) {
			lidPnMappings.push({ lid: m.lidJid, pn: m.pnJid })
		}
	}

	switch (item.syncType) {
		case waproto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
		case waproto.HistorySync.HistorySyncType.RECENT:
		case waproto.HistorySync.HistorySyncType.FULL:
		case waproto.HistorySync.HistorySyncType.ON_DEMAND:
			for (const chat of item.conversations! as Chat[]) {
				contacts.push({
					id: chat.id!,
					name: chat.displayName || chat.name || chat.username || undefined,
					username: chat.username || undefined,
					lid: chat.lidJid || chat.accountLid || undefined,
					phoneNumber: chat.pnJid || undefined
				})

				const chatId = chat.id!
				const isLid = isLidUser(chatId) || isHostedLidUser(chatId)
				const isPn = isPnUser(chatId) || isHostedPnUser(chatId)
				if (isLid && chat.pnJid) {
					lidPnMappings.push({ lid: chatId, pn: chat.pnJid })
				} else if (isPn && chat.lidJid) {
					lidPnMappings.push({ lid: chat.lidJid, pn: chatId })
				} else if (isLid && !chat.pnJid) {
					// Fallback: extract PN from userReceipt in messages when pnJid is missing
					const pnFromReceipt = extractPnFromMessages(chat.messages || [])
					if (pnFromReceipt) {
						lidPnMappings.push({ lid: chatId, pn: pnFromReceipt })
					}
				}

				const msgs = chat.messages || []
				delete chat.messages

				for (const item of msgs) {
					const message = item.message as WAMessage | undefined
					// AunuBaileys (1.0.86, HB-181, re-applied P3b): HistorySyncMsg.message
					// is an OPTIONAL proto field — a wrapper carrying only msgOrderId
					// decodes with message === null, and the bare derefs below (starting
					// at message.key) threw a TypeError that cost the WHOLE history chunk,
					// not just the empty entry. Skip the entry.
					if (!message) {
						continue
					}

					// AunuBaileys (2.5.0, HB-181 addendum): message present
					// but .key absent (null, or undefined — what
					// protobufjs decode yields for a missing singular
					// field) threw at message.key.fromMe below and lost
					// the whole chunk the same way. Skip the entry.
					if (!message.key) {
						continue
					}

					messages.push(message)

					if (!chat.messages?.length) {
						// keep only the most recent message in the chat array
						chat.messages = [{ message }]
					}

					if (!message.key.fromMe && !chat.lastMessageRecvTimestamp) {
						chat.lastMessageRecvTimestamp = toNumber(message.messageTimestamp)
					}

					if (
						(message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_BSP ||
							message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_FB) &&
						message.messageStubParameters?.[0]
					) {
						contacts.push({
							id: message.key.participant || message.key.remoteJid!,
							verifiedName: message.messageStubParameters?.[0]
						})
					}
				}

				chats.push(chat)
			}

			break
		case waproto.HistorySync.HistorySyncType.PUSH_NAME:
			for (const c of item.pushnames!) {
				contacts.push({ id: c.id!, notify: c.pushname! })
			}

			break
	}

	return {
		chats,
		contacts,
		messages,
		lidPnMappings,
		pastParticipants: item.pastParticipants,
		syncType: item.syncType,
		progress: item.progress
	}
}

/**
 * AunuBaileys (2.7.0, Zapo D4): deliver every element of a decoded
 * HistorySync to the host's streaming sink — one item per element,
 * in field order, each call awaited before the next is delivered
 * (backpressure: a slow sink slows the chunk, it never reorders or
 * drops items). A throwing sink is a host bug: log it and continue
 * with the next element, mirroring the tree's host-callback guards —
 * the chunk itself must not be lost over a sink failure.
 */
export const streamHistorySyncToSink = async (item: waproto.IHistorySync, sink: HistorySyncSink, logger?: ILogger) => {
	const fields = [
		'conversations',
		'statusV3Messages',
		'pushnames',
		'recentStickers',
		'pastParticipants',
		'callLogRecords',
		'phoneNumberToLidMappings',
		'accounts',
		'inlineContacts',
		'favoriteStickers'
	] as const

	for (const field of fields) {
		const elements = item[field]
		if (!elements?.length) {
			continue
		}

		for (const value of elements) {
			try {
				await sink({ field, value, syncType: item.syncType })
			} catch (err) {
				logger?.warn({ err, field }, 'history sync sink threw; continuing with the next element')
			}
		}
	}
}

export const downloadAndProcessHistorySyncNotification = async (
	msg: waproto.Message.IHistorySyncNotification,
	options: RequestInit,
	logger?: ILogger,
	sink?: HistorySyncSink
) => {
	let historyMsg: waproto.HistorySync
	if (msg.initialHistBootstrapInlinePayload) {
		historyMsg = waproto.HistorySync.decode(await inflatePromise(msg.initialHistBootstrapInlinePayload))
	} else {
		historyMsg = await downloadHistory(msg, options)
	}

	if (sink) {
		await streamHistorySyncToSink(historyMsg, sink, logger)
	}

	return processHistoryMessage(historyMsg, logger)
}

export const getHistoryMsg = (message: waproto.IMessage) => {
	const normalizedContent = !!message ? normalizeMessageContent(message) : undefined
	const anyHistoryMsg = normalizedContent?.protocolMessage?.historySyncNotification!

	return anyHistoryMsg
}

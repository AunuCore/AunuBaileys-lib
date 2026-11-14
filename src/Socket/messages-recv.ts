import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import Long from 'long'
import { proto } from '../../WAProto/index.js'
import {
	DEFAULT_CACHE_TTLS,
	KEY_BUNDLE_TYPE,
	MIN_PREKEY_COUNT,
	PLACEHOLDER_MAX_AGE_SECONDS,
	STATUS_EXPIRY_SECONDS
} from '../Defaults'
import type {
	BaileysEventMap,
	GroupParticipant,
	MessageReceiptType,
	MessageRelayOptions,
	MessageUserReceipt,
	NewChatMessageCapInfo,
	SocketConfig,
	WACallEvent,
	WAMessage,
	WAMessageKey,
	WAPatchName
} from '../Types'
import { ReachoutTimelockEnforcementType, WAMessageStatus, WAMessageStubType } from '../Types'
import {
	ACCOUNT_RESTRICTED_TEXT,
	aesDecryptCTR,
	aesEncryptGCM,
	cleanMessage,
	Curve,
	decodeMediaRetryNode,
	decodeMessageNode,
	decryptMessageNode,
	delay,
	derivePairingCodeKey,
	encodeBigEndian,
	encodeSignedDeviceIdentity,
	extractAddressingContext,
	extractE2ESessionFromRetryReceipt,
	getCallStatusFromNode,
	getHistoryMsg,
	getNextPreKeys,
	getStatusFromReceiptType,
	handleIdentityChange,
	hkdf,
	isBadMacError,
	keyMaterialToBuffer,
	isSenderKeyUnavailableError,
	isUnrecoverableSessionError,
	MISSING_KEYS_ERROR_TEXT,
	NACK_REASONS,
	NO_MESSAGE_FOUND_ERROR_TEXT,
	SERVER_ERROR_CODES,
	setBotMessageSecret,
	toNumber,
	unixTimestampSeconds,
	xmppPreKey,
	xmppSignedPreKey
} from '../Utils'
import { makeCacheStore } from '../Utils/internal-cache'
import { makeMutex } from '../Utils/make-mutex'
import { createOfflineNodeQueue } from '../Utils/offline-queue'
import { type MessageType } from '../Utils/offline-node-processor'
import { sentMessageCacheFor } from '../Utils/sent-message-cache'
import { buildAckStanza } from '../Utils/stanza-ack'
import {
	buildMergedTcTokenIndexWrite,
	isTcTokenExpired,
	readTcTokenIndex,
	resolveIssuanceJid,
	resolveTcTokenJid,
	storeTcTokensFromIqResult,
	TC_TOKEN_INDEX_KEY
} from '../Utils/tc-token-utils'
import {
	areJidsSameUser,
	type BinaryNode,
	binaryNodeToString,
	getAllBinaryNodeChildren,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	getBinaryNodeChildUInt,
	isJidGroup,
	isJidNewsletter,
	isJidStatusBroadcast,
	isLidUser,
	isPnUser,
	jidDecode,
	jidNormalizedUser,
	type JidWithDevice,
	S_WHATSAPP_NET
} from '../WABinary'
import { extractGroupMetadata } from './groups'
import { makeMessagesSocket } from './messages-send'

type MexGqlData = Record<string, unknown>

type MexGqlResponse = {
	data?: MexGqlData
	errors?: unknown[]
}

type ReachoutTimelockNotificationPayload = {
	is_active?: boolean
	enforcement_type?: string
	time_enforcement_ends?: string
}

const ENFORCEMENT_TYPE_VALUES = new Set<string>(Object.values(ReachoutTimelockEnforcementType))

function isValidEnforcementType(value: string | undefined): value is ReachoutTimelockEnforcementType {
	return typeof value === 'string' && ENFORCEMENT_TYPE_VALUES.has(value)
}

export const makeMessagesRecvSocket = (config: SocketConfig) => {
	const { logger, retryRequestDelayMs, maxMsgRetryCount, getMessage, shouldIgnoreJid, enableAutoSessionRecreation } =
		config
	const sock = makeMessagesSocket(config)
	const {
		userDevicesCache,
		devicesMutex,
		ev,
		authState,
		ws,
		messageMutex,
		notificationMutex,
		receiptMutex,
		signalRepository,
		query,
		upsertMessage,
		resyncAppState,
		onUnexpectedError,
		assertSessions,
		sendNode,
		relayMessage,
		sendReceipt,
		uploadPreKeys,
		sendPeerDataOperationMessage,
		messageRetryManager,
		registerSocketEndHandler,
		issuePrivacyTokens,
		fetchAccountReachoutTimelock,
		placeholderResendCache,
		aunuLid,
		aunuIgnoreFilter
	} = sock

	const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)

	/** this mutex ensures that each retryRequest will wait for the previous one to finish */
	const retryMutex = makeMutex()

	// AunuBaileys: consecutive decrypt-failure counts per signal address,
	// backing the 'messages.decrypt-failure' event payload AND the
	// Bad MAC self-heal that consumes it (wired in P3; cap as v6 1.0.70).
	const decryptFailCounts = new Map<string, number>()
	// AunuBaileys (v6 parity): consecutive failures before the Bad MAC self-heal resets the session
	const DECRYPT_FAIL_SESSION_RESET_LIMIT = 3

	// AunuBaileys (HB-199, closed in full by P9): these three defaults
	// used to be NodeCaches with a TTL but NO size cap — the last
	// unbounded caches in the tree. The internal cache caps them all
	// (LRU eviction at the cap; set() never throws).
	const msgRetryCache =
		config.msgRetryCounterCache ||
		makeCacheStore<number>({
			stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			maxEntries: 1000
		})
	const callOfferCache =
		config.callOfferCache ||
		makeCacheStore<WACallEvent>({
			stdTTL: DEFAULT_CACHE_TTLS.CALL_OFFER, // 5 mins
			maxEntries: 1000
		})

	// Debounce identity-change session refreshes per JID to avoid bursts
	const identityAssertDebounce = makeCacheStore<boolean>({ stdTTL: 5, maxEntries: 1000 })

	let sendActiveReceipts = false

	const fetchMessageHistory = async (
		count: number,
		oldestMsgKey: WAMessageKey,
		oldestMsgTimestamp: number | Long
	): Promise<string> => {
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		const pdoMessage: proto.Message.IPeerDataOperationRequestMessage = {
			historySyncOnDemandRequest: {
				chatJid: oldestMsgKey.remoteJid,
				oldestMsgFromMe: oldestMsgKey.fromMe,
				oldestMsgId: oldestMsgKey.id,
				oldestMsgTimestampMs: oldestMsgTimestamp,
				onDemandMsgCount: count
			},
			peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
		}

		return sendPeerDataOperationMessage(pdoMessage)
	}

	const requestPlaceholderResend = async (
		messageKey: WAMessageKey,
		msgData?: Partial<WAMessage>
	): Promise<string | undefined> => {
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		if (await placeholderResendCache.get(messageKey?.id!)) {
			logger.debug({ messageKey }, 'already requested resend')
			return
		} else {
			// Store original message data so PDO response handler can preserve
			// metadata (LID details, timestamps, etc.) that the phone may omit
			await placeholderResendCache.set(messageKey?.id!, msgData || true)
		}

		await delay(2000)

		if (!(await placeholderResendCache.get(messageKey?.id!))) {
			logger.debug({ messageKey }, 'message received while resend requested')
			return 'RESOLVED'
		}

		const pdoMessage = {
			placeholderMessageResendRequest: [
				{
					messageKey
				}
			],
			peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND
		}

		setTimeout(async () => {
			if (await placeholderResendCache.get(messageKey?.id!)) {
				logger.debug({ messageKey }, 'PDO message without response after 8 seconds. Phone possibly offline')
				await placeholderResendCache.del(messageKey?.id!)
			}
		}, 8_000)

		return sendPeerDataOperationMessage(pdoMessage)
	}

	const handleMexNotification = async (node: BinaryNode) => {
		const updateNode = getBinaryNodeChild(node, 'update')

		if (updateNode) {
			const opName = updateNode.attrs?.op_name
			if (!opName) {
				logger.warn({ node: binaryNodeToString(node) }, 'mex notification missing op_name, fallback to legacy')
				await handleLegacyMexNewsletterNotification(node)
				return
			}

			let mexResponse: MexGqlResponse
			try {
				mexResponse = JSON.parse(updateNode.content!.toString())
			} catch (error) {
				logger.error({ err: error, opName }, 'failed to parse mex notification JSON')
				return
			}

			if (mexResponse.errors?.length) {
				logger.warn({ errors: mexResponse.errors, opName }, 'mex notification has GQL errors')
				return
			}

			const data = mexResponse.data
			if (!data) {
				logger.warn({ opName }, 'mex notification has null data')
				return
			}

			logger.debug({ opName }, 'processing mex notification')

			switch (opName) {
				case 'NotificationUserReachoutTimelockUpdate':
					handleReachoutTimelockNotification(data)
					break

				case 'MessageCappingInfoNotification':
					handleMessageCappingNotification(data)
					break

				// newsletter ops still use the legacy <mex> child structure
				case 'NotificationNewsletterUpdate':
				case 'NotificationLinkedProfilesUpdates':
				case 'NotificationNewsletterAdminPromote':
				case 'NotificationNewsletterAdminDemote':
				case 'NotificationNewsletterUserSettingChange':
				case 'NotificationNewsletterJoin':
				case 'NotificationNewsletterLeave':
				case 'NotificationNewsletterStateChange':
				case 'NotificationNewsletterAdminMetadataUpdate':
				case 'NotificationNewsletterOwnerUpdate':
				case 'NotificationNewsletterAdminInviteRevoke':
				case 'NotificationNewsletterWamoSubStatusChange':
				case 'NotificationNewsletterBlockUser':
				case 'NotificationNewsletterPaidPartnership':
				case 'NotificationNewsletterMilestone':
				case 'NewsletterResponseStateUpdate':
					await handleLegacyMexNewsletterNotification(node)
					break

				default:
					logger.debug({ opName }, 'unhandled mex notification')
					break
			}

			return
		}

		await handleLegacyMexNewsletterNotification(node)
	}

	const handleReachoutTimelockNotification = (data: MexGqlData) => {
		const payload = data.xwa2_notify_account_reachout_timelock as ReachoutTimelockNotificationPayload | undefined

		if (!payload) {
			logger.warn('reachout timelock notification missing payload')
			return
		}

		if (!payload.is_active) {
			logger.info('reachout timelock restriction lifted')
			ev.emit('connection.update', {
				reachoutTimeLock: {
					isActive: false,
					enforcementType: ReachoutTimelockEnforcementType.DEFAULT
				}
			})
			return
		}

		// WA Web defaults to now+60s when the server omits the expiry
		const timeEnforcementEnds = payload.time_enforcement_ends
			? new Date(parseInt(payload.time_enforcement_ends, 10) * 1000)
			: new Date(Date.now() + 60_000)

		const enforcementType = isValidEnforcementType(payload.enforcement_type)
			? payload.enforcement_type
			: ReachoutTimelockEnforcementType.DEFAULT

		logger.info({ enforcementType, timeEnforcementEnds }, 'reachout timelock restriction set')

		ev.emit('connection.update', {
			reachoutTimeLock: {
				isActive: true,
				timeEnforcementEnds,
				enforcementType
			}
		})
	}

	const handleMessageCappingNotification = (data: MexGqlData) => {
		const payload = data.xwa2_notify_new_chat_messages_capping_info_update as NewChatMessageCapInfo | undefined

		if (!payload) {
			logger.warn('message capping notification missing payload')
			return
		}

		logger.info({ payload }, 'received message capping update')
		ev.emit('message-capping.update', payload)
	}

	const handleLegacyMexNewsletterNotification = async (node: BinaryNode) => {
		const mexNode = getBinaryNodeChild(node, 'mex')
		const updateNode = mexNode?.content ? null : getBinaryNodeChild(node, 'update') || getAllBinaryNodeChildren(node)[0]
		const payloadNode = mexNode?.content ? mexNode : updateNode
		if (!payloadNode?.content) {
			logger.warn({ node: binaryNodeToString(node) }, 'invalid mex newsletter notification')
			return
		}

		let data: any
		try {
			const payloadContent = payloadNode.content
			if (Array.isArray(payloadContent)) {
				logger.warn({ payloadNode }, 'invalid mex newsletter notification payload format')
				return
			}

			const contentBuf =
				typeof payloadContent === 'string' ? Buffer.from(payloadContent, 'binary') : Buffer.from(payloadContent)
			data = JSON.parse(contentBuf.toString())
		} catch (error) {
			logger.error({ err: error, node: binaryNodeToString(node) }, 'failed to parse mex newsletter notification')
			return
		}

		const operation = data?.operation ?? payloadNode?.attrs?.op_name
		let updates = data?.updates
		if (!updates) {
			const linkedProfiles = data?.data?.xwa2_notify_linked_profiles
			if (linkedProfiles) {
				updates = [linkedProfiles]
			}
		}

		// AunuBaileys (1.0.87, HB-121, re-applied P3b): a truthiness-only
		// check let a non-array `updates` (object/number/boolean) through,
		// and the for...of loops in every switch branch below threw a
		// TypeError — the whole notification was silently dropped (the
		// stanza is acked in the caller's finally either way, so nothing
		// ever retried it).
		if (!Array.isArray(updates) || !operation) {
			logger.warn({ data }, 'invalid mex newsletter notification content')
			return
		}

		logger.info({ operation, updates }, 'got mex newsletter notification')

		switch (operation) {
			case 'NotificationNewsletterUpdate':
				for (const update of updates) {
					if (update.jid && update.settings && Object.keys(update.settings).length > 0) {
						ev.emit('newsletter-settings.update', {
							id: update.jid,
							update: update.settings
						})
					}
				}

				break

			case 'NotificationNewsletterAdminPromote':
				for (const update of updates) {
					if (update.jid && update.user) {
						ev.emit('newsletter-participants.update', {
							id: update.jid,
							author: node.attrs.from!,
							user: update.user,
							new_role: 'ADMIN',
							action: 'promote'
						})
					}
				}

				break

			case 'NotificationLinkedProfilesUpdates':
				for (const update of updates) {
					const lid = update?.jid
					const addedProfiles = Array.isArray(update?.added_profiles) ? update.added_profiles : []
					const mappings = []
					for (const profile of addedProfiles) {
						const pn = typeof profile === 'string' ? profile : (profile?.pn ?? profile?.jid ?? null)
						if (lid && pn) {
							const mapping = { lid, pn }
							ev.emit('lid-mapping.update', mapping)
							mappings.push(mapping)
						}
					}

					await signalRepository.lidMapping.storeLIDPNMappings(mappings)
				}

				break

			default:
				logger.info({ operation, data }, 'unhandled mex newsletter notification')
				break
		}
	}

	// Handles newsletter notifications
	const handleNewsletterNotification = async (node: BinaryNode) => {
		const from = node.attrs.from!
		const children = getAllBinaryNodeChildren(node)
		const author = node.attrs.participant!

		for (const child of children) {
			logger.debug({ from, child }, 'got newsletter notification')

			switch (child.tag) {
				case 'reaction': {
					const reactionUpdate = {
						id: from,
						server_id: child.attrs.message_id!,
						reaction: {
							code: getBinaryNodeChildString(child, 'reaction'),
							count: 1
						}
					}
					ev.emit('newsletter.reaction', reactionUpdate)
					break
				}

				case 'view': {
					const viewUpdate = {
						id: from,
						server_id: child.attrs.message_id!,
						count: parseInt(child.content?.toString() || '0', 10)
					}
					ev.emit('newsletter.view', viewUpdate)
					break
				}

				case 'participant': {
					const participantUpdate = {
						id: from,
						author,
						user: child.attrs.jid!,
						action: child.attrs.action!,
						new_role: child.attrs.role!
					}
					ev.emit('newsletter-participants.update', participantUpdate)
					break
				}

				case 'update': {
					const settingsNode = getBinaryNodeChild(child, 'settings')
					if (settingsNode) {
						const update: Record<string, any> = {}
						const nameNode = getBinaryNodeChild(settingsNode, 'name')
						if (nameNode?.content) update.name = nameNode.content.toString()

						const descriptionNode = getBinaryNodeChild(settingsNode, 'description')
						if (descriptionNode?.content) update.description = descriptionNode.content.toString()

						ev.emit('newsletter-settings.update', {
							id: from,
							update
						})
					}

					break
				}

				case 'message': {
					const plaintextNode = getBinaryNodeChild(child, 'plaintext')
					if (plaintextNode?.content) {
						try {
							const contentBuf =
								typeof plaintextNode.content === 'string'
									? Buffer.from(plaintextNode.content, 'binary')
									: Buffer.from(plaintextNode.content as Uint8Array)
							const messageProto = proto.Message.decode(contentBuf).toJSON()
							const fullMessage = proto.WebMessageInfo.fromObject({
								key: {
									remoteJid: from,
									id: child.attrs.message_id || child.attrs.server_id,
									fromMe: false // TODO: is this really true though
								},
								message: messageProto,
								messageTimestamp: +child.attrs.t!
							}).toJSON() as WAMessage
							await upsertMessage(fullMessage, 'append')
							logger.debug('Processed plaintext newsletter message')
						} catch (error) {
							logger.error({ error }, 'Failed to decode plaintext newsletter message')
						}
					}

					break
				}

				default:
					logger.warn({ node, child }, 'Unknown newsletter notification child')
					break
			}
		}
	}

	/**
	 * Handles the <status> stanzas the server pushes for newsletter posts.
	 * Arrives on the CB:status channel.
	 *
	 * AunuBaileys (P2e port from v6 lib/Socket/messages-recv.js): this path
	 * did not exist in v7 at all — there was no CB:status registration and
	 * no 'newsletter.status' event, so bots listening for it silently lost
	 * every newsletter status update (and the stanza went un-acked).
	 */
	const handleNewsletterStatus = async (node: BinaryNode) => {
		const { id, from, server_id, t, is_sender, offline, type, edit } = node.attrs
		const serverId = server_id ? +server_id : undefined
		const timestamp = t ? +t : undefined
		const isSender = is_sender === 'true'
		const offlineIndex = offline !== undefined ? +offline : undefined
		// optional <meta> child: edit timestamps, interaction type, parent/response ids
		const metaNode = getBinaryNodeChild(node, 'meta')
		const meta = metaNode
			? {
					...(metaNode.attrs.msg_edit_t ? { editedAt: +metaNode.attrs.msg_edit_t } : {}),
					...(metaNode.attrs.original_msg_t ? { originalTimestamp: +metaNode.attrs.original_msg_t } : {}),
					...(metaNode.attrs.interaction_type ? { interactionType: metaNode.attrs.interaction_type } : {}),
					...(metaNode.attrs.parent_server_id ? { parentServerId: +metaNode.attrs.parent_server_id } : {}),
					...(metaNode.attrs.response_server_id ? { responseServerId: +metaNode.attrs.response_server_id } : {})
				}
			: undefined
		const viewsNode = getBinaryNodeChild(node, 'views_count')
		const viewsCount = viewsNode?.attrs?.count !== undefined ? +viewsNode.attrs.count : undefined
		const responsesNode = getBinaryNodeChild(node, 'responses_count')
		const responsesCount = responsesNode?.attrs?.count !== undefined ? +responsesNode.attrs.count : undefined
		const reactionsNode = getBinaryNodeChild(node, 'reactions')
		const reactionCounts = (reactionsNode ? getBinaryNodeChildren(reactionsNode, 'reaction') : []).map(r => ({
			code: r.attrs.code,
			count: +r.attrs.count!
		}))
		let content: BaileysEventMap['newsletter.status']['content'] = null
		let mediaType: string | undefined = undefined
		if (type === 'reaction') {
			content = { type: 'reaction', code: getBinaryNodeChild(node, 'reaction')?.attrs?.code }
		} else if (type === 'text' || type === 'media') {
			const plaintextNode = getBinaryNodeChild(node, 'plaintext')
			if (type === 'media') {
				mediaType = plaintextNode?.attrs?.mediatype
			}

			if (edit === '7' || edit === '8') {
				content = { type: 'revoke', edit }
			} else if (plaintextNode?.content) {
				try {
					const buf = Buffer.isBuffer(plaintextNode.content)
						? plaintextNode.content
						: Buffer.from(plaintextNode.content as Uint8Array)
					const message = proto.Message.decode(buf).toJSON()
					content = { type, message, ...(mediaType ? { mediaType } : {}) }
				} catch (err) {
					logger.error({ err }, 'Failed to decode newsletter status plaintext')
					content = { type, raw: true, ...(mediaType ? { mediaType } : {}) }
				}
			}
		}

		// AunuBaileys (1.0.71, HB-59): emit BEFORE acking — the ack used to go
		// first without a catch, so a socket that closed in that window
		// (sendNode throws Boom 'Connection Closed') swallowed the
		// status event entirely.
		// AunuBaileys (1.0.81, HB-192): the ack now sits in a
		// finally. The emit-first order is unchanged (HB-59), but
		// a throwing 'newsletter.status' listener can no longer
		// take the ack down with it — an un-acked <status> stanza
		// is redelivered (or the status lost) for the sake of a
		// host bug. The throw itself still propagates to the
		// CB:status registration's catch, as before.
		try {
			ev.emit('newsletter.status', {
				id: from!,
				messageId: id!,
				serverId,
				timestamp,
				isSender,
				...(offlineIndex !== undefined ? { offlineIndex } : {}),
				...(meta ? { meta } : {}),
				...(viewsCount !== undefined ? { viewsCount } : {}),
				...(responsesCount !== undefined ? { responsesCount } : {}),
				...(reactionCounts.length ? { reactionCounts } : {}),
				content
			})
		} finally {
			const ackType = type === 'reaction' ? 'reaction' : edit ? 'revoke' : type
			await sendNode({
				tag: 'ack',
				attrs: { id: id!, to: from!, class: 'status', type: ackType || 'text' },
				content: undefined
			}).catch(err => logger.warn({ err }, 'failed to ack newsletter status'))
		}
	}

	const sendMessageAck = async (node: BinaryNode, errorCode?: number) => {
		const stanza = buildAckStanza(node, errorCode, authState.creds.me!.id)
		logger.debug({ recv: { tag: node.tag, attrs: node.attrs }, sent: stanza.attrs }, 'sent ack')
		await sendNode(stanza)
	}

	const rejectCall = async (callId: string, callFrom: string) => {
		// AunuBaileys (1.0.79, HB-172, re-applied P3b): creds.me.id was
		// dereferenced bare in the stanza literal — a host rejecting a call
		// before pairing completes got a raw TypeError instead of the guarded
		// failure the neighbouring helpers give. (acceptCall/terminateCall,
		// the other two v6 sites, are Aunu-only helpers absent from v7.)
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				from: authState.creds.me!.id,
				to: callFrom
			},
			content: [
				{
					tag: 'reject',
					attrs: {
						'call-id': callId,
						'call-creator': callFrom,
						count: '0'
					},
					content: undefined
				}
			]
		}
		await query(stanza)
	}

	const sendRetryRequest = async (node: BinaryNode, forceIncludeKeys = false) => {
		// AunuBaileys (1.0.71, HB-6, re-applied P3b): an unguarded
		// me.id read here threw inside the retryMutex callback; the
		// throw was caught, but the retry receipt was silently lost.
		// Skip cleanly instead when pairing has not completed yet.
		if (!authState.creds.me?.id) {
			logger.warn({ node }, 'cannot send retry request before pairing completes; skipping')
			return
		}

		// AunuBaileys (1.0.79, HB-201 + addendum HB-80, re-applied
		// P3b for the HB-80 facet): the receipt built below always
		// embeds creds.registrationId, and from the second retry on
		// it also embeds the identity and signed-pre-key material —
		// all of it dereferenced bare inside the transaction
		// callback. With a partial creds restore those derefs threw
		// TypeError AFTER the retry counter had already been
		// consumed: the receipt was never sent, the counter was
		// burned, and every later retry failed at the same spot. (A
		// missing registrationId was worse — it silently encoded as
		// 00000000.) Validate BEFORE the increment and fail
		// descriptively: the counter is only spent on a receipt
		// that can actually be built. Key material follows the
		// HB-98 test (Buffer, or a base64 string in an edited file).
		const isKeyMaterial = (value: unknown): boolean => value instanceof Uint8Array || typeof value === 'string'
		if (!Number.isFinite(authState.creds.registrationId)) {
			throw new Error(
				'AunuBaileys: creds.registrationId is missing or invalid — cannot send a retry receipt; restore a full backup or pair again'
			)
		}

		if (
			!isKeyMaterial(authState.creds.signedIdentityKey?.public) ||
			!isKeyMaterial(authState.creds.signedPreKey?.keyPair?.public) ||
			!isKeyMaterial(authState.creds.signedPreKey?.signature) ||
			typeof authState.creds.signedPreKey?.keyId === 'undefined'
		) {
			throw new Error(
				'AunuBaileys: creds.signedIdentityKey / creds.signedPreKey are missing or incomplete — cannot include keys in the retry receipt; restore a full backup or pair again'
			)
		}

		const { fullMessage } = decodeMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '')
		const { key: msgKey } = fullMessage
		const msgId = msgKey.id!

		// AunuBaileys (HB-201 addendum, P4): the counter used to be
		// incremented AND stored here, BEFORE the keys.transaction
		// below that builds and sends the receipt — a transaction
		// failure (getNextPreKeys on corrupt counters, a failing
		// keys.set) burned the counter for a receipt that was never
		// built, and the message was never retried again even after
		// the host repaired its creds. HB-201's pre-increment
		// validation only covered the creds shape, not in-transaction
		// throws. So: PEEK the next count here (the limit checks keep
		// their exact semantics), build everything with the peeked
		// value, and COMMIT the increment only after the transaction
		// — receipt built and sent — succeeds (see the tail of this
		// function).
		const key = `${msgId}:${msgKey?.participant}`
		let retryCount: number
		if (messageRetryManager) {
			// Check if we've exceeded max retries using the new system
			if (messageRetryManager.hasExceededMaxRetries(msgId)) {
				logger.debug({ msgId }, 'reached retry limit with new retry manager, clearing')
				messageRetryManager.markRetryFailed(msgId)
				return
			}

			retryCount = messageRetryManager.getRetryCount(msgId) + 1
		} else {
			// Fallback to old system
			const currentCount = (await msgRetryCache.get<number>(key)) || 0
			if (currentCount >= maxMsgRetryCount) {
				logger.debug({ retryCount: currentCount, msgId }, 'reached retry limit, clearing')
				await msgRetryCache.del(key)
				return
			}

			retryCount = currentCount + 1
		}

		const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds
		const fromJid = node.attrs.from!

		// Check if we should recreate the session
		let shouldRecreateSession = false
		let recreateReason = ''

		if (enableAutoSessionRecreation && messageRetryManager && retryCount > 1) {
			try {
				// Check if we have a session with this JID
				const sessionId = signalRepository.jidToSignalProtocolAddress(fromJid)
				const hasSession = await signalRepository.validateSession(fromJid)
				const result = messageRetryManager.shouldRecreateSession(fromJid, hasSession.exists)
				shouldRecreateSession = result.recreate
				recreateReason = result.reason

				if (shouldRecreateSession) {
					logger.debug({ fromJid, retryCount, reason: recreateReason }, 'recreating session for retry')
					// Delete existing session to force recreation
					await authState.keys.set({ session: { [sessionId]: null } })
					forceIncludeKeys = true
				}
			} catch (error) {
				logger.warn({ error, fromJid }, 'failed to check session recreation')
			}
		}

		if (retryCount <= 2) {
			// Use new retry manager for phone requests if available
			if (messageRetryManager) {
				// Schedule phone request with delay (like whatsmeow)
				messageRetryManager.schedulePhoneRequest(msgId, async () => {
					try {
						const requestId = await requestPlaceholderResend(msgKey)
						logger.debug(
							`sendRetryRequest: requested placeholder resend (${requestId}) for message ${msgId} (scheduled)`
						)
					} catch (error) {
						logger.warn({ error, msgId }, 'failed to send scheduled phone request')
					}
				})
			} else {
				// Fallback to immediate request
				// AunuBaileys (1.0.88, HB-260, re-applied P3b): this await was the
				// only requestPlaceholderResend call site without a handler — a
				// transport failure inside it ('Not authenticated' / 'Connection
				// Closed' / a timeout) escaped sendRetryRequest BEFORE the retry
				// receipt below was built, so the receipt was lost with it. Log
				// the failure and continue to the receipt, like the other sites.
				try {
					const msgId = await requestPlaceholderResend(msgKey)
					logger.debug(`sendRetryRequest: requested placeholder resend for message ${msgId}`)
				} catch (err) {
					logger.warn({ err, msgId }, 'aunu: placeholder resend request failed in sendRetryRequest; continuing to the retry receipt')
				}
			}
		}

		const deviceIdentity = encodeSignedDeviceIdentity(account!, true)
		await authState.keys.transaction(async () => {
			const receipt: BinaryNode = {
				tag: 'receipt',
				attrs: {
					id: msgId,
					type: 'retry',
					to: node.attrs.from!
				},
				content: [
					{
						tag: 'retry',
						attrs: {
							count: retryCount.toString(),
							id: node.attrs.id!,
							t: node.attrs.t!,
							v: '1',
							// ADD ERROR FIELD
							error: '0'
						}
					},
					{
						tag: 'registration',
						attrs: {},
						content: encodeBigEndian(authState.creds.registrationId)
					}
				]
			}

			if (node.attrs.recipient) {
				receipt.attrs.recipient = node.attrs.recipient
			}

			if (node.attrs.participant) {
				receipt.attrs.participant = node.attrs.participant
			}

			if (retryCount > 1 || forceIncludeKeys || shouldRecreateSession) {
				const { update, preKeys } = await getNextPreKeys(authState, 1)

				let [keyId] = Object.keys(preKeys)
				let key = preKeys[+keyId!]

				if (!key) {
					// AunuBaileys (1.0.82, HB-154 + addendum, re-applied
					// P3b): the stored head pre-key is missing entirely
					// (store cleaned / partial restore) or was filtered
					// out as corrupt by getNextPreKeys — the map came
					// back empty and xmppPreKey below threw a TypeError
					// inside this transaction: the receipt was never
					// built, yet the retry counter was already spent.
					// Generate a fresh pair into the dead head slot
					// instead: `update` advances
					// firstUnuploadedPreKeyId past exactly this id, and
					// the write joins this transaction, so the private
					// half is persisted before the receipt carrying its
					// public half is sent.
					keyId = `${authState.creds.firstUnuploadedPreKeyId}`
					key = Curve.generateKeyPair()
					await authState.keys.set({ 'pre-key': { [keyId]: key } })
					logger.warn({ keyId }, 'aunu: no usable stored pre-key for the retry receipt; generated a fresh one into the head slot')
				}

				const content = receipt.content! as BinaryNode[]
				content.push({
					tag: 'keys',
					attrs: {},
					content: [
						{ tag: 'type', attrs: {}, content: Buffer.from(KEY_BUNDLE_TYPE) },
						{ tag: 'identity', attrs: {}, content: identityKey.public },
						xmppPreKey(key!, +keyId!),
						xmppSignedPreKey(signedPreKey),
						{ tag: 'device-identity', attrs: {}, content: deviceIdentity }
					]
				})

				// AunuBaileys (HB-259, re-applied P3): every bare
				// 'creds.update' emit is guarded \u2014 the event is not
				// bufferable, so a throwing host listener (e.g. saveCreds)
				// used to reject the surrounding stanza handler and lose
				// the work that followed the emit. Log and continue.
				try {
					ev.emit('creds.update', update)
				} catch (err) {
					logger.error({ err }, 'error in creds.update listener \u2014 continuing')
				}
			}

			await sendNode(receipt)

			logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt')
		}, authState?.creds?.me?.id || 'sendRetryRequest')

		// AunuBaileys (HB-201 addendum, P4): commit the retry counter
		// only now — the receipt was built and sent inside the
		// transaction above. A throw anywhere in there (or in the
		// session-recreation / device-identity steps before it)
		// leaves the counter untouched, so a later retry for the
		// same message is still possible.
		if (messageRetryManager) {
			messageRetryManager.incrementRetryCount(msgId)
		}

		await msgRetryCache.set(key, retryCount)
	}

	// Mirrors WAWeb/Handle/PreKeyLow.js: skip a re-issued notification with the same stanza id.
	const inFlightPreKeyLow = new Set<string>()

	/**
	 * Fire-and-forget tctoken re-issuance after a peer's device identity changed.
	 * Mirrors WAWebSendTcTokenWhenDeviceIdentityChange — runs in parallel with
	 * the session refresh (not after it).
	 */
	const reissueTcTokenAfterIdentityChange = (from: string): void => {
		void (async () => {
			const normalizedJid = jidNormalizedUser(from)
			const tcJid = await resolveTcTokenJid(normalizedJid, getLIDForPN)
			const tcTokenData = await authState.keys.get('tctoken', [tcJid])
			const senderTs = tcTokenData?.[tcJid]?.senderTimestamp

			if (senderTs === null || senderTs === undefined || isTcTokenExpired(senderTs)) {
				return
			}

			logger.debug({ jid: normalizedJid, senderTimestamp: senderTs }, 'identity changed, re-issuing tctoken')
			const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping)
			const issueJid = await resolveIssuanceJid(
				normalizedJid,
				sock.serverProps.lidTrustedTokenIssueToLid,
				getLIDForPN,
				getPNForLID
			)
			const result = await issuePrivacyTokens([issueJid], senderTs)
			await storeTcTokensFromIqResult({
				result,
				fallbackJid: tcJid,
				keys: authState.keys,
				getLIDForPN,
				onNewJidStored: trackTcTokenJid
			})
		})().catch(err => {
			logger.debug({ jid: from, err: err?.message }, 'failed to re-issue tctoken after identity change')
		})
	}

	const handleEncryptNotification = async (node: BinaryNode) => {
		const from = node.attrs.from
		if (from === S_WHATSAPP_NET) {
			const stanzaId = node.attrs.id
			if (stanzaId && inFlightPreKeyLow.has(stanzaId)) {
				return
			}

			const countChild = getBinaryNodeChild(node, 'count')
			const count = +countChild!.attrs.value!
			const shouldUploadMorePreKeys = count < MIN_PREKEY_COUNT

			logger.debug({ count, shouldUploadMorePreKeys }, 'recv pre-key count')
			if (shouldUploadMorePreKeys) {
				if (stanzaId) inFlightPreKeyLow.add(stanzaId)
				try {
					await uploadPreKeys()
				} finally {
					if (stanzaId) inFlightPreKeyLow.delete(stanzaId)
				}
			}
		} else {
			const result = await handleIdentityChange(node, {
				meId: authState.creds.me?.id,
				meLid: authState.creds.me?.lid,
				validateSession: signalRepository.validateSession,
				assertSessions,
				debounceCache: identityAssertDebounce,
				logger,
				onBeforeSessionRefresh: reissueTcTokenAfterIdentityChange
			})

			if (result.action === 'no_identity_node') {
				logger.info({ node }, 'unknown encrypt notification')
			}
		}
	}

	const handleGroupNotification = (fullNode: BinaryNode, child: BinaryNode, msg: Partial<WAMessage>) => {
		// TODO: Support PN/LID (Here is only LID now)

		const actingParticipantLid = fullNode.attrs.participant
		const actingParticipantPn = fullNode.attrs.participant_pn
		const actingParticipantUsername = fullNode.attrs.participant_username

		const affectedParticipantLid = getBinaryNodeChild(child, 'participant')?.attrs?.jid || actingParticipantLid!
		const affectedParticipantPn = getBinaryNodeChild(child, 'participant')?.attrs?.phone_number || actingParticipantPn!

		switch (child?.tag) {
			case 'create':
				const metadata = extractGroupMetadata(child)

				msg.messageStubType = WAMessageStubType.GROUP_CREATE
				msg.messageStubParameters = [metadata.subject]
				msg.key = { participant: metadata.owner, participantAlt: metadata.ownerPn }

				ev.emit('chats.upsert', [
					{
						id: metadata.id,
						name: metadata.subject,
						conversationTimestamp: metadata.creation
					}
				])
				ev.emit('groups.upsert', [
					{
						...metadata,
						author: actingParticipantLid,
						authorPn: actingParticipantPn,
						authorUsername: actingParticipantUsername
					}
				])
				break
			case 'ephemeral':
			case 'not_ephemeral':
				msg.message = {
					protocolMessage: {
						type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
						ephemeralExpiration: +(child.attrs.expiration || 0)
					}
				}
				break
			case 'modify':
				const oldNumber = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid!)
				msg.messageStubParameters = oldNumber || []
				msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER
				break
			case 'promote':
			case 'demote':
			case 'remove':
			case 'add':
			case 'leave':
				const stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`
				msg.messageStubType = WAMessageStubType[stubType as keyof typeof WAMessageStubType]

				const participants = getBinaryNodeChildren(child, 'participant').map(({ attrs }) => {
					// TODO: Store LID MAPPINGS
					return {
						id: attrs.jid!,
						phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
						lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
						username: attrs.participant_username || attrs.username || undefined,
						admin: (attrs.type || null) as GroupParticipant['admin']
					}
				})

				if (
					participants.length === 1 &&
					// if recv. "remove" message and sender removed themselves
					// mark as left
					(areJidsSameUser(participants[0]!.id, actingParticipantLid) ||
						areJidsSameUser(participants[0]!.id, actingParticipantPn)) &&
					child.tag === 'remove'
				) {
					msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_LEAVE
				}

				msg.messageStubParameters = participants.map(a => JSON.stringify(a))
				break
			case 'subject':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT
				msg.messageStubParameters = [child.attrs.subject!]
				break
			case 'description':
				const description = getBinaryNodeChild(child, 'body')?.content?.toString()
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_DESCRIPTION
				msg.messageStubParameters = description ? [description] : undefined
				break
			case 'announcement':
			case 'not_announcement':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE
				msg.messageStubParameters = [child.tag === 'announcement' ? 'on' : 'off']
				break
			case 'locked':
			case 'unlocked':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT
				msg.messageStubParameters = [child.tag === 'locked' ? 'on' : 'off']
				break
			case 'invite':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_INVITE_LINK
				msg.messageStubParameters = [child.attrs.code!]
				break
			case 'member_add_mode':
				const addMode = child.content
				if (addMode) {
					msg.messageStubType = WAMessageStubType.GROUP_MEMBER_ADD_MODE
					msg.messageStubParameters = [addMode.toString()]
				}

				break
			case 'membership_approval_mode':
				const approvalMode = getBinaryNodeChild(child, 'group_join')
				if (approvalMode) {
					msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE
					msg.messageStubParameters = [approvalMode.attrs.state!]
				}

				break
			case 'created_membership_requests':
				msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
				msg.messageStubParameters = [
					JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
					'created',
					child.attrs.request_method!
				]
				break
			case 'revoked_membership_requests':
				const isDenied = areJidsSameUser(affectedParticipantLid, actingParticipantLid)
				// TODO: LIDMAPPING SUPPORT
				msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
				msg.messageStubParameters = [
					JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
					isDenied ? 'revoked' : 'rejected'
				]
				break
		}
	}

	const handleDevicesNotification = async (node: BinaryNode) => {
		const [child] = getAllBinaryNodeChildren(node)
		const from = jidNormalizedUser(node.attrs.from)

		if (!child) {
			logger.debug({ from }, 'devices notification missing child, skipping')
			return
		}

		const tag = child.tag as 'add' | 'remove' | 'update'
		const deviceHash = child.attrs.device_hash
		const devices = getBinaryNodeChildren(child, 'device')

		if (areJidsSameUser(from, authState.creds.me!.id) || areJidsSameUser(from, authState.creds.me!.lid)) {
			const deviceJids = devices.map(d => d.attrs.jid)
			logger.info({ deviceJids }, 'got my own devices')
		}

		if (!devices.length) {
			logger.debug({ from, tag }, 'no devices in notification, skipping')
			return
		}

		type DecodedDevice = { jid: string; user: string; server: string; device?: number }
		const decoded: DecodedDevice[] = []
		for (const d of devices) {
			const jid = d.attrs.jid
			if (!jid) continue
			const parts = jidDecode(jid)
			if (!parts) {
				logger.debug({ jid }, 'failed to decode device jid, skipping')
				continue
			}

			decoded.push({ jid, user: parts.user, server: parts.server, device: parts.device })
		}

		if (!decoded.length) return

		await devicesMutex.mutex(async () => {
			const byUser = new Map<string, DecodedDevice[]>()
			for (const d of decoded) {
				const list = byUser.get(d.user) || []
				list.push(d)
				byUser.set(d.user, list)
			}

			for (const [user, entries] of byUser) {
				if (tag === 'update') {
					logger.debug({ user }, `${user}'s device list updated, dropping cached devices`)
					await userDevicesCache?.del(user)
					continue
				}

				if (tag === 'remove') {
					await signalRepository.deleteSession(entries.map(e => e.jid))
				}

				const existingCache: JidWithDevice[] = (await userDevicesCache?.get<JidWithDevice[]>(user)) || []
				if (!existingCache.length) {
					// No baseline yet; skip applying the delta so getUSyncDevices can
					// later fetch the full device list. Caching just the notification
					// entries would make a partial list look authoritative.
					logger.debug({ user, tag }, 'device list not cached, deferring to USync refresh')
					continue
				}

				const affected = new Set(entries.map(e => e.device))
				let updatedDevices: JidWithDevice[]
				switch (tag) {
					case 'add':
						logger.info({ deviceHash, count: entries.length }, 'devices added')
						updatedDevices = [
							...existingCache.filter(d => !affected.has(d.device)),
							...entries.map(e => ({ user: e.user, server: e.server, device: e.device }))
						]
						break
					case 'remove':
						logger.info({ deviceHash, count: entries.length }, 'devices removed')
						updatedDevices = existingCache.filter(d => !affected.has(d.device))
						break
					default:
						logger.debug({ tag }, 'Unknown device list change tag')
						continue
				}

				if (updatedDevices.length === 0) {
					await userDevicesCache?.del(user)
				} else {
					await userDevicesCache?.set(user, updatedDevices)
				}
			}
		})
	}

	const processNotification = async (node: BinaryNode) => {
		const result: Partial<WAMessage> = {}
		const [child] = getAllBinaryNodeChildren(node)
		const nodeType = node.attrs.type
		const from = jidNormalizedUser(node.attrs.from)

		switch (nodeType) {
			case 'newsletter':
				await handleNewsletterNotification(node)
				break
			case 'mex':
				await handleMexNotification(node)
				break
			case 'w:gp2':
				// TODO: HANDLE PARTICIPANT_PN
				handleGroupNotification(node, child!, result)
				break
			case 'mediaretry':
				const event = decodeMediaRetryNode(node)
				ev.emit('messages.media-update', [event])
				break
			case 'encrypt':
				await handleEncryptNotification(node)
				break
			case 'devices':
				try {
					await handleDevicesNotification(node)
				} catch (error) {
					logger.error({ error, node }, 'failed to handle devices notification')
				}

				break
			case 'server_sync':
				const update = getBinaryNodeChild(node, 'collection')
				if (update) {
					const name = update.attrs.name as WAPatchName
					await resyncAppState([name], false)
				}

				break
			case 'picture':
				const setPicture = getBinaryNodeChild(node, 'set')
				const delPicture = getBinaryNodeChild(node, 'delete')

				// TODO: WAJIDHASH stuff proper support inhouse
				ev.emit('contacts.update', [
					{
						id: jidNormalizedUser(node?.attrs?.from) || (setPicture || delPicture)?.attrs?.hash || '',
						imgUrl: setPicture ? 'changed' : 'removed'
					}
				])

				if (isJidGroup(from)) {
					const node = setPicture || delPicture
					result.messageStubType = WAMessageStubType.GROUP_CHANGE_ICON

					if (setPicture) {
						result.messageStubParameters = [setPicture.attrs.id!]
					}

					result.participant = node?.attrs.author
					result.key = {
						...(result.key || {}),
						participant: setPicture?.attrs.author
					}
				}

				break
			case 'account_sync':
				if (child!.tag === 'disappearing_mode') {
					const newDuration = +child!.attrs.duration!
					const timestamp = +child!.attrs.t!

					logger.info({ newDuration }, 'updated account disappearing mode')

					try {
						ev.emit('creds.update', {
							accountSettings: {
								...authState.creds.accountSettings,
								defaultDisappearingMode: {
									ephemeralExpiration: newDuration,
									ephemeralSettingTimestamp: timestamp
								}
							}
						})
					} catch (err) {
						logger.error({ err }, 'error in creds.update listener \u2014 continuing')
					}
				} else if (child!.tag === 'blocklist') {
					const blocklists = getBinaryNodeChildren(child, 'item')

					for (const { attrs } of blocklists) {
						const blocklist = [attrs.jid!]
						const type = attrs.action === 'block' ? 'add' : 'remove'
						ev.emit('blocklist.update', { blocklist, type })
					}
				}

				break
			case 'link_code_companion_reg':
				const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg')
				const ref = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'))
				const primaryIdentityPublicKey = toRequiredBuffer(
					getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub')
				)
				const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(
					getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub')
				)
				// AunuBaileys (1.0.76, HB-118, re-applied P3): validate
				// the wire shape BEFORE any crypto. toRequiredBuffer only
				// checks presence: a 31-byte identity pub used to pass
				// Curve.sharedKey and silently derive a garbage
				// advSecretKey that was then stored. Wrapped ephemeral
				// material under 80 bytes, or an identity pub that is
				// neither raw (32) nor prefixed (33), is malformed.
				if (
					primaryEphemeralPublicKeyWrapped.length < 80 ||
					(primaryIdentityPublicKey.length !== 32 && primaryIdentityPublicKey.length !== 33)
				) {
					throw new Boom('link_code_companion_reg: malformed key material lengths', { statusCode: 400 })
				}

				const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped)
				const companionSharedKey = Curve.sharedKey(
					authState.creds.pairingEphemeralKeyPair.private,
					codePairingPublicKey
				)
				const random = randomBytes(32)
				const linkCodeSalt = randomBytes(32)
				const linkCodePairingExpanded = hkdf(companionSharedKey, 32, {
					salt: linkCodeSalt,
					info: 'link_code_pairing_key_bundle_encryption_key'
				})
				const encryptPayload = Buffer.concat([
					// AunuBaileys (1.0.78, HB-157, re-applied P3b): string
					// key material is base64 — Buffer.from(string) would
					// embed the base64 TEXT as UTF-8 bytes.
					keyMaterialToBuffer(authState.creds.signedIdentityKey.public) as Buffer,
					primaryIdentityPublicKey,
					random
				])
				const encryptIv = randomBytes(12)
				const encrypted = aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, Buffer.alloc(0))
				const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted])
				const identitySharedKey = Curve.sharedKey(authState.creds.signedIdentityKey.private, primaryIdentityPublicKey)
				const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random])
				authState.creds.advSecretKey = Buffer.from(hkdf(identityPayload, 32, { info: 'adv_secret' })).toString('base64')
				await query({
					tag: 'iq',
					attrs: {
						to: S_WHATSAPP_NET,
						type: 'set',
						id: sock.generateMessageTag(),
						xmlns: 'md'
					},
					content: [
						{
							tag: 'link_code_companion_reg',
							attrs: {
								jid: authState.creds.me!.id,
								stage: 'companion_finish'
							},
							content: [
								{
									tag: 'link_code_pairing_wrapped_key_bundle',
									attrs: {},
									content: encryptedPayload
								},
								{
									tag: 'companion_identity_public',
									attrs: {},
									// AunuBaileys (HB-157, re-applied P3b): the
									// node writer must publish the key BYTES,
									// not the base64 text of a string-stored key.
									content: keyMaterialToBuffer(authState.creds.signedIdentityKey.public) as Buffer
								},
								{
									tag: 'link_code_pairing_ref',
									attrs: {},
									content: ref
								}
							]
						}
					]
				})
				authState.creds.registered = true
				try {
					ev.emit('creds.update', authState.creds)
				} catch (err) {
					logger.error({ err }, 'error in creds.update listener \u2014 continuing')
				}
				break
			case 'privacy_token':
				await handlePrivacyTokenNotification(node)
				break
		}

		if (Object.keys(result).length) {
			return result
		}
	}

	/**
	 * In-memory cache of storage JIDs with stored tctokens, seeded from the persisted index.
	 * Used to coalesce writes during a session; pruning always re-reads the persisted index
	 * to cover writes made by other layers (e.g. history sync).
	 */
	const tcTokenKnownJids = new Set<string>()

	const tcTokenIndexLoaded = (async () => {
		try {
			const jids = await readTcTokenIndex(authState.keys)
			for (const jid of jids) tcTokenKnownJids.add(jid)
			logger.debug({ count: tcTokenKnownJids.size }, 'loaded tctoken index')
		} catch (err: any) {
			logger.warn({ err: err?.message }, 'failed to load tctoken index')
		}
	})()

	let tcTokenIndexTimer: ReturnType<typeof setTimeout> | undefined

	async function flushTcTokenIndex() {
		if (tcTokenIndexTimer) {
			clearTimeout(tcTokenIndexTimer)
			tcTokenIndexTimer = undefined
		}

		// Merge with whatever is already persisted so we don't clobber writes from other
		// paths (history sync, concurrent sessions on the same store).
		const write = await buildMergedTcTokenIndexWrite(authState.keys, tcTokenKnownJids)
		return authState.keys.set({ tctoken: write })
	}

	function scheduleTcTokenIndexSave() {
		if (tcTokenIndexTimer) {
			clearTimeout(tcTokenIndexTimer)
		}

		tcTokenIndexTimer = setTimeout(() => {
			tcTokenIndexTimer = undefined
			flushTcTokenIndex().catch(err => {
				logger.warn({ err: err?.message }, 'failed to save tctoken index')
			})
		}, 5000)
	}

	function trackTcTokenJid(jid: string) {
		if (jid && jid !== TC_TOKEN_INDEX_KEY && !tcTokenKnownJids.has(jid)) {
			tcTokenKnownJids.add(jid)
			scheduleTcTokenIndexSave()
		}
	}

	const handlePrivacyTokenNotification = async (node: BinaryNode) => {
		const tokensNode = getBinaryNodeChild(node, 'tokens')
		if (!tokensNode) return

		const from = jidNormalizedUser(node.attrs.from)

		// WA Web uses: senderLid ?? toLid(from) for the storage key
		// The sender_lid attribute provides the LID directly when available
		const senderLid =
			node.attrs.sender_lid && isLidUser(jidNormalizedUser(node.attrs.sender_lid))
				? jidNormalizedUser(node.attrs.sender_lid)
				: undefined
		const fallbackJid = senderLid ?? (await resolveTcTokenJid(from, getLIDForPN))

		logger.debug({ from, storageJid: fallbackJid }, 'processing privacy token notification')

		await storeTcTokensFromIqResult({
			result: node,
			fallbackJid,
			keys: authState.keys,
			getLIDForPN,
			onNewJidStored: trackTcTokenJid
		})
	}

	async function decipherLinkPublicKey(data: Uint8Array | Buffer) {
		const buffer = toRequiredBuffer(data)
		const salt = buffer.slice(0, 32)
		const secretKey = await derivePairingCodeKey(authState.creds.pairingCode!, salt)
		const iv = buffer.slice(32, 48)
		const payload = buffer.slice(48, 80)
		return aesDecryptCTR(payload, secretKey, iv)
	}

	function toRequiredBuffer(data: Uint8Array | Buffer | undefined) {
		if (data === undefined) {
			throw new Boom('Invalid buffer', { statusCode: 400 })
		}

		return data instanceof Buffer ? data : Buffer.from(data)
	}

	const willSendMessageAgain = async (id: string, participant: string) => {
		const key = `${id}:${participant}`
		const retryCount = (await msgRetryCache.get<number>(key)) || 0
		return retryCount < maxMsgRetryCount
	}

	const updateSendMessageAgainCount = async (id: string, participant: string) => {
		const key = `${id}:${participant}`
		const newValue = ((await msgRetryCache.get<number>(key)) || 0) + 1
		await msgRetryCache.set(key, newValue)
	}

	const sendMessagesAgain = async (
		key: WAMessageKey,
		ids: string[],
		retryNode: BinaryNode,
		receiptNode: BinaryNode
	) => {
		const remoteJid = key.remoteJid!
		const participant = key.participant || remoteJid

		const retryCount = +retryNode.attrs.count! || 1
		const msgId = ids[0]

		// Try to get messages from cache first, then fallback to getMessage
		const msgs: (proto.IMessage | undefined)[] = []
		for (const id of ids) {
			let msg: proto.IMessage | undefined

			// Try to get from retry cache first if enabled
			if (messageRetryManager) {
				const cachedMsg = messageRetryManager.getRecentMessage(remoteJid, id)
				if (cachedMsg) {
					msg = cachedMsg.message
					logger.debug({ jid: remoteJid, id }, 'found message in retry cache')

					// Mark retry as successful since we found the message
					messageRetryManager.markRetrySuccess(id)
				}
			}

			// Fallback to getMessage if not found in cache
			if (!msg) {
				// AunuBaileys (1.0.82, HB-107, re-applied P3): per-id
				// isolation at the FETCH stage. getMessage is host code
				// (a DB/file store can throw); one throwing id used to
				// reject the whole batch, so NO id was resent this round
				// and no retry counter advanced. Treat a throwing id as
				// unavailable and continue with the rest.
				try {
					msg =
						(await getMessage({ ...key, id })) ??
						(sentMessageCacheFor(config, jid => aunuLid?.getAltJid(jid)).get(remoteJid, id) as proto.IMessage | undefined)
				} catch (err) {
					logger.warn({ err, jid: remoteJid, id }, 'aunu: getMessage failed for one id in a retry batch; treating it as unavailable and continuing with the rest')
					msg = undefined
				}
				if (msg) {
					logger.debug({ jid: remoteJid, id }, 'found message via getMessage')
					// Also mark as successful if found via getMessage
					if (messageRetryManager) {
						messageRetryManager.markRetrySuccess(id)
					}
				}
			}

			msgs.push(msg)
		}

		// if it's the primary jid sending the request
		// just re-send the message to everyone
		// prevents the first message decryption failure
		const sendToAll = !jidDecode(participant)?.device

		const sessionId = signalRepository.jidToSignalProtocolAddress(participant)
		let injectedFromBundle = false

		const bundle = extractE2ESessionFromRetryReceipt(receiptNode)
		if (bundle) {
			try {
				await signalRepository.injectE2ESession({ jid: participant, session: bundle })
				injectedFromBundle = true
				logger.debug({ participant, retryCount }, 'injected session from retry receipt key bundle')
			} catch (error) {
				logger.warn({ error, participant }, 'failed to inject session from retry receipt')
			}
		}

		if (!injectedFromBundle) {
			const receivedRegId = getBinaryNodeChildUInt(receiptNode, 'registration', 4)
			if (typeof receivedRegId === 'number' && Number.isInteger(receivedRegId)) {
				const info = await signalRepository.getSessionInfo(participant)
				if (info && info.registrationId !== 0 && info.registrationId !== receivedRegId) {
					logger.info(
						{ participant, stored: info.registrationId, received: receivedRegId },
						'reg id mismatch on retry without bundle, deleting session'
					)
					await authState.keys.set({ session: { [sessionId]: null } })
				}
			}
		}

		const BASE_KEY_CHECK_RETRY = 2
		if (msgId && messageRetryManager) {
			const info = await signalRepository.getSessionInfo(participant)
			if (info) {
				if (retryCount === BASE_KEY_CHECK_RETRY) {
					messageRetryManager.saveBaseKey(sessionId, msgId, info.baseKey)
				} else if (retryCount > BASE_KEY_CHECK_RETRY) {
					if (messageRetryManager.hasSameBaseKey(sessionId, msgId, info.baseKey)) {
						logger.warn({ participant, retryCount }, 'base key collision on retry, forcing fresh session')
						await authState.keys.set({ session: { [sessionId]: null } })
					}

					messageRetryManager.deleteBaseKey(sessionId, msgId)
				}
			}
		}

		let shouldRecreateSession = false
		let recreateReason = ''

		if (enableAutoSessionRecreation && messageRetryManager && retryCount > 1 && !injectedFromBundle) {
			try {
				const hasSession = await signalRepository.validateSession(participant)
				const result = messageRetryManager.shouldRecreateSession(participant, hasSession.exists)
				shouldRecreateSession = result.recreate
				recreateReason = result.reason

				if (shouldRecreateSession) {
					logger.debug({ participant, retryCount, reason: recreateReason }, 'recreating session for outgoing retry')
					await authState.keys.set({ session: { [sessionId]: null } })
				}
			} catch (error) {
				logger.warn({ error, participant }, 'failed to check session recreation for outgoing retry')
			}
		}

		if (!injectedFromBundle) {
			await assertSessions([participant], true)
		}

		if (isJidGroup(remoteJid)) {
			await authState.keys.set({ 'sender-key-memory': { [remoteJid]: null } })
		}

		logger.debug(
			{ participant, sendToAll, shouldRecreateSession, recreateReason, injectedFromBundle },
			'prepared session for retry resend'
		)

		for (const [i, msg] of msgs.entries()) {
			if (!ids[i]) continue

			if (msg && (await willSendMessageAgain(ids[i], participant))) {
				await updateSendMessageAgainCount(ids[i], participant)
				const msgRelayOpts: MessageRelayOptions = { messageId: ids[i] }

				if (sendToAll) {
					msgRelayOpts.useUserDevicesCache = false
				} else {
					msgRelayOpts.participant = {
						jid: participant,
						count: +retryNode.attrs.count!
					}
				}

				// AunuBaileys (1.0.72, HB-61, re-applied P3b): one
				// id's resend failure used to abort the whole batch
				// — the remaining ids in the same retry receipt
				// were never resent this round. Log and continue
				// with the rest. (The FETCH stage above got the
				// same isolation in P3 as HB-107.)
				try {
					await relayMessage(key.remoteJid!, msg, msgRelayOpts)
				} catch (err) {
					logger.warn(
						{ err, jid: key.remoteJid, id: ids[i] },
						'resending one message failed; continuing with the rest of the batch'
					)
				}
			} else {
				logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available')
			}
		}
	}

	const handleReceipt = async (node: BinaryNode) => {
		const { attrs, content } = node
		const isLid = attrs.from!.includes('lid')
		const isNodeFromMe = areJidsSameUser(
			attrs.participant || attrs.from,
			isLid ? authState.creds.me?.lid : authState.creds.me?.id
		)
		const remoteJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient
		const fromMe = !attrs.recipient || ((attrs.type === 'retry' || attrs.type === 'sender') && isNodeFromMe)

		const key: proto.IMessageKey = {
			remoteJid,
			id: '',
			fromMe,
			participant: attrs.participant
		}

		const ids = [attrs.id!]
		if (Array.isArray(content)) {
			const items = getBinaryNodeChildren(content[0], 'item')
			ids.push(...items.map(i => i.attrs.id!))
		}

		try {
			await Promise.all([
				receiptMutex.mutex(async () => {
					const status = getStatusFromReceiptType(attrs.type)
					if (
						typeof status !== 'undefined' &&
						// basically, we only want to know when a message from us has been delivered to/read by the other person
						// or another device of ours has read some messages
						(status >= proto.WebMessageInfo.Status.SERVER_ACK || !isNodeFromMe)
					) {
						if (isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid!)) {
							if (attrs.participant) {
								const updateKey: keyof MessageUserReceipt =
									status === proto.WebMessageInfo.Status.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp'
								ev.emit(
									'message-receipt.update',
									ids.map(id => ({
										key: { ...key, id },
										receipt: {
											userJid: jidNormalizedUser(attrs.participant),
											[updateKey]: +attrs.t!
										}
									}))
								)
							}
						} else {
							ev.emit(
								'messages.update',
								ids.map(id => ({
									key: { ...key, id },
									update: { status, messageTimestamp: toNumber(+(attrs.t ?? 0)) }
								}))
							)
						}
					}

					if (attrs.type === 'retry') {
						// correctly set who is asking for the retry
						key.participant = key.participant || attrs.from
						const retryNode = getBinaryNodeChild(node, 'retry')
						// AunuBaileys (1.0.82, HB-160, re-applied P3b): the
						// gate used to check ids[0] ALONE — a capped first
						// id starved the fresh ids behind it, and a fresh
						// first id let capped ids behind it be resent past
						// the cap without limit. Filter per id; the resend
						// below only ever sees ids that still have budget.
						const eligibleIds = key.participant
							? (
									await Promise.all(
										ids.map(async id =>
											id && (await willSendMessageAgain(id, key.participant!)) ? id : undefined
										)
									)
								).filter((id): id is string => !!id)
							: []
						if (eligibleIds.length && key.participant) {
							if (key.fromMe) {
								try {
									await updateSendMessageAgainCount(eligibleIds[0]!, key.participant)
									logger.debug({ attrs, key }, 'recv retry request')
									await sendMessagesAgain(key, eligibleIds, retryNode!, node)
								} catch (error: unknown) {
									logger.error(
										{ key, ids, trace: error instanceof Error ? error.stack : 'Unknown error' },
										'error in sending message again'
									)
								}
							} else {
								logger.info({ attrs, key }, 'recv retry for not fromMe message')
							}
						} else {
							logger.info({ attrs, key }, 'will not send message again, as sent too many times')
						}
					}
				})
			])
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack receipt'))
		}
	}

	const handleNotification = async (node: BinaryNode) => {
		const remoteJid = node.attrs.from

		try {
			await Promise.all([
				notificationMutex.mutex(async () => {
					const msg = await processNotification(node)
					if (msg) {
						const fromMe = areJidsSameUser(node.attrs.participant || remoteJid, authState.creds.me!.id)
						const { senderAlt: participantAlt, addressingMode } = extractAddressingContext(node)
						msg.key = {
							remoteJid,
							fromMe,
							participant: node.attrs.participant,
							participantAlt,
							participantUsername: node.attrs.participant_username,
							addressingMode,
							id: node.attrs.id,
							...(msg.key || {})
						}
						msg.participant ??= node.attrs.participant
						msg.messageTimestamp = +node.attrs.t!

						const fullMsg = proto.WebMessageInfo.fromObject(msg) as WAMessage
						await upsertMessage(fullMsg, 'append')
					}
				})
			])
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack notification'))
		}
	}

	const handleMessage = async (node: BinaryNode) => {
		const encNode = getBinaryNodeChild(node, 'enc')
		// AunuBaileys (1.0.71, ported P2d): msmsg (Meta AI bot reply) needs
		// the messageSecret of the message we sent to @bot. The in-memory
		// map is lost on restart, so recover it from the message store
		// first (donor messages-recv.js). This replaces the upstream v7
		// blanket ignore (NACK MissingMessageSecret + drop): decryption
		// now runs through the normal path below, and a failure there
		// stays a CIPHERTEXT stub instead of a dropped stanza.
		if (encNode?.attrs.type === 'msmsg' && getMessage) {
			const targetId = getBinaryNodeChild(node, 'meta')?.attrs?.target_id
			if (typeof targetId === 'string' && targetId) {
				try {
					const targetMsg = await getMessage({ remoteJid: node.attrs.from, id: targetId, fromMe: true })
					const secret = targetMsg?.messageContextInfo?.messageSecret
					if (secret) {
						setBotMessageSecret(targetId, secret, node.attrs.from)
					}
				} catch (err) {
					logger.debug({ err, targetId }, 'failed to retrieve message secret for msmsg')
				}
			}
		}

		let acked = false

		try {
			const {
				fullMessage: msg,
				category,
				author,
				decrypt
			} = decryptMessageNode(node, authState.creds.me!.id, authState.creds.me!.lid || '', signalRepository, logger)

			const alt = msg.key.participantAlt || msg.key.remoteJidAlt
			// store new mappings we didn't have before
			if (!!alt) {
				const altServer = jidDecode(alt)?.server
				const primaryJid = msg.key.participant || msg.key.remoteJid!
				if (altServer === 'lid') {
					if (!(await signalRepository.lidMapping.getPNForLID(alt))) {
						await signalRepository.lidMapping.storeLIDPNMappings([{ lid: alt, pn: primaryJid }])
						await signalRepository.migrateSession(primaryJid, alt)
					}
				} else {
					await signalRepository.lidMapping.storeLIDPNMappings([{ lid: primaryJid, pn: alt }])
					await signalRepository.migrateSession(alt, primaryJid)
				}
			}

			await messageMutex.mutex(async () => {
				await decrypt()

				// AunuBaileys (1.0.71, ported P2d): a decrypted msmsg reply
				// is Meta AI text — surface it on its own event as well as
				// the normal messages.upsert flow.
				if (encNode?.attrs?.type === 'msmsg' && msg.message) {
					const text = msg.message.conversation || msg.message.extendedTextMessage?.text
					if (typeof text === 'string' && text) {
						ev.emit('messages.meta-ai', { key: msg.key, text, remoteJid: node.attrs.from! })
					}
				}

				// AunuBaileys: structured decrypt-failure event so
				// consumers can alert and aggregate on Bad MAC floods
				// (B-01) instead of parsing log lines. Payload and
				// suppression rule match the v6 emit in messages-recv:
				// group failures whose sender key is simply unavailable
				// are not reported (they say nothing about the author's
				// E2E session). `healed` is always false in this tree —
				// the session-reset self-heal is not ported yet. Called
				// from the final decrypt-failure paths below (the
				// missing-keys path included, as in v6 after HB-206);
				// the no-message / msmsg / expired-status paths do not
				// emit, exactly as in v6.
				const emitDecryptFailure = async () => {
					if (!author || !msg.key.remoteJid) {
						return
					}

					const isGroupMsg = !!isJidGroup(msg.key.remoteJid)
					// AunuBaileys (1.0.78, HB-223): a group failure whose
					// sender key is simply unavailable says nothing about
					// the author's E2E session \u2014 not reported, not
					// counted, not healed; the retry receipt is the fix.
					const senderKeyUnavailable = isGroupMsg && isSenderKeyUnavailableError(msg?.messageStubParameters?.[0])
					if (senderKeyUnavailable) {
						return
					}

					const addr = signalRepository.jidToSignalProtocolAddress(author)
					const failKey = isGroupMsg ? `sk:${msg.key.remoteJid}:${addr}` : addr
					const fails = (decryptFailCounts.get(failKey) || 0) + 1

					// AunuBaileys (self-heal wiring, re-applied P3 \u2014
					// v6 1.0.46/1.0.48/1.0.82 behaviour): `healed` is now
					// honest. Three classes, exactly as in v6:
					// (1) an unrecoverable session-layer failure (stored
					// session cannot decrypt at all, e.g. regressed
					// state) resets the E2E session IMMEDIATELY \u2014
					// waiting for the threshold only floods logs;
					// (2) a plaintext failure reaching
					// DECRYPT_FAIL_SESSION_RESET_LIMIT consecutive
					// failures (the Bad MAC class) resets the E2E
					// session, plus the sender-key record for groups
					// (deleting only the sender key, the 1.0.14
					// behaviour, never touched the rotten E2E session);
					// (3) anything below the threshold is only counted.
					// The session is deleted under BOTH its address
					// forms (PN <-> LID alt) when known. A heal-step
					// failure is logged and never blocks the retry
					// receipt that follows.
					const sessionLayerFailure = isUnrecoverableSessionError(msg?.messageStubParameters?.[0])
					let healed = false
					try {
						const resetE2ESession = async () => {
							await signalRepository.deleteSession([author])
							const alt = aunuLid?.getAltJid?.(author)
							if (alt && alt !== author) {
								await signalRepository.deleteSession([alt])
							}
						}

						if (sessionLayerFailure) {
							await resetE2ESession()
							if (isGroupMsg) {
								await signalRepository.deleteSenderKey(msg.key.remoteJid, author)
							}

							decryptFailCounts.delete(failKey)
							healed = true
							logger.warn(
								{ author, addr, group: isGroupMsg ? msg.key.remoteJid : undefined },
								'aunu: reset E2E session after an unrecoverable session-layer decrypt failure; retry receipt carries fresh keys'
							)
						} else if (fails >= DECRYPT_FAIL_SESSION_RESET_LIMIT) {
							await resetE2ESession()
							if (isGroupMsg) {
								await signalRepository.deleteSenderKey(msg.key.remoteJid, author)
							}

							decryptFailCounts.delete(failKey)
							healed = true
							logger.warn(
								{ author, addr, group: isGroupMsg ? msg.key.remoteJid : undefined },
								'aunu: deleted stale E2E session after repeated decrypt failures (Bad MAC self-heal); retry receipt carries fresh keys'
							)
						} else {
							decryptFailCounts.set(failKey, fails)
							while (decryptFailCounts.size > 1000) {
								decryptFailCounts.delete(decryptFailCounts.keys().next().value!)
							}
						}
					} catch (healErr) {
						logger.debug({ err: healErr }, 'aunu: session self-heal step failed, continuing with normal retry')
					}

					ev.emit('messages.decrypt-failure', {
						remoteJid: msg.key.remoteJid,
						author,
						address: addr,
						isGroup: isGroupMsg,
						failures: fails,
						healed,
						errorClass: sessionLayerFailure
							? 'session'
							: isBadMacError(msg?.messageStubParameters?.[0])
								? 'bad-mac'
								: 'other',
						messageId: node.attrs.id!,
						timestamp: Date.now()
					})
				}

				if (msg.key?.remoteJid && msg.key?.id && msg.message && messageRetryManager) {
					messageRetryManager.addRecentMessage(msg.key.remoteJid, msg.key.id, msg.message)
				}

				// message failed to decrypt
				if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
					if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT) {
						// AunuBaileys (1.0.82, HB-206, re-applied P3b): the 487 NACK stays,
						// but the failure first flows through the counting / self-heal
						// machinery (emitDecryptFailure above) and the stub upsert below,
						// like every other decrypt failure — only the retry receipt is
						// skipped (a resend of the same ciphertext cannot restore a message
						// key our ratchet no longer holds). The early return used to skip
						// all of that.
						await emitDecryptFailure()
						acked = true
						await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')
						return sendMessageAck(node, NACK_REASONS.ParsingError)
					}

					const stubParam = msg?.messageStubParameters?.[0]
					// AunuBaileys (1.0.82, HB-170, ported P2d): an msmsg (Meta
					// AI) failure is a message-SECRET problem, not an E2E
					// session problem — @bot has no resend path, so a retry
					// receipt only burns budget and the fail counter marched
					// toward a pointless @bot session reset. Plain ack, no
					// retry, no failure count; the stub is still upserted
					// below as the trace.
					const isMsmsgFailure =
						encNode?.attrs?.type === 'msmsg' || (typeof stubParam === 'string' && stubParam.startsWith('msmsg'))

					if (isMsmsgFailure) {
						logger.debug(
							{ msgId: msg.key.id, author, stubParam },
							'aunu: msmsg decrypt failure; no retry receipt and no session failure counted (a secret problem, not a session problem)'
						)
						acked = true
						await sendMessageAck(node)
					} else if (msg.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
						// Message arrived without encryption (e.g. CTWA ads messages).
						// Check if this is eligible for placeholder resend (matching WA Web filters).
						const unavailableNode = getBinaryNodeChild(node, 'unavailable')
						const unavailableType = unavailableNode?.attrs?.type
						if (
							unavailableType === 'bot_unavailable_fanout' ||
							unavailableType === 'hosted_unavailable_fanout' ||
							unavailableType === 'view_once_unavailable_fanout'
						) {
							logger.debug(
								{ msgId: msg.key.id, unavailableType },
								'skipping placeholder resend for excluded unavailable type'
							)
							acked = true
							return sendMessageAck(node)
						}

						const messageAge = unixTimestampSeconds() - toNumber(msg.messageTimestamp)
						if (messageAge > PLACEHOLDER_MAX_AGE_SECONDS) {
							logger.debug({ msgId: msg.key.id, messageAge }, 'skipping placeholder resend for old message')
							acked = true
							return sendMessageAck(node)
						}

						// Request the real content from the phone via placeholder resend PDO.
						// Upsert the CIPHERTEXT stub as a placeholder (like WA Web's processPlaceholderMsg),
						// and store the requestId in stubParameters[1] so users can correlate
						// with the incoming PDO response event.
						const cleanKey: proto.IMessageKey = {
							remoteJid: msg.key.remoteJid,
							fromMe: msg.key.fromMe,
							id: msg.key.id,
							participant: msg.key.participant
						}
						// Cache the original message metadata so the PDO response handler
						// can preserve key fields (LID details etc.) that the phone may omit
						const msgData: Partial<WAMessage> = {
							key: msg.key,
							messageTimestamp: msg.messageTimestamp,
							pushName: msg.pushName,
							participant: msg.participant,
							verifiedBizName: msg.verifiedBizName
						}
						requestPlaceholderResend(cleanKey, msgData)
							.then(requestId => {
								if (requestId && requestId !== 'RESOLVED') {
									logger.debug({ msgId: msg.key.id, requestId }, 'requested placeholder resend for unavailable message')
									ev.emit('messages.update', [
										{
											key: msg.key,
											update: { messageStubParameters: [NO_MESSAGE_FOUND_ERROR_TEXT, requestId] }
										}
									])
								}
							})
							.catch(err => {
								logger.warn({ err, msgId: msg.key.id }, 'failed to request placeholder resend for unavailable message')
							})
						acked = true
						await sendMessageAck(node)
						// Don't return — fall through to upsertMessage so the stub is emitted
					} else {
						// Skip retry for expired status messages (>24h old)
						if (isJidStatusBroadcast(msg.key.remoteJid!)) {
							const messageAge = unixTimestampSeconds() - toNumber(msg.messageTimestamp)
							if (messageAge > STATUS_EXPIRY_SECONDS) {
								logger.debug(
									{ msgId: msg.key.id, messageAge, remoteJid: msg.key.remoteJid },
									'skipping retry for expired status message'
								)
								acked = true
								return sendMessageAck(node)
							}
						}

						// AunuBaileys (1.0.72, HB-70, re-applied P3b):
						// never ask for a resend of our OWN
						// undecryptable message — it is an echo from
						// another of our devices, encrypted under that
						// device's session; a retry receipt would ask
						// ourselves to resend to ourselves. Ack it and
						// fall through to the stub upsert below. (The
						// missing-keys case is handled by the early
						// MISSING_KEYS branch above, as in v6.)
						if (msg.key.fromMe) {
							logger.debug({ msgId: msg.key.id }, 'skipping retry request for own undecryptable message')
							acked = true
							await sendMessageAck(node)
						} else {
							logger.debug('[handleMessage] Attempting retry request for failed decryption')

							await emitDecryptFailure()

							// WAWeb only retry-receipts here; server emits PreKeyLow if prekeys run low.
							await retryMutex.mutex(async () => {
							try {
								if (!ws.isOpen) {
									logger.debug({ node }, 'Connection closed, skipping retry')
									return
								}

								const encNode = getBinaryNodeChild(node, 'enc')
								await sendRetryRequest(node, !encNode)
								if (retryRequestDelayMs) {
									await delay(retryRequestDelayMs)
								}
							} catch (err) {
								logger.error({ err }, 'Failed to send retry')
							}

							acked = true
							await sendMessageAck(node, NACK_REASONS.UnhandledError)
						})
						}
					}
				} else {
					if (messageRetryManager && msg.key.id) {
						messageRetryManager.cancelPendingPhoneRequest(msg.key.id)
					}

					const isNewsletter = isJidNewsletter(msg.key.remoteJid!)
					if (!isNewsletter) {
						// no type in the receipt => message delivered
						let type: MessageReceiptType = undefined
						let participant = msg.key.participant
						if (category === 'peer') {
							// special peer message
							type = 'peer_msg'
						} else if (msg.key.fromMe) {
							// message was sent by us from a different device
							type = 'sender'
							// need to specially handle this case
							if (isLidUser(msg.key.remoteJid!) || isLidUser(msg.key.remoteJidAlt)) {
								participant = author // TODO: investigate sending receipts to LIDs and not PNs
							}
						} else if (!sendActiveReceipts) {
							type = 'inactive'
						}

						acked = true
						await sendReceipt(msg.key.remoteJid!, participant!, [msg.key.id!], type)

						// send ack for history message
						const isAnyHistoryMsg = getHistoryMsg(msg.message!)
						if (isAnyHistoryMsg) {
							const jid = jidNormalizedUser(msg.key.remoteJid!)
							await sendReceipt(jid, undefined, [msg.key.id!], 'hist_sync') // TODO: investigate
						}
					} else {
						acked = true
						await sendMessageAck(node)
						logger.debug({ key: msg.key }, 'processed newsletter message without receipts')
					}
				}

				cleanMessage(msg, authState.creds.me!.id, authState.creds.me!.lid!)

				await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')
			})
		} catch (error) {
			logger.error({ error, node: binaryNodeToString(node) }, 'error in handling message')
			if (!acked) {
				await sendMessageAck(node, NACK_REASONS.UnhandledError).catch(ackErr =>
					logger.error({ ackErr }, 'failed to ack message after error')
				)
			}
		}
	}

	const handleCall = async (node: BinaryNode) => {
		try {
			const { attrs } = node
			const [infoChild] = getAllBinaryNodeChildren(node)

			if (!infoChild) {
				throw new Boom('Missing call info in call node')
			}

			const status = getCallStatusFromNode(infoChild)

			const callId = infoChild.attrs['call-id']!
			const from = infoChild.attrs.from! || infoChild.attrs['call-creator']!

			const call: WACallEvent = {
				chatId: attrs.from!,
				from,
				callerPn: infoChild.attrs['caller_pn'],
				id: callId,
				date: new Date(+attrs.t! * 1000),
				offline: !!attrs.offline,
				status
			}

			if (status === 'relaylatency') {
				const latencyValue = infoChild.attrs.latency || infoChild.attrs['latency_ms'] || infoChild.attrs['latency-ms']
				const latencyMs = latencyValue ? Number(latencyValue) : undefined
				if (Number.isFinite(latencyMs)) {
					call.latencyMs = latencyMs
				}
			}

			if (status === 'offer') {
				call.isVideo = !!getBinaryNodeChild(infoChild, 'video')
				call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid']
				call.groupJid = infoChild.attrs['group-jid']
				await callOfferCache.set(call.id, call)
			}

			const existingCall = await callOfferCache.get<WACallEvent>(call.id)

			// use existing call info to populate this event
			if (existingCall) {
				call.isVideo = existingCall.isVideo
				call.isGroup = existingCall.isGroup
				call.callerPn = call.callerPn || existingCall.callerPn
			}

			// delete data once call has ended
			if (status === 'reject' || status === 'accept' || status === 'timeout' || status === 'terminate') {
				await callOfferCache.del(call.id)
			}

			ev.emit('call', [call])
		} catch (error) {
			logger.error({ error, node: binaryNodeToString(node) }, 'error in handling call')
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack call'))
		}
	}

	const handleBadAck = async ({ attrs }: BinaryNode) => {
		const key: WAMessageKey = { remoteJid: attrs.from, fromMe: true, id: attrs.id }

		// WARNING: REFRAIN FROM ENABLING THIS FOR NOW. IT WILL CAUSE A LOOP
		// // current hypothesis is that if pash is sent in the ack
		// // it means -- the message hasn't reached all devices yet
		// // we'll retry sending the message here
		// if(attrs.phash) {
		// 	logger.info({ attrs }, 'received phash in ack, resending message...')
		// 	const msg = await getMessage(key)
		// 	if(msg) {
		// 		await relayMessage(key.remoteJid!, msg, { messageId: key.id!, useUserDevicesCache: false })
		// 	} else {
		// 		logger.warn({ attrs }, 'could not send message again, as it was not found')
		// 	}
		// }

		// error in acknowledgement,
		// device could not display the message
		if (attrs.error) {
			const isReachoutTimelocked = attrs.error === String(NACK_REASONS.SenderReachoutTimelocked)

			if (attrs.error === SERVER_ERROR_CODES.MessageAccountRestriction) {
				// 463 = 1:1 message missing privacy token (tctoken). Usually means the
				// account is restricted: WhatsApp blocks starting new chats but preserves
				// existing ones, since established chats already carry a tctoken.
				// WA Web prevents this client-side (disables the compose bar).
				// No retry — retrying counts as another "reach out" and worsens the restriction.
				logger.warn(
					{ msgId: attrs.id, from: attrs.from },
					'error 463: account restricted or missing tctoken for contact'
				)

				const ackFrom = attrs.from
				if (ackFrom && !inFlight463Recoveries.has(ackFrom)) {
					inFlight463Recoveries.add(ackFrom)
					void (async () => {
						try {
							const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping)
							const tcStorageJid = await resolveTcTokenJid(ackFrom, getLIDForPN)
							const issueJid = await resolveIssuanceJid(
								ackFrom,
								sock.serverProps.lidTrustedTokenIssueToLid,
								getLIDForPN,
								getPNForLID
							)
							const result = await issuePrivacyTokens([issueJid], unixTimestampSeconds())
							await storeTcTokensFromIqResult({
								result,
								fallbackJid: tcStorageJid,
								keys: authState.keys,
								getLIDForPN,
								onNewJidStored: trackTcTokenJid
							})
							logger.debug({ from: ackFrom }, 'completed 463 token recovery issuance')
						} catch (err: any) {
							logger.debug({ from: ackFrom, err: err?.message }, 'failed 463 token recovery issuance')
						} finally {
							inFlight463Recoveries.delete(ackFrom)
						}
					})()
				}
			} else if (attrs.error === SERVER_ERROR_CODES.SmaxInvalid) {
				logger.warn(
					{ msgId: attrs.id, from: attrs.from },
					'smax-invalid (479): stanza rejected by server — likely stale device session or malformed addressing'
				)
			} else if (isReachoutTimelocked) {
				// user is temporarily restricted, fetch current restriction details
				await fetchAccountReachoutTimelock().catch(err => logger.warn({ err }, 'failed to fetch reachout timelock'))
				logger.warn({ attrs }, 'received error in ack')
			} else {
				logger.warn({ attrs }, 'received error in ack')
			}

			ev.emit('messages.update', [
				{
					key,
					update: {
						status: WAMessageStatus.ERROR,
						messageStubParameters: isReachoutTimelocked ? [attrs.error, ACCOUNT_RESTRICTED_TEXT] : [attrs.error]
					}
				}
			])
		}
	}

	/// processes a node with the given function
	/// and adds the task to the existing buffer if we're buffering events
	const processNodeWithBuffer = async <T>(
		node: BinaryNode,
		identifier: string,
		exec: (node: BinaryNode, offline: boolean) => Promise<T>
	) => {
		ev.buffer()
		await execTask()
		ev.flush()

		function execTask() {
			return exec(node, false).catch(err => onUnexpectedError(err, identifier))
		}
	}

	// AunuBaileys: the drain lives in Utils/offline-queue — a
	// throwing node is reported and skipped instead of wedging the
	// whole offline backlog (upstream's loop dropped the remaining
	// nodes and never reset its busy flag).
	const offlineQueue = createOfflineNodeQueue({
		onError: onUnexpectedError,
		isOpen: () => ws.isOpen
	})
	offlineQueue.register('message', handleMessage)
	offlineQueue.register('call', handleCall)
	offlineQueue.register('receipt', handleReceipt)
	offlineQueue.register('notification', handleNotification)
	const offlineNodeProcessor = { enqueue: offlineQueue.enqueue }

	const processNode = async (
		type: MessageType,
		node: BinaryNode,
		identifier: string,
		exec: (node: BinaryNode) => Promise<void>
	) => {
		// AunuBaileys: ignoreKey filter — a matching stanza is dropped
		// before any handling (no decryption, no persistence); stanzas
		// are still acked so the server stops redelivering them.
		// AunuBaileys (1.0.82, HB-210): the ack covers every type — a
		// dropped receipt/notification/call that was never acked would
		// be redelivered forever while the rule stayed active.
		if (
			aunuIgnoreFilter?.shouldDrop(type, node, [authState.creds.me?.id, authState.creds.me?.lid].filter(Boolean) as string[])
		) {
			await sendMessageAck(node).catch(() => {})
			logger.debug({ type, from: node.attrs.from, id: node.attrs.id }, 'aunu: stanza dropped by ignoreKey')
			return
		}

		// Fast path: ack and drop ignored JIDs before entering the buffer/queue
		const from = node.attrs.from
		let ignoreJid = from
		if (type === 'receipt' && from) {
			const attrs = node.attrs
			const isLid = attrs.from!.includes('lid')
			const isNodeFromMe = areJidsSameUser(
				attrs.participant || attrs.from,
				isLid ? authState.creds.me?.lid : authState.creds.me?.id
			)
			ignoreJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient
		}

		if (ignoreJid && ignoreJid !== S_WHATSAPP_NET && shouldIgnoreJid(ignoreJid)) {
			await sendMessageAck(node, type === 'message' ? NACK_REASONS.UnhandledError : undefined)
			return
		}

		const isOffline = !!node.attrs.offline

		if (isOffline) {
			offlineNodeProcessor.enqueue(type, node)
		} else {
			await processNodeWithBuffer(node, identifier, exec)
		}
	}

	// recv a message
	ws.on('CB:message', async (node: BinaryNode) => {
		await processNode('message', node, 'processing message', handleMessage)
	})

	ws.on('CB:call', async (node: BinaryNode) => {
		await processNode('call', node, 'handling call', handleCall)
	})

	ws.on('CB:receipt', async node => {
		await processNode('receipt', node, 'handling receipt', handleReceipt)
	})

	ws.on('CB:notification', async (node: BinaryNode) => {
		await processNode('notification', node, 'handling notification', handleNotification)
	})
	ws.on('CB:status', async (node: BinaryNode) => {
		await handleNewsletterStatus(node).catch(error => onUnexpectedError(error, 'handling newsletter status'))
	})
	ws.on('CB:ack,class:message', (node: BinaryNode) => {
		handleBadAck(node).catch(error => onUnexpectedError(error, 'handling bad ack'))
	})

	ev.on('call', async ([call]) => {
		if (!call) {
			return
		}

		// missed call + group call notification message generation
		if (call.status === 'timeout' || (call.status === 'offer' && call.isGroup)) {
			const msg: WAMessage = {
				key: {
					remoteJid: call.chatId,
					id: call.id,
					fromMe: false
				},
				messageTimestamp: unixTimestampSeconds(call.date)
			}
			if (call.status === 'timeout') {
				if (call.isGroup) {
					msg.messageStubType = call.isVideo
						? WAMessageStubType.CALL_MISSED_GROUP_VIDEO
						: WAMessageStubType.CALL_MISSED_GROUP_VOICE
				} else {
					msg.messageStubType = call.isVideo ? WAMessageStubType.CALL_MISSED_VIDEO : WAMessageStubType.CALL_MISSED_VOICE
				}
		} else if (call.id) {
			msg.message = { call: { callKey: Buffer.from(call.id) } }
		} else {
			// AunuBaileys (1.0.86, HB-216, re-applied P3b): a group call offer
			// without a call-id (an optional stanza attr the decoder does not
			// validate) made Buffer.from throw a raw TypeError inside this
			// listener; the throw unwound the whole 'call' emit, so host
			// listeners registered after this one never saw the offer at all.
			// There is no call key to reference — skip the notification
			// message; the 'call' event itself still reaches every listener.
			return
		}

			const protoMsg = proto.WebMessageInfo.fromObject(msg) as WAMessage
			await upsertMessage(protoMsg, call.offline ? 'append' : 'notify')
		}
	})

	/** timestamp of last tctoken prune run — throttles to once per 24h */
	let lastTcTokenPruneTs = 0
	/** dedupe in-flight 463 recovery token issuance by target JID */
	const inFlight463Recoveries = new Set<string>()

	ev.on('connection.update', ({ isOnline, connection }) => {
		if (typeof isOnline !== 'undefined') {
			sendActiveReceipts = isOnline
			logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`)
		}

		// Flush pending tctoken index save on disconnect to avoid writing after close
		if (connection === 'close' && tcTokenIndexTimer) {
			clearTimeout(tcTokenIndexTimer)
			tcTokenIndexTimer = undefined
			// Best-effort flush — may fail if store is already closed
			try {
				void Promise.resolve(flushTcTokenIndex()).catch(() => {})
			} catch {
				/* ignore sync errors */
			}
		}

		// Prune expired tctokens when coming online, at most once per 24 hours
		// Matches WA Web's CLEAN_TC_TOKENS task
		// Note: don't gate on tcTokenKnownJids.size — the index may still be loading
		if (isOnline) {
			const now = Date.now()
			const DAY_MS = 24 * 60 * 60 * 1000
			if (now - lastTcTokenPruneTs >= DAY_MS) {
				lastTcTokenPruneTs = now
				void pruneExpiredTcTokens()
			}
		}
	})

	registerSocketEndHandler(() => {
		if (!config.msgRetryCounterCache && msgRetryCache.close) {
			msgRetryCache.close()
		}

		if (!config.callOfferCache && callOfferCache.close) {
			callOfferCache.close()
		}

		identityAssertDebounce.close()
		sendActiveReceipts = false
	})

	async function pruneExpiredTcTokens() {
		try {
			await tcTokenIndexLoaded

			// Union with the persisted index picks up JIDs added by other layers
			// (history sync) without needing inter-module wiring.
			const persisted = await readTcTokenIndex(authState.keys)
			const allJids = new Set<string>(tcTokenKnownJids)
			for (const jid of persisted) allJids.add(jid)
			if (!allJids.size) return

			const jids = [...allJids]
			const allTokens = await authState.keys.get('tctoken', jids)

			type TcTokenWriteValue = null | { token: Buffer; timestamp?: string; senderTimestamp?: number }
			const writes: { [jid: string]: TcTokenWriteValue } = {}
			const survivors = new Set<string>()
			let mutated = 0

			for (const jid of jids) {
				const entry = allTokens[jid]
				if (!entry) {
					// Tracked but nothing in store — drop from index.
					mutated++
					continue
				}

				const hasPeerToken = !!entry.token?.length
				const peerTokenExpired = hasPeerToken && isTcTokenExpired(entry.timestamp)
				const hasSenderTs = entry.senderTimestamp !== undefined
				const senderTsExpired = hasSenderTs && isTcTokenExpired(entry.senderTimestamp)
				const keepPeerToken = hasPeerToken && !peerTokenExpired
				const keepSenderTs = hasSenderTs && !senderTsExpired

				if (!keepPeerToken && !keepSenderTs) {
					writes[jid] = null
					mutated++
				} else if (peerTokenExpired && keepSenderTs) {
					writes[jid] = { token: Buffer.alloc(0), senderTimestamp: entry.senderTimestamp }
					survivors.add(jid)
					mutated++
				} else {
					survivors.add(jid)
				}
			}

			if (mutated === 0) return

			await authState.keys.set({
				tctoken: {
					...writes,
					[TC_TOKEN_INDEX_KEY]: {
						token: Buffer.from(JSON.stringify([...survivors]))
					}
				}
			})

			tcTokenKnownJids.clear()
			for (const jid of survivors) tcTokenKnownJids.add(jid)

			logger.debug({ mutated, remaining: survivors.size }, 'pruned expired tctokens')
		} catch (err: any) {
			logger.warn({ err: err?.message }, 'failed to prune expired tctokens')
		}
	}

	return {
		...sock,
		sendMessageAck,
		sendRetryRequest,
		rejectCall,
		fetchMessageHistory,
		requestPlaceholderResend,
		messageRetryManager
	}
}

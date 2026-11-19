import { Boom } from '@hapi/boom'
import { waproto } from '../../WAProto/index.js'
import { BIZ_BOT_SUPPORT_PAYLOAD, DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults'
import type {
	AnyMessageContent,
	MediaConnInfo,
	MessageReceiptType,
	MessageRelayOptions,
	MiscMessageGenerationOptions,
	SocketConfig,
	WAMessage,
	WAMessageKey
} from '../Types'
import {
	aggregateMessageKeysNotFromMe,
	assertMediaContent,
	assertMeId,
	bindWaitForEvent,
	decryptMediaRetryData,
	DEF_MEDIA_HOST,
	encodeNewsletterMessage,
	encodeSignedDeviceIdentity,
	encodeWAMessage,
	encryptMediaRetryRequest,
	extractDeviceJids,
	generateMessageIDV2,
	generateParticipantHashV2,
	generateWAMessage,
	getStatusCodeForMediaRetry,
	getUrlFromDirectPath,
	getWAUploadToServer,
	MessageRetryManager,
	normalizeMessageContent,
	parseAndInjectE2ESessions,
	setBotMessageSecret,
	unixTimestampSeconds
} from '../Utils'
import { sentMessageCacheFor } from '../Utils/sent-message-cache'
import { getUrlInfo } from '../Utils/link-preview'
import { makeCacheStore } from '../Utils/internal-cache'
import { makeKeyedMutex, makeMutex } from '../Utils/make-mutex'
import { getMessageReportingToken, shouldIncludeReportingToken } from '../Utils/reporting-utils'
import {
	buildMergedTcTokenIndexWrite,
	isTcTokenExpired,
	resolveIssuanceJid,
	resolveTcTokenJid,
	shouldSendNewTcToken,
	storeTcTokensFromIqResult
} from '../Utils/tc-token-utils'
import {
	areJidsSameUser,
	type BinaryNode,
	type BinaryNodeAttributes,
	type FullJid,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isHostedLidUser,
	isHostedPnUser,
	isJidBot,
	isJidGroup,
	isJidMetaAI,
	isLidUser,
	isPnUser,
	jidDecode,
	jidEncode,
	jidNormalizedUser,
	type JidWithDevice,
	PSA_WID,
	S_WHATSAPP_NET
} from '../WABinary'
import { USyncQuery, USyncUser } from '../WAUSync'
import { makeNewsletterSocket } from './newsletter'

export const makeMessagesSocket = (config: SocketConfig) => {
	const {
		logger,
		linkPreviewImageThumbnailWidth,
		generateHighQualityLinkPreview,
		options: httpRequestOptions,
		patchMessageBeforeSending,
		cachedGroupMetadata,
		enableRecentMessageCache,
		maxMsgRetryCount
	} = config
	const sock = makeNewsletterSocket(config)
	const {
		ev,
		authState,
		messageMutex,
		signalRepository,
		upsertMessage,
		query,
		fetchPrivacySettings,
		sendNode,
		groupMetadata,
		groupToggleEphemeral,
		registerSocketEndHandler
	} = sock

	const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)

	/**
	 * Set of tctoken storage JIDs with a fire-and-forget `issuePrivacyTokens` IQ in flight.
	 * Prevents duplicate IQs from rapid back-to-back sends before `senderTimestamp` persists.
	 * Entries are always removed in `.finally()`, so the set is bounded by concurrency.
	 */
	const inFlightTcTokenIssuance = new Set<string>()

	// AunuBaileys (HB-199, closed in full by P9): this default used to
	// be a NodeCache with a TTL but no size cap; the internal cache
	// caps it (LRU eviction at the cap; set() never throws) and
	// provides the mget/mset surface the device path probes for.
	const userDevicesCache =
		config.userDevicesCache ||
		makeCacheStore<JidWithDevice[]>({
			stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
			maxEntries: 1000
		})
	/** Serializes writes to userDevicesCache across USync refresh and device-notification handling. */
	const devicesMutex = makeMutex()

	// Initialize message retry manager if enabled
	const messageRetryManager = enableRecentMessageCache ? new MessageRetryManager(logger, maxMsgRetryCount) : null

	// Prevent race conditions in Signal session encryption by user
	const encryptionMutex = makeKeyedMutex()

	let mediaConn: Promise<MediaConnInfo> | undefined
	/** Per-socket media host; updated whenever media_conn is fetched. Defaults to the public WhatsApp host. */
	let mediaHost: string = DEF_MEDIA_HOST
	const refreshMediaConn = async (forceGet = false): Promise<MediaConnInfo> => {
		// AunuBaileys (2.0.5, addendum HB-2026-1112-19; v6 1.0.68 fix
		// lost in the v7 rebase): a cached mediaConn promise that
		// rejected used to re-throw here forever, wedging ALL media
		// uploads until restart. A rejected cache is discarded so the
		// refresh below can run again.
		let media: MediaConnInfo | undefined
		try {
			media = await mediaConn
		} catch {
			media = undefined
			mediaConn = undefined
		}

		if (!media || forceGet || new Date().getTime() - media.fetchDate.getTime() > media.ttl * 1000) {
			mediaConn = (async () => {
				const result = await query({
					tag: 'iq',
					attrs: {
						type: 'set',
						xmlns: 'w:m',
						to: S_WHATSAPP_NET
					},
					content: [{ tag: 'media_conn', attrs: {} }]
				})
				const mediaConnNode = getBinaryNodeChild(result, 'media_conn')
				// AunuBaileys (HB-275, P4): the ttl used to be coerced
				// with a bare `+` — a missing/non-numeric ttl became
				// NaN, and the freshness predicate above
				// (`age > media.ttl * 1000`) is false forever for NaN,
				// so the media connection was NEVER refreshed
				// proactively again (only the reactive 401/403 path
				// could rescue it). Sanitise at the boundary: a
				// non-finite ttl falls back to one hour, and a
				// response without media_conn/auth is a server error,
				// not a cacheable result.
				if (!mediaConnNode || !mediaConnNode.attrs.auth) {
					throw new Boom('media_conn response is missing the media_conn node or its auth', { statusCode: 502 })
				}

				const rawTtl = +mediaConnNode.attrs.ttl!
				// TODO: explore full length of data that whatsapp provides
				const node: MediaConnInfo = {
					hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
						hostname: attrs.hostname!,
						maxContentLengthBytes: +attrs.maxContentLengthBytes!
					})),
					auth: mediaConnNode.attrs.auth,
					ttl: Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 3600,
					fetchDate: new Date()
				}
				logger.debug('fetched media conn')
				if (node.hosts[0]) {
					mediaHost = node.hosts[0].hostname
				}

				return node
			})()
		}

		return mediaConn!
	}

	/**
	 * generic send receipt function
	 * used for receipts of phone call, read, delivery etc.
	 * */
	const sendReceipt = async (
		jid: string,
		participant: string | undefined,
		messageIds: string[],
		type: MessageReceiptType
	) => {
		if (!messageIds || messageIds.length === 0) {
			throw new Boom('missing ids in receipt')
		}

		const node: BinaryNode = {
			tag: 'receipt',
			attrs: {
				id: messageIds[0]!
			}
		}
		const isReadReceipt = type === 'read' || type === 'read-self'
		if (isReadReceipt) {
			node.attrs.t = unixTimestampSeconds().toString()
		}

		if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) {
			node.attrs.recipient = jid
			node.attrs.to = participant!
		} else {
			node.attrs.to = jid
			if (participant) {
				node.attrs.participant = participant
			}
		}

		if (type) {
			node.attrs.type = type
		}

		const remainingMessageIds = messageIds.slice(1)
		if (remainingMessageIds.length) {
			node.content = [
				{
					tag: 'list',
					attrs: {},
					content: remainingMessageIds.map(id => ({
						tag: 'item',
						attrs: { id }
					}))
				}
			]
		}

		logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages')
		await sendNode(node)
	}

	/** Correctly bulk send receipts to multiple chats, participants */
	const sendReceipts = async (keys: WAMessageKey[], type: MessageReceiptType) => {
		const recps = aggregateMessageKeysNotFromMe(keys)
		for (const { jid, participant, messageIds } of recps) {
			await sendReceipt(jid, participant, messageIds, type)
		}
	}

	/** Bulk read messages. Keys can be from different chats & participants */
	const readMessages = async (keys: WAMessageKey[]) => {
		// AunuBaileys (1.0.88, HB-261, re-applied P3b): the privacy fetch was
		// awaited bare — on a COLD cache it runs a real IQ, and when that IQ
		// failed readMessages rejected BEFORE sendReceipts ran: zero receipts
		// sent, the messages stayed unread. The fetch is best-effort now: on
		// failure we fall back to the default 'read' type rather than dropping
		// the receipts entirely.
		let privacySettings: Awaited<ReturnType<typeof fetchPrivacySettings>> | undefined
		try {
			privacySettings = await fetchPrivacySettings()
		} catch (err) {
			logger.warn({ err }, 'aunu: privacy settings fetch failed in readMessages; sending plain read receipts')
		}

		// based on privacy settings, we have to change the read type
		const readType = !privacySettings || privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
		await sendReceipts(keys, readType)
	}

	/** Device info with wire JID */
	type DeviceWithJid = JidWithDevice & {
		jid: string
	}

	/** Fetch all the devices we've to send a message to */
	const getUSyncDevices = async (
		jids: string[],
		useCache: boolean,
		ignoreZeroDevices: boolean
	): Promise<DeviceWithJid[]> => {
		// AunuBaileys (2.2.0, HB-2026-1112-22 addendum): this is a
		// PUBLIC socket export — a host calling it before pairing
		// completes hit the bare creds.me!.id deref in the
		// extractDeviceJids call below as a raw TypeError. The
		// sendMessage pattern applies: Boom 'Not authenticated'.
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated', { statusCode: 401 })
		}

		const deviceResults: DeviceWithJid[] = []

		if (!useCache) {
			logger.debug('not using cache for devices')
		}

		const toFetch: string[] = []

		const jidsWithUser = jids
			.map(jid => {
				const decoded = jidDecode(jid)
				const user = decoded?.user
				const device = decoded?.device
				const isExplicitDevice = typeof device === 'number' && device >= 0

				if (isExplicitDevice && user) {
					deviceResults.push({
						user,
						device,
						jid
					})
					return null
				}

				jid = jidNormalizedUser(jid)
				return { jid, user }
			})
			.filter(jid => jid !== null)

		let mgetDevices: undefined | Record<string, FullJid[] | undefined>

		if (useCache && userDevicesCache.mget) {
			const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean) as string[]
			mgetDevices = await userDevicesCache.mget(usersToFetch)
		}

		for (const { jid, user } of jidsWithUser) {
			if (useCache) {
				const devices =
					mgetDevices?.[user!] ||
					(userDevicesCache.mget ? undefined : ((await userDevicesCache.get(user!)) as FullJid[]))
				if (devices) {
					const devicesWithJid = devices.map(d => ({
						...d,
						jid: jidEncode(d.user, d.server, d.device)
					}))
					deviceResults.push(...devicesWithJid)

					logger.trace({ user }, 'using cache for devices')
				} else {
					toFetch.push(jid)
				}
			} else {
				toFetch.push(jid)
			}
		}

		if (!toFetch.length) {
			return deviceResults
		}

		const requestedLidUsers = new Set<string>()
		for (const jid of toFetch) {
			if (isLidUser(jid) || isHostedLidUser(jid)) {
				const user = jidDecode(jid)?.user
				if (user) requestedLidUsers.add(user)
			}
		}

		const query = new USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol()

		for (const jid of toFetch) {
			query.withUser(new USyncUser().withId(jid)) // todo: investigate - the idea here is that <user> should have an inline lid field with the lid being the pn equivalent
		}

		const result = await sock.executeUSyncQuery(query)

		if (result) {
			// TODO: LID MAP this stuff (lid protocol will now return lid with devices)
			const lidResults = result.list.filter(a => !!a.lid)
			if (lidResults.length > 0) {
				logger.trace('Storing LID maps from device call')
				const pairs = lidResults.map(a => ({ lid: a.lid as string, pn: a.id }))

				// AunuBaileys (2.3.0, HB-399): EVERY lid returned here
				// used to be force-refreshed below, although the
				// comment said "newly mapped" — with the short device
				// cache this ran on nearly every send: force=true
				// skips validateSession, fetches a fresh bundle and
				// injectE2ESession closes the peer's open device-0
				// session and reopens it as pending. Determine which
				// pairs are genuinely new by reading the persisted
				// 'lid-mapping' store first (the same source
				// storeLIDPNMappings checks); only those get the
				// force-refresh. If the read fails, fall back to the
				// old all-LIDs behaviour rather than skipping a
				// needed refresh.
				let newLids = pairs.map(p => p.lid)
				try {
					const pnUsers = pairs.map(p => jidDecode(p.pn)?.user).filter((u): u is string => !!u)
					const existing = pnUsers.length ? await authState.keys.get('lid-mapping', pnUsers) : {}
					newLids = pairs
						.filter(p => {
							const pnUser = jidDecode(p.pn)?.user
							const lidUser = jidDecode(p.lid)?.user
							return !!pnUser && !!lidUser && existing[pnUser] !== lidUser
						})
						.map(p => p.lid)
				} catch (e) {
					logger.warn({ e }, 'failed to read existing LID mappings; force-refreshing all returned LIDs')
				}

				await signalRepository.lidMapping.storeLIDPNMappings(pairs)

				// Force-refresh sessions for newly mapped LIDs to align identity addressing
				try {
					if (newLids.length) {
						await assertSessions(newLids, true)
					}
				} catch (e) {
					logger.warn({ e, count: newLids.length }, 'failed to assert sessions for newly mapped LIDs')
				}
			}

			const extracted = extractDeviceJids(
				result?.list,
				authState.creds.me!.id,
				authState.creds.me!.lid!,
				ignoreZeroDevices
			)
			const deviceMap: { [_: string]: FullJid[] } = {}

			for (const item of extracted) {
				deviceMap[item.user] = deviceMap[item.user] || []
				deviceMap[item.user]?.push(item)
			}

			// Process each user's devices as a group for bulk LID migration
			for (const [user, userDevices] of Object.entries(deviceMap)) {
				const isLidUser = requestedLidUsers.has(user)

				// Process all devices for this user
				for (const item of userDevices) {
					const finalJid = isLidUser
						? jidEncode(user, item.server, item.device)
						: jidEncode(item.user, item.server, item.device)

					deviceResults.push({
						...item,
						jid: finalJid
					})

					logger.debug(
						{
							user: item.user,
							device: item.device,
							finalJid,
							usedLid: isLidUser
						},
						'Processed device with LID priority'
					)
				}
			}

			await devicesMutex.mutex(async () => {
				if (userDevicesCache.mset) {
					// if the cache supports mset, we can set all devices in one go
					await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })))
				} else {
					for (const key in deviceMap) {
						if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key])
					}
				}
			})

			const userDeviceUpdates: { [userId: string]: string[] } = {}
			for (const [userId, devices] of Object.entries(deviceMap)) {
				if (devices && devices.length > 0) {
					userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0')
				}
			}

			if (Object.keys(userDeviceUpdates).length > 0) {
				try {
					await authState.keys.set({ 'device-list': userDeviceUpdates })
					logger.debug(
						{ userCount: Object.keys(userDeviceUpdates).length },
						'stored user device lists for bulk migration'
					)
				} catch (error) {
					logger.warn({ error }, 'failed to store user device lists')
				}
			}
		}

		return deviceResults
	}

	/**
	 * Update Member Label
	 */
	const updateMemberLabel = (jid: string, memberLabel: string) => {
		return relayMessage(
			jid,
			{
				protocolMessage: {
					type: waproto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
					memberLabel: {
						label: memberLabel?.slice(0, 30),
						labelTimestamp: unixTimestampSeconds()
					}
				}
			},
			{
				additionalNodes: [
					{
						tag: 'meta',
						attrs: {
							tag_reason: 'user_update',
							appdata: 'member_tag'
						},
						content: undefined
					}
				]
			}
		)
	}

	const assertSessions = async (jids: string[], force?: boolean) => {
		let didFetchNewSession = false
		const uniqueJids = [...new Set(jids)]
		const jidsRequiringFetch: string[] = []

		logger.debug({ jids }, 'assertSessions call with jids')

		for (const jid of uniqueJids) {
			if (!force) {
				const sessionValidation = await signalRepository.validateSession(jid)
				if (sessionValidation.exists) {
					continue
				}
			}

			jidsRequiringFetch.push(jid)
		}

		if (jidsRequiringFetch.length) {
			// LID if mapped, otherwise original
			const pnJids = jidsRequiringFetch.filter(jid => !!isPnUser(jid) || !!isHostedPnUser(jid))
			const lidPairs = (await signalRepository.lidMapping.getLIDsForPNs(pnJids)) || []
			const mappedPns = new Set(lidPairs.map(a => jidNormalizedUser(a.pn)))
			const wireJids = [
				...jidsRequiringFetch.filter(jid => !!isLidUser(jid) || !!isHostedLidUser(jid)),
				...lidPairs.map(a => a.lid),
				// AunuBaileys (2.2.0, HB-339): a PN with NO LID mapping
				// used to vanish from the fetch entirely — its session
				// was never established and group sends then skipped
				// that participant silently. Keep the PN wire form so
				// the server can still serve its bundle.
				...pnJids.filter(jid => !mappedPns.has(jidNormalizedUser(jid)))
			]

			logger.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions')
			const result = await query({
				tag: 'iq',
				attrs: {
					xmlns: 'encrypt',
					type: 'get',
					to: S_WHATSAPP_NET
				},
				content: [
					{
						tag: 'key',
						attrs: {},
						content: wireJids.map(jid => {
							const attrs: { [key: string]: string } = { jid }
							if (force) attrs.reason = 'identity'
							return { tag: 'user', attrs }
						})
					}
				]
			})
			// AunuBaileys (2.2.0, HB-340 addendum, send path): a
			// timed-out bundle fetch resolves undefined, and
			// parseAndInjectE2ESessions(undefined) is a silent
			// no-op — identical to a legitimately empty response —
			// so assertSessions reported success (didFetchNewSession)
			// for sessions that were never established, and the
			// send failed later with a misleading error (or, for a
			// subset of devices, silently partial). A fetch that
			// timed out FAILED; say so with the real cause.
			if (!result) {
				throw new Boom('Timed out fetching key bundles for session assertion', { statusCode: 408 })
			}

			await parseAndInjectE2ESessions(result, signalRepository, logger)
			didFetchNewSession = true
		}

		return didFetchNewSession
	}

	const sendPeerDataOperationMessage = async (
		pdoMessage: waproto.Message.IPeerDataOperationRequestMessage
	): Promise<string> => {
		//TODO: for later, abstract the logic to send a Peer Message instead of just PDO - useful for App State Key Resync with phone
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		const protocolMessage: waproto.IMessage = {
			protocolMessage: {
				peerDataOperationRequestMessage: pdoMessage,
				type: waproto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
			}
		}

		const meJid = jidNormalizedUser(authState.creds.me.id)

		const msgId = await relayMessage(meJid, protocolMessage, {
			additionalAttributes: {
				category: 'peer',

				push_priority: 'high_force'
			},
			additionalNodes: [
				{
					tag: 'meta',
					attrs: { appdata: 'default' }
				}
			]
		})

		return msgId
	}

	// AunuBaileys (HB-269, P4): a patchMessageBeforeSending hook that
	// returns a non-object — or forgets to return at all, the classic
	// `async msg => { await log(msg) }` host bug — used to sail through
	// every relay branch: the spread of undefined/null/a scalar into a
	// per-recipient entry is legal JS, proto-encoding an empty or
	// scalar "message" yields padding bytes only, and the send
	// resolved as success while the peer received nothing. HB-253
	// guards the ORIGINAL message and HB-212/HB-267 guard patch
	// ARRAYS; the scalar/undefined result was never checked. A valid
	// patched message is a non-empty plain object, like HB-253's test.
	const assertValidPatchedMessage = (patched: unknown): waproto.IMessage => {
		if (!patched || typeof patched !== 'object' || Array.isArray(patched) || !Object.keys(patched).length) {
			throw new Boom('patchMessageBeforeSending must return a non-empty message object', { statusCode: 400 })
		}

		return patched as waproto.IMessage
	}

	const createParticipantNodes = async (
		recipientJids: string[],
		message: waproto.IMessage,
		extraAttrs?: BinaryNode['attrs'],
		dsmMessage?: waproto.IMessage
	) => {
		if (!recipientJids.length) {
			return { nodes: [] as BinaryNode[], shouldIncludeDeviceIdentity: false }
		}

		const patched = await patchMessageBeforeSending(message, recipientJids)
		if (!Array.isArray(patched)) {
			// HB-269: fail hard BEFORE any encryption work — an invalid
			// scalar result must not become one empty <enc> per device.
			assertValidPatchedMessage(patched)
		}
		const patchedMessages = Array.isArray(patched)
			? patched
			: recipientJids.map(jid => ({ recipientJid: jid, message: patched }))

		// AunuBaileys (2.2.0, HB-269 addendum): a per-jid patch
		// result that OMITS a requested recipient drops that
		// recipient silently — no node, no error, and the send
		// still resolves. Compare the coverage and warn loudly for
		// every recipient the patch left out.
		if (Array.isArray(patched)) {
			const patchedJids = new Set(patchedMessages.map(p => p?.recipientJid).filter(Boolean))
			for (const requestedJid of recipientJids) {
				if (!patchedJids.has(requestedJid)) {
					logger.warn(
						{ jid: requestedJid },
						'aunu: patchMessageBeforeSending omitted a requested recipient; that recipient will not receive this message'
					)
				}
			}
		}

		let shouldIncludeDeviceIdentity = false
		// AunuBaileys (2.2.0, HB-2026-1112-22 addendum 3): also a
		// public export — the bare me!.id deref threw a raw
		// TypeError for a pre-pairing host call. (The empty-list
		// early return above stays guard-free by design.)
		const meId = authState.creds.me?.id
		if (!meId) {
			throw new Boom('Not authenticated', { statusCode: 401 })
		}

		const meLid = authState.creds.me?.lid
		const meLidUser = meLid ? jidDecode(meLid)?.user : null

		const encryptionPromises = (patchedMessages as any).map(
			async (patchedEntry: any) => {
				// AunuBaileys (2.0.5, addendum HB-269): the entry used
				// to be destructured in the parameter list — a
				// null/undefined entry in the array returned by
				// patchMessageBeforeSending threw a raw TypeError
				// during destructuring, BEFORE the per-recipient
				// try/catch below, so one bad entry rejected the
				// whole Promise.all and destroyed the entire group
				// send (defeating the HB-2026-1111-3 isolation).
				// Destructure inside the guarded body instead; a bad
				// entry skips only its own recipient.
				let jid: string | undefined
				let patchedMessage: any
				try {
					;({ recipientJid: jid, message: patchedMessage } = patchedEntry ?? {})
					if (!jid) return null

					// narrowed copy for the encryption closure below
					const recipientJid = jid

					// AunuBaileys (HB-269, P4): a per-jid patch entry
					// whose message is not a valid object would encode
					// to padding only — skip this recipient (the
					// HB-136 pattern); if every entry is bad, the
					// 'All encryptions failed' guard below fires.
					if (
						!patchedMessage ||
						typeof patchedMessage !== 'object' ||
						Array.isArray(patchedMessage) ||
						!Object.keys(patchedMessage).length
					) {
						logger.warn({ jid }, 'aunu: patchMessageBeforeSending returned an invalid message for a recipient; skipping it')
						return null
					}

					let msgToEncrypt = patchedMessage

					if (dsmMessage) {
						const { user: targetUser } = jidDecode(jid)!
						const { user: ownPnUser } = jidDecode(meId)!
						const ownLidUser = meLidUser

						const isOwnUser = targetUser === ownPnUser || (ownLidUser && targetUser === ownLidUser)
						// AunuBaileys (2.3.0, HB-403 addendum): the skip
						// used to compare raw JID strings — jidEncode
						// drops device 0, so a bare me.lid IS the
						// device-0 JID as a string and the phone was
						// skipped as the "exact sender device" (the
						// HB-375 DSM fix made this site reachable: the
						// echo used to arrive pre-wrapped). Compare the
						// decoded (user, device) pair instead — mirror
						// of the HB-403 partition fix in relayMessage.
						const candidate = jidDecode(jid)
						const senderDevice = jidDecode(meId)?.device ?? 0
						const isExactSenderDevice =
							!!candidate &&
							(candidate.user === ownPnUser || (ownLidUser && candidate.user === ownLidUser)) &&
							(candidate.device ?? 0) === senderDevice

						if (isOwnUser && !isExactSenderDevice) {
							// AunuBaileys (2.3.0, HB-375): the DSM envelope
							// used to be encrypted verbatim — its inner
							// message was the ORIGINAL message, so our own
							// devices saw the pre-patch content while the
							// peer received the patched text. Wrap this
							// recipient's patched message in the envelope
							// instead; the envelope's own fields
							// (destinationJid, messageContextInfo) are
							// preserved.
							msgToEncrypt = dsmMessage.deviceSentMessage
								? {
										...dsmMessage,
										deviceSentMessage: {
											...dsmMessage.deviceSentMessage,
											message: patchedMessage
										}
									}
								: dsmMessage
							logger.debug({ jid, targetUser }, 'Using DSM for own device')
						}
					}

					const bytes = encodeWAMessage(msgToEncrypt)
					const mutexKey = recipientJid

					const node = await encryptionMutex.mutex(mutexKey, async () => {
						const { type, ciphertext } = await signalRepository.encryptMessage({ jid: recipientJid, data: bytes })

						if (type === 'pkmsg') {
							shouldIncludeDeviceIdentity = true
						}

						return {
							tag: 'to',
							attrs: { jid: recipientJid },
							content: [
								{
									tag: 'enc',
									attrs: { v: '2', type, ...(extraAttrs || {}) },
									content: ciphertext
								}
							]
						}
					})

					return node
				} catch (err) {
					logger.error({ jid, err }, 'Failed to encrypt for recipient')
					return null
				}
			}
		)

		const nodes = (await Promise.all(encryptionPromises)).filter(node => node !== null) as BinaryNode[]

		if (recipientJids.length > 0 && nodes.length === 0) {
			throw new Boom('All encryptions failed', { statusCode: 500 })
		}

		return { nodes, shouldIncludeDeviceIdentity }
	}

	const relayMessage = async (
		jid: string,
		message: waproto.IMessage,
		{
			messageId: msgId,
			participant,
			additionalAttributes,
			additionalNodes,
			useUserDevicesCache,
			useCachedGroupMetadata,
			statusJidList
		}: MessageRelayOptions
	) => {
		// AunuBaileys (1.0.83, HB-253, re-applied P3b): a non-object message —
		// or an empty object — proto-encodes to ZERO content bytes without
		// throwing, so the relay used to report success while the peer
		// received random padding only: the 1.0.71 silent-empty class at the
		// one public entry point that never got a guard. Fail fast, before
		// any wait or network work.
		if (!message || typeof message !== 'object' || Array.isArray(message) || !Object.keys(message).length) {
			throw new Boom('relayMessage requires a non-empty message object', { statusCode: 400 })
		}

		const meId = assertMeId(authState.creds)
		const meLid = authState.creds.me?.lid
		const isRetryResend = Boolean(participant?.jid)
		let shouldIncludeDeviceIdentity = isRetryResend
		const statusJid = 'status@broadcast'

		// AunuBaileys (2.1.0, HB-282 facet c + HB-329): a jid without '@' used to throw a raw TypeError here — reject it as a caller-visible Boom 400 instead.
		const decodedJid = jidDecode(jid)
		if (!decodedJid) {
			throw new Boom(`Invalid jid: ${jid}`, { statusCode: 400 })
		}
		const { user, server } = decodedJid
		const isGroup = server === 'g.us'
		const isStatus = jid === statusJid
		const isLid = server === 'lid'
		const isNewsletter = server === 'newsletter'
		const isGroupOrStatus = isGroup || isStatus
		const finalJid = jid

		msgId = msgId || generateMessageIDV2(meId)
		useUserDevicesCache = useUserDevicesCache !== false
		useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus

		const participants: BinaryNode[] = []
		const destinationJid = !isStatus ? finalJid : statusJid
		const binaryNodeContent: BinaryNode[] = []
		const devices: DeviceWithJid[] = []
		let reportingMessage: waproto.IMessage | undefined

		const meMsg: waproto.IMessage = {
			deviceSentMessage: {
				destinationJid,
				message
			},
			messageContextInfo: message.messageContextInfo
		}

		const extraAttrs: BinaryNodeAttributes = {}

		if (participant) {
			if (!isGroup && !isStatus) {
				additionalAttributes = { ...additionalAttributes, device_fanout: 'false' }
			}

			if (!jidDecode(participant.jid)) {
				throw new Boom(`Invalid participant jid: ${participant.jid}`, { statusCode: 400 })
			}

			// AunuBaileys (2.3.0, HB-400): the retry participant used
			// to ALSO be pushed into the fan-out `devices` list — the
			// regular fan-out then encrypted the message for them
			// into <participants>, and the isRetryResend block below
			// encrypted it AGAIN into a direct <enc>: the same
			// message encrypted twice for one device (server error
			// 479, DMs and groups alike). The retry block is the one
			// and only encryption for the participant; it asserts
			// their session itself (see below). (Distinct mechanism
			// from HB-375, which is about pre-patch content.)
		}

		// AunuBaileys (1.0.83, HB-178, re-applied P3b): the stanza built inside
		// the transaction is captured here and sent only AFTER the transaction
		// commits — see the tail of this function.
		let stanzaToSend: BinaryNode | undefined
		// AunuBaileys (2.2.0, HB-71 addendum): the sender-key-memory
		// persist is deferred the same way — see the group branch.
		let persistSenderKeyMemory: (() => Promise<void>) | undefined
		await authState.keys.transaction(async () => {
			const mediaType = getMediaType(message)
			if (mediaType) {
				extraAttrs['mediatype'] = mediaType
			}

			if (isNewsletter) {
				const patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message
				// AunuBaileys (1.0.83, HB-212, re-applied P3b): a per-jid patch ARRAY
				// is in-contract for patchMessageBeforeSending, but
				// encodeNewsletterMessage is a bare proto encode — an array encodes
				// to 0 bytes, so the channel got an empty post while sendMessage
				// resolved as success. Mirror the group branch and refuse it loudly.
				if (Array.isArray(patched)) {
					throw new Boom('Per-jid patching is not supported in newsletters', { statusCode: 400 })
				}

				// AunuBaileys (HB-269, P4): a scalar/undefined patch
				// result encodes to ZERO bytes here — the channel got
				// an empty post while sendMessage resolved as success.
				assertValidPatchedMessage(patched)

				const bytes = encodeNewsletterMessage(patched as waproto.IMessage)
				binaryNodeContent.push({
					tag: 'plaintext',
					attrs: {},
					content: bytes
				})
				const stanza: BinaryNode = {
					tag: 'message',
					attrs: {
						to: jid,
						id: msgId,
						type: getMessageType(message),
						...(additionalAttributes || {})
					},
					content: binaryNodeContent
				}
				logger.debug({ msgId }, `sending newsletter message to ${jid}`)
				// AunuBaileys (1.0.83, HB-178, re-applied P3b): captured, not sent —
				// the send happens after the commit at the tail of relayMessage.
				stanzaToSend = stanza
				return
			}

			if (normalizeMessageContent(message)?.pinInChatMessage || normalizeMessageContent(message)?.reactionMessage) {
				extraAttrs['decrypt-fail'] = 'hide' // todo: expand for reactions and other types
			}

			if (isGroupOrStatus && !isRetryResend) {
				const [groupData, senderKeyMap] = await Promise.all([
					(async () => {
						let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined // todo: should we rely on the cache specially if the cache is outdated and the metadata has new fields?
						if (groupData && Array.isArray(groupData?.participants)) {
							logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata')
						} else if (!isStatus) {
							groupData = await groupMetadata(jid) // TODO: start storing group participant list + addr mode in Signal & stop relying on this
						}

						return groupData
					})(),
					(async () => {
						if (!participant && !isStatus) {
							// what if sender memory is less accurate than the cached metadata
							// on participant change in group, we should do sender memory manipulation
							const result = await authState.keys.get('sender-key-memory', [jid]) // TODO: check out what if the sender key memory doesn't include the LID stuff now?
							return result[jid] || {}
						}

						return {}
					})()
				])

				// AunuBaileys (2.1.0, HB-282 facet d + addendum): groupData.participants may hold null or id-less entries — a null entry threw here and an id-less one leaked an '' JID into the USync query.
				const participantsList = Array.isArray(groupData?.participants)
					? groupData.participants.filter(p => p?.id).map(p => p.id)
					: []

				if (groupData?.ephemeralDuration && groupData.ephemeralDuration > 0) {
					additionalAttributes = {
						...additionalAttributes,
						expiration: groupData.ephemeralDuration.toString()
					}
				}

				if (isStatus && statusJidList) {
					participantsList.push(...statusJidList)
				}

				const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
				devices.push(...additionalDevices)

				// AunuBaileys (1.0.88, HB-266, re-applied P3b): ZERO resolved devices
				// used to fall through — the stanza went out carrying only the
				// sender-key ciphertext (an empty participants list adds no
				// <participants> node), nobody received the sender key, nobody could
				// decrypt, and relayMessage still resolved with a message id as if
				// delivered. An undeliverable group/status/broadcast send fails
				// loudly instead (participant-targeted resends are excluded — they
				// address their single device directly).
				if (!participant && !devices.length) {
					throw new Boom(
						'relayMessage: no recipient devices resolved for this group/status message (empty participant list or empty status audience); refusing to send an undeliverable message',
						{ statusCode: 400 }
					)
				}

				if (isGroup) {
					additionalAttributes = {
						...additionalAttributes,
						addressing_mode: groupData?.addressingMode || 'lid'
					}
				}

				const patched = await patchMessageBeforeSending(message)
				if (Array.isArray(patched)) {
					throw new Boom('Per-jid patching is not supported in groups')
				}

				// AunuBaileys (HB-269, P4): a scalar/empty patch result
				// encodes to padding bytes only — the group would
				// receive an empty skmsg while the send resolved.
				assertValidPatchedMessage(patched)

				const bytes = encodeWAMessage(patched)
				reportingMessage = patched
				const groupAddressingMode = additionalAttributes?.['addressing_mode'] || groupData?.addressingMode || 'lid'
				const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId

				const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
					group: destinationJid,
					data: bytes,
					meId: groupSenderIdentity
				})

				const senderKeyRecipients: string[] = []
				for (const device of devices) {
					const deviceJid = device.jid
					const hasKey = !!senderKeyMap[deviceJid]
					if (
						(!hasKey || !!participant) &&
						!isHostedLidUser(deviceJid) &&
						!isHostedPnUser(deviceJid) &&
						device.device !== 99
					) {
						//todo: revamp all this logic
						// the goal is to follow with what I said above for each group, and instead of a true false map of ids, we can set an array full of those the app has already sent pkmsgs
						senderKeyRecipients.push(deviceJid)
						// AunuBaileys (1.0.72, HB-71, re-applied
						// P3b): the map used to be marked
						// optimistically HERE, before encryption —
						// a device whose encryption then failed was
						// never offered the sender key again and
						// could not decrypt the group's messages
						// from this sender. Only devices that
						// actually receive a node are marked, after
						// createParticipantNodes returns below.
					}
				}

				if (senderKeyRecipients.length) {
					logger.debug({ senderKeyJids: senderKeyRecipients }, 'sending new sender key')

					const senderKeyMsg: waproto.IMessage = {
						senderKeyDistributionMessage: {
							axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
							groupId: destinationJid
						}
					}

					// AunuBaileys (2.2.0, HB-2026-1113-161 facet 2):
					// the distribution used to be awaited bare BEFORE
					// the skmsg node below was even pushed — a total
					// distribution failure (one bad session in
					// assertSessions, one encryption batch failing)
					// aborted the whole group send, including for
					// members who already hold the sender key and
					// could have decrypted this message. Distribution
					// is best-effort: members without the key request
					// it again through the normal retry flow.
					try {
						const senderKeySessionTargets = senderKeyRecipients
						await assertSessions(senderKeySessionTargets)

						const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, extraAttrs)
						shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity

						// AunuBaileys (1.0.72, HB-71, re-applied P3b):
						// mark only the devices that actually received
						// a sender-key node (see the recipients loop
						// above).
						const deliveredJids = new Set(result.nodes.map(n => n.attrs?.jid).filter(Boolean))
						for (const deliveredJid of senderKeyRecipients) {
							if (deliveredJids.has(deliveredJid)) {
								senderKeyMap[deliveredJid] = true
							}
						}

						participants.push(...result.nodes)
					} catch (err) {
						logger.warn(
							{ err, jid: destinationJid },
							'aunu: sender-key distribution failed; sending the group message to existing key holders only'
						)
					}
				}

				binaryNodeContent.push({
					tag: 'enc',
					attrs: { v: '2', type: 'skmsg', ...extraAttrs },
					content: ciphertext
				})

				// AunuBaileys (1.0.78, HB-132/HB-155, re-applied P3b):
				// persist the map only when it was actually loaded from
				// the store (same condition as the load above). A
				// participant-targeted send starts from {} without
				// loading, so writing its partial map back overwrote the
				// full memo — and silently undid sendMessagesAgain's
				// deliberate null, which exists to force a full
				// redistribution on the next normal send.
				if (!participant && !isStatus) {
					// AunuBaileys (2.2.0, HB-71 addendum): the map used
					// to be persisted HERE, inside the transaction —
					// before the stanza was even built, let alone
					// sent. A sendNode failure after this point left
					// the devices marked as key-holders for a message
					// that never left, and they were never offered
					// the key again. Defer the write until the send
					// has actually succeeded (tail of relayMessage).
					const mapToPersist = senderKeyMap
					persistSenderKeyMemory = async () => {
						await authState.keys.set({ 'sender-key-memory': { [jid]: mapToPersist } })
					}
				}
			} else {
				// ADDRESSING CONSISTENCY: Match own identity to conversation context
				// TODO: investigate if this is true
				let ownId = meId
				if (isLid && meLid) {
					ownId = meLid
					logger.debug({ to: jid, ownId }, 'Using LID identity for @lid conversation')
				} else {
					logger.debug({ to: jid, ownId }, 'Using PN identity for @s.whatsapp.net conversation')
				}

				// AunuBaileys (2.2.0, HB-282 addendum, site 3): ownId
				// was decoded with a bare non-null assertion — an
				// unparseable own identity crashed the DM branch with
				// a raw TypeError. Fail descriptively instead.
				const ownDecoded = jidDecode(ownId)
				if (!ownDecoded) {
					throw new Boom('Not authenticated', { statusCode: 401 })
				}

				const { user: ownUser } = ownDecoded
				if (!participant) {
					// AunuBaileys (2.3.0, HB-269 addendum 2): the
					// .find dereferenced item.recipientJid without a
					// guard — a null/undefined entry in the per-jid
					// patch array threw a raw TypeError inside the
					// transaction callback and killed the whole DM
					// relay before any device enumeration. Skip bad
					// entries (the sendMessagesAgain pattern); a null
					// first entry falls back to the first usable one
					// and to undefined, which the reporting-token
					// site below already tolerates via ?.
					const patchedForReporting = await patchMessageBeforeSending(message, [jid])
					reportingMessage = Array.isArray(patchedForReporting)
						? patchedForReporting.find(item => item?.recipientJid === jid) ||
							patchedForReporting.find(item => item != null) ||
							undefined
						: patchedForReporting
				}

				if (!isRetryResend) {
					const targetUserServer = isLid ? 'lid' : 's.whatsapp.net'
					devices.push({
						user,
						device: 0,
						jid: jidEncode(user, targetUserServer, 0) // TODO: this entire logic is convoluted and weird.
					})

					if (user !== ownUser) {
						const ownUserServer = isLid ? 'lid' : 's.whatsapp.net'
						const ownUserForAddressing = isLid && meLid ? jidDecode(meLid)!.user : jidDecode(meId)!.user

						devices.push({
							user: ownUserForAddressing,
							device: 0,
							jid: jidEncode(ownUserForAddressing, ownUserServer, 0)
						})
					}

					if (additionalAttributes?.['category'] !== 'peer') {
						// Clear placeholders and enumerate actual devices
						devices.length = 0

						// Use conversation-appropriate sender identity
						const senderIdentity =
							isLid && meLid
								? jidEncode(jidDecode(meLid)?.user!, 'lid', undefined)
								: jidEncode(jidDecode(meId)?.user!, 's.whatsapp.net', undefined)

						// Enumerate devices for sender and target with consistent addressing
						const sessionDevices = await getUSyncDevices([senderIdentity, jid], !!useUserDevicesCache, false)
						devices.push(...sessionDevices)

						logger.debug(
							{
								deviceCount: devices.length,
								devices: devices.map(d => `${d.user}:${d.device}@${jidDecode(d.jid)?.server}`)
							},
							'Device enumeration complete with unified addressing'
						)
					}
				}

				// AunuBaileys (2.1.0, HB-299): mirror the HB-266 group/status guard — when device enumeration resolves nothing, the stanza below would go out with no recipients and relayMessage would still resolve as if sent.
				if (!participant && !devices.length) {
					throw new Boom(
						'relayMessage: no recipient devices resolved for this direct message (empty device enumeration); refusing to send an undeliverable message',
						{ statusCode: 400 }
					)
				}

				const allRecipients: string[] = []
				const meRecipients: string[] = []
				const otherRecipients: string[] = []
				// AunuBaileys (2.3.0, HB-282 addendum, sites 2+4): both
				// own identities were destructured through bare
				// jidDecode(...)! — a malformed stored me.id/me.lid
				// threw a raw TypeError here. The site-3 guard above
				// only validates ownId (meLid on the @lid branch, meId
				// otherwise), so the OTHER identity was never checked.
				// Guard both, consistent with site 3 (Boom 401).
				const mePnDecoded = jidDecode(meId)
				const meLidDecoded = meLid ? jidDecode(meLid) : undefined
				if (!mePnDecoded || (meLid && !meLidDecoded)) {
					throw new Boom('Not authenticated', { statusCode: 401 })
				}

				const { user: mePnUser } = mePnDecoded
				const { user: meLidUser } = meLidDecoded ?? { user: null }

				// AunuBaileys (2.3.0, HB-403): the sender device
				// number — me.id carries it (e.g. :42 for a
				// companion); a bare me.id means the sender IS
				// device 0. jidDecode returns undefined for a
				// device-0 JID, hence the ?? 0 normalisation on
				// both sides.
				const senderDevice = mePnDecoded.device ?? 0
				for (const { user, jid } of devices) {
					// AunuBaileys (2.3.0, HB-403): the skip used to
					// compare raw JID strings — but jidEncode drops
					// device 0, so a device-0 JID IS the bare user
					// JID as a string. me.lid is bare by nature
					// while me.id carries the companion device
					// number, so for LID chats the phone itself
					// (device 0) was skipped as the "exact sender
					// device": the DSM echo to the phone vanished
					// for every LID DM, and a LID self-chat with
					// only device 0 resolved with an empty stanza.
					// Compare the decoded (user, device) pair
					// instead — skip only the device that is
					// actually sending, under either identity
					// (PN or LID addressing of the same device).
					const candidate = jidDecode(jid)
					const isExactSenderDevice =
						!!candidate &&
						(candidate.user === mePnUser || (meLidUser !== null && candidate.user === meLidUser)) &&
						(candidate.device ?? 0) === senderDevice
					if (isExactSenderDevice) {
						logger.debug({ jid, meId, meLid }, 'Skipping exact sender device (whatsmeow pattern)')
						continue
					}

					// Check if this is our device (could match either PN or LID user)
					const isMe = user === mePnUser || user === meLidUser

					if (isMe) {
						meRecipients.push(jid)
					} else {
						otherRecipients.push(jid)
					}

					allRecipients.push(jid)
				}

				// AunuBaileys (2.2.0, HB-299 addendum): the HB-299
				// guard above only fires when NOTHING resolved. When
				// the peer has zero devices but our own devices
				// exist, the stanza went out as an echo only and the
				// send still resolved as delivered. A non-self DM
				// with no peer recipient is undeliverable — fail it
				// (retry resends and participant-targeted sends are
				// excluded: they address their device directly).
				if (!participant && !isRetryResend && user !== ownUser && !otherRecipients.length) {
					throw new Boom(
						'relayMessage: the peer has no recipient devices for this direct message (only own devices resolved); refusing to report an echo-only send as delivered',
						{ statusCode: 400 }
					)
				}

				await assertSessions(allRecipients)

				// AunuBaileys (1.0.83, HB-161, re-applied P3b): the echo
				// to our own devices and the send to the peer used to
				// share one Promise.all — when encrypting for ALL of
				// our own devices failed (createParticipantNodes throws
				// 'All encryptions failed'), the peer's already-encrypted
				// nodes were thrown away with it and the DM never left,
				// even though the peer's sessions were healthy;
				// symmetrically, a total peer failure took the echo down
				// too. The echo is best-effort: settle both sides
				// independently and fail only when the side that must
				// deliver produced nothing.
				const [meSettled, otherSettled] = await Promise.allSettled([
					// For own devices: use DSM if available (1:1 chats only).
					// AunuBaileys (2.3.0, HB-375): the plain message goes
					// through the same patch + DSM-wrap path as the
					// otherRecipients call — passing the pre-built meMsg
					// wrapper as the message to patch left the DSM inner
					// content unpatched (the hook only saw the wrapper).
					createParticipantNodes(meRecipients, message, extraAttrs, meMsg),
					createParticipantNodes(otherRecipients, message, extraAttrs, meMsg)
				])

				if (otherSettled.status === 'rejected') {
					throw otherSettled.reason
				}

				let meNodes: BinaryNode[] = []
				let s1 = false
				if (meSettled.status === 'fulfilled') {
					meNodes = meSettled.value.nodes
					s1 = meSettled.value.shouldIncludeDeviceIdentity
				} else if (!otherSettled.value.nodes.length && meRecipients.length) {
					// Our own devices were the ONLY recipients (a retry
					// resend aimed at our own device, a self-chat): with
					// the echo gone there is nothing to send — keep the
					// original failure instead of emitting an empty stanza.
					throw meSettled.reason
				} else {
					logger.warn({ err: meSettled.reason }, 'aunu: echo to own devices failed; sending to the peer without it')
				}

				const { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 } = otherSettled.value
				participants.push(...meNodes)
				participants.push(...otherNodes)

				if (meRecipients.length > 0 || otherRecipients.length > 0) {
					extraAttrs['phash'] = generateParticipantHashV2([...meRecipients, ...otherRecipients])
				}

				shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
			}

			if (isRetryResend) {
				const isParticipantLid = isLidUser(participant!.jid)
				const isMe = areJidsSameUser(participant!.jid, isParticipantLid ? meLid : meId)

				let messageToSend = message
				if (isGroupOrStatus) {
					let groupSenderIdentity: string | undefined
					if (meLid && (await signalRepository.hasSenderKey({ group: destinationJid, meId: meLid }))) {
						groupSenderIdentity = meLid
					} else if (await signalRepository.hasSenderKey({ group: destinationJid, meId })) {
						groupSenderIdentity = meId
					}

					if (groupSenderIdentity) {
						try {
							const skdm = await signalRepository.getSenderKeyDistributionMessage({
								group: destinationJid,
								meId: groupSenderIdentity
							})
							messageToSend = {
								...message,
								senderKeyDistributionMessage: {
									groupId: destinationJid,
									axolotlSenderKeyDistributionMessage: skdm
								}
							}
						} catch (err) {
							logger.warn({ err, jid: destinationJid }, 'failed to build SKDM for retry, sending without it')
						}
					}
				}

				const encodedMessageToSend = isMe
					? encodeWAMessage({
							deviceSentMessage: {
								destinationJid,
								message: messageToSend
							}
						})
					: encodeWAMessage(messageToSend)

				// AunuBaileys (2.3.0, HB-400): the fan-out used to
				// assert the participant's session as a side effect of
				// encrypting for them; with the fan-out push gone, the
				// retry encryption asserts it explicitly.
				await assertSessions([participant!.jid])

				const { type, ciphertext: encryptedContent } = await signalRepository.encryptMessage({
					data: encodedMessageToSend,
					jid: participant!.jid
				})

				binaryNodeContent.push({
					tag: 'enc',
					attrs: {
						v: '2',
						type,
						count: participant!.count.toString()
					},
					content: encryptedContent
				})
			}

			if (participants.length) {
				if (additionalAttributes?.['category'] === 'peer') {
					const peerNode = participants[0]?.content?.[0] as BinaryNode
					if (peerNode) {
						binaryNodeContent.push(peerNode) // push only enc
					}
				} else {
					binaryNodeContent.push({
						tag: 'participants',
						attrs: {},

						content: participants
					})
				}
			}

			const stanza: BinaryNode = {
				tag: 'message',
				attrs: {
					id: msgId,
					to: destinationJid,
					type: getMessageType(message),
					...(additionalAttributes || {})
				},
				content: binaryNodeContent
			}

			// if the participant to send to is explicitly specified (generally retry recp)
			// ensure the message is only sent to that person
			// if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
			if (participant) {
				if (isJidGroup(destinationJid)) {
					stanza.attrs.to = destinationJid
					stanza.attrs.participant = participant.jid
				} else if (areJidsSameUser(participant.jid, meId)) {
					stanza.attrs.to = participant.jid
					stanza.attrs.recipient = destinationJid
				} else {
					stanza.attrs.to = participant.jid
				}
			} else {
				stanza.attrs.to = destinationJid
			}

			if (shouldIncludeDeviceIdentity) {
				;(stanza.content as BinaryNode[]).push({
					tag: 'device-identity',
					attrs: {},
					content: encodeSignedDeviceIdentity(authState.creds.account!, true)
				})

				logger.debug({ jid }, 'adding device identity')
			}

			if (
				!isNewsletter &&
				!isRetryResend &&
				reportingMessage?.messageContextInfo?.messageSecret &&
				shouldIncludeReportingToken(reportingMessage)
			) {
				try {
					const encoded = encodeWAMessage(reportingMessage)
					const reportingKey: WAMessageKey = {
						id: msgId,
						fromMe: true,
						remoteJid: destinationJid,
						participant: participant?.jid
					}
					const reportingNode = await getMessageReportingToken(encoded, reportingMessage, reportingKey)
					if (reportingNode) {
						;(stanza.content as BinaryNode[]).push(reportingNode)
						logger.trace({ jid }, 'added reporting token to message')
					}
				} catch (error: any) {
					logger.warn({ jid, trace: error?.stack }, 'failed to attach reporting token')
				}
			}

			// WA Web never attaches tctoken to peer (AppStateSync) messages — server rejects with 479
			const isPeerMessage = additionalAttributes?.['category'] === 'peer'
			const is1on1Send = !isGroup && !isRetryResend && !isStatus && !isNewsletter && !isPeerMessage

			// Resolve destination to LID for tctoken storage — matches Signal session key pattern
			const tcTokenJid = is1on1Send ? await resolveTcTokenJid(destinationJid, getLIDForPN) : destinationJid
			const contactTcTokenData = is1on1Send ? await authState.keys.get('tctoken', [tcTokenJid]) : {}
			const existingTokenEntry = contactTcTokenData[tcTokenJid]
			let tcTokenBuffer = existingTokenEntry?.token

			// Treat expired tokens the same as missing — clear from cache
			if (tcTokenBuffer?.length && isTcTokenExpired(existingTokenEntry?.timestamp)) {
				logger.debug({ jid: destinationJid, timestamp: existingTokenEntry?.timestamp }, 'tctoken expired, clearing')
				tcTokenBuffer = undefined
				// Preserve senderTimestamp so the fire-and-forget issuance dedupe survives cleanup.
				const cleared =
					existingTokenEntry?.senderTimestamp !== undefined
						? { token: Buffer.alloc(0), senderTimestamp: existingTokenEntry.senderTimestamp }
						: null
				try {
					await authState.keys.set({ tctoken: { [tcTokenJid]: cleared } })
				} catch (err: any) {
					logger.debug({ jid: destinationJid, err: err?.message }, 'failed to persist tctoken expiry cleanup')
				}
			}

			if (tcTokenBuffer?.length && sock.serverProps.privacyTokenOn1to1) {
				;(stanza.content as BinaryNode[]).push({
					tag: 'tctoken',
					attrs: {},
					content: tcTokenBuffer
				})
			}

			if (additionalNodes && additionalNodes.length > 0) {
				;(stanza.content as BinaryNode[]).push(...additionalNodes)
			}

			logger.debug({ msgId }, `sending message to ${participants.length} devices`)

			// AunuBaileys (1.0.83, HB-178, re-applied P3b): captured, not sent —
			// the stanza goes on the wire only AFTER the transaction commits
			// (see the tail of relayMessage), and the sent-message cache add +
			// message-secret registration move there with it: with the old
			// send-inside-transaction order, a commit that failed through every
			// retry threw after the message was already delivered — the caller
			// saw an error for a delivered message (and a host retry produced a
			// duplicate the peer could not decrypt, re-using the un-persisted
			// chain key), while the cache add and the secret registration were
			// skipped for that delivered message.
			stanzaToSend = stanza

			// Fire-and-forget: issue our token to the contact AFTER message send.
			// WA Web skips protocol messages and PSA/bot contacts (TcTokenChatAction: isRegularUser)
			const isProtocolMsg = !!normalizeMessageContent(message)?.protocolMessage
			const isBotOrPSA = destinationJid === PSA_WID || isJidBot(destinationJid) || isJidMetaAI(destinationJid)
			if (
				is1on1Send &&
				!isProtocolMsg &&
				!isBotOrPSA &&
				shouldSendNewTcToken(existingTokenEntry?.senderTimestamp) &&
				!inFlightTcTokenIssuance.has(tcTokenJid)
			) {
				inFlightTcTokenIssuance.add(tcTokenJid)
				const issueTimestamp = unixTimestampSeconds()
				const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping)
				resolveIssuanceJid(destinationJid, sock.serverProps.lidTrustedTokenIssueToLid, getLIDForPN, getPNForLID)
					.then(issueJid => issuePrivacyTokens([issueJid], issueTimestamp))
					.then(async result => {
						await storeTcTokensFromIqResult({
							result,
							fallbackJid: tcTokenJid,
							keys: authState.keys,
							getLIDForPN
						})

						const currentData = await authState.keys.get('tctoken', [tcTokenJid])
						const currentEntry = currentData[tcTokenJid]
						const indexWrite = await buildMergedTcTokenIndexWrite(authState.keys, [tcTokenJid])
						await authState.keys.set({
							tctoken: {
								[tcTokenJid]: {
									token: Buffer.alloc(0),
									...currentEntry,
									senderTimestamp: issueTimestamp
								},
								...indexWrite
							}
						})
					})
					.catch(err => {
						logger.debug({ jid: destinationJid, err: err?.message }, 'fire-and-forget tctoken issuance failed')
					})
					.finally(() => {
						inFlightTcTokenIssuance.delete(tcTokenJid)
					})
			}

		}, meId)

		// AunuBaileys (1.0.83, HB-178, re-applied P3b): the stanza goes on the
		// wire only now — AFTER the transaction above has committed the
		// ratchet state it was encrypted under. Persist first, then send: a
		// commit failure now fails a message that was never sent, and a sent
		// message is always registered (sent-message cache, message secret,
		// retry-manager recent list).
		if (stanzaToSend) {
			await sendNode(stanzaToSend)
			// AunuBaileys (2.2.0, HB-71 addendum): only now — the
			// stanza is on the wire — may the sender-key-memory map
			// be persisted (see the group branch).
			// AunuBaileys (2.3.0, HB-387): the persist used to be a
			// BARE await — a host store failure rejected relayMessage
			// for a message already on the wire AND skipped the
			// sent-message cache, message-secret registration and
			// retry-manager entry below. The in-memory map stays
			// correct for this session and a restart redistributes,
			// so a persist failure is a warning, never a failed send.
			if (persistSenderKeyMemory) {
				try {
					await persistSenderKeyMemory()
				} catch (err) {
					logger.warn({ err }, 'aunu: failed to persist sender-key memory after a successful send; continuing')
				}
			}

			sentMessageCacheFor(config).add(jid, msgId, message)
			if (message.messageContextInfo?.messageSecret) {
				setBotMessageSecret(msgId, message.messageContextInfo.messageSecret, jid)
			}

			if (messageRetryManager && !participant) {
				messageRetryManager.addRecentMessage(destinationJid, msgId, message)
			}
		}

		return msgId
	}

	const getMessageType = (message: waproto.IMessage) => {
		const normalizedMessage = normalizeMessageContent(message)
		if (!normalizedMessage) return 'text'

		if (normalizedMessage.reactionMessage || normalizedMessage.encReactionMessage) {
			return 'reaction'
		}

		if (
			normalizedMessage.pollCreationMessage ||
			normalizedMessage.pollCreationMessageV2 ||
			normalizedMessage.pollCreationMessageV3 ||
			normalizedMessage.pollUpdateMessage
		) {
			return 'poll'
		}

		if (normalizedMessage.eventMessage) {
			return 'event'
		}

		if (getMediaType(normalizedMessage) !== '') {
			return 'media'
		}

		return 'text'
	}

	const getMediaType = (message: waproto.IMessage) => {
		if (message.imageMessage) {
			return 'image'
		} else if (message.videoMessage) {
			return message.videoMessage.gifPlayback ? 'gif' : 'video'
		} else if (message.audioMessage) {
			return message.audioMessage.ptt ? 'ptt' : 'audio'
		} else if (message.contactMessage) {
			return 'vcard'
		} else if (message.documentMessage) {
			return 'document'
		} else if (message.contactsArrayMessage) {
			return 'contact_array'
		} else if (message.liveLocationMessage) {
			return 'livelocation'
		} else if (message.stickerMessage) {
			return 'sticker'
		} else if (message.listMessage) {
			return 'list'
		} else if (message.listResponseMessage) {
			return 'list_response'
		} else if (message.buttonsResponseMessage) {
			return 'buttons_response'
		} else if (message.orderMessage) {
			return 'order'
		} else if (message.productMessage) {
			return 'product'
		} else if (message.interactiveResponseMessage) {
			return 'native_flow_response'
		} else if (message.groupInviteMessage) {
			return 'url'
		}

		return ''
	}

	const issuePrivacyTokens = async (jids: string[], timestamp?: number) => {
		const t = (timestamp ?? unixTimestampSeconds()).toString()
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'privacy'
			},
			content: [
				{
					tag: 'tokens',
					attrs: {},
					content: jids.map(jid => ({
						tag: 'token',
						attrs: {
							jid: jidNormalizedUser(jid),
							t,
							type: 'trusted_contact'
						}
					}))
				}
			]
		})

		return result
	}

	const waUploadToServer = getWAUploadToServer(config, refreshMediaConn)

	const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update')

	registerSocketEndHandler(() => {
		if (!config.userDevicesCache && userDevicesCache.close) {
			userDevicesCache.close()
		}

		mediaConn = undefined
		if (messageRetryManager) {
			// AunuBaileys (2.2.0, HB-346): close(), not clear() —
			// clear() left the four InternalCache purge timers
			// running for the life of the process.
			messageRetryManager.close()
		}
	})

	return {
		...sock,
		userDevicesCache,
		devicesMutex,
		issuePrivacyTokens,
		assertSessions,
		relayMessage,
		sendReceipt,
		sendReceipts,
		readMessages,
		refreshMediaConn,
		// Function (not getter) so the spread in chats.ts preserves the live closure binding.
		getMediaHost: () => mediaHost,
		waUploadToServer,
		fetchPrivacySettings,
		sendPeerDataOperationMessage,
		createParticipantNodes,
		getUSyncDevices,
		messageRetryManager,
		updateMemberLabel,
		updateMediaMessage: async (message: WAMessage) => {
			const content = assertMediaContent(message.message)
			const mediaKey = content.mediaKey!
			// AunuBaileys (1.0.71, HB-22 remainder, re-applied P3b):
			// this read sat ahead of relayMessage's guard and threw a
			// raw TypeError when called before pairing completed.
			const meId = authState.creds.me?.id
			if (!meId) {
				throw new Boom('Not authenticated')
			}
			const node = encryptMediaRetryRequest(message.key, mediaKey, meId)

			let error: Error | undefined = undefined
			await Promise.all([
				sendNode(node),
				// AunuBaileys (HB-294, donor v6 HB-20): this wait used to
				// be unbounded — a peer that never sends a media-update
				// hung the caller forever and leaked the wait's two
				// listeners per call. Bound it to 120s.
				waitForMsgMediaUpdate(async update => {
					const result = update.find(c => c.key.id === message.key.id)
					if (result) {
						if (result.error) {
							error = result.error
						} else {
							try {
								const media = decryptMediaRetryData(result.media!, mediaKey, result.key.id!)
								if (media.result !== waproto.MediaRetryNotification.ResultType.SUCCESS) {
									const resultStr = waproto.MediaRetryNotification.ResultType[media.result!]
									throw new Boom(`Media re-upload failed by device (${resultStr})`, {
										data: media,
										statusCode: getStatusCodeForMediaRetry(media.result!) || 404
									})
								}

								content.directPath = media.directPath
								content.url = getUrlFromDirectPath(content.directPath!, mediaHost)

								logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful')
							} catch (err: any) {
								error = err
							}
						}

						return true
					}
				}, 120_000)
			])

			if (error) {
				throw error
			}

			ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }])

			return message
		},
		sendMessage: async (jid: string, content: AnyMessageContent, options: MiscMessageGenerationOptions = {}) => {
			// AunuBaileys (1.0.71, HB-22 remainder, re-applied P3b):
			// same guard as relayMessage, applied at the public entry
			// point — a bare me!.id read threw a raw TypeError when
			// called before pairing completed. (relayMessage itself
			// is guarded by assertMeId in this tree.)
			const userJid = authState.creds.me?.id
			if (!userJid) {
				throw new Boom('Not authenticated')
			}
			if (
				typeof content === 'object' &&
				'disappearingMessagesInChat' in content &&
				typeof content['disappearingMessagesInChat'] !== 'undefined' &&
				isJidGroup(jid)
			) {
				const { disappearingMessagesInChat } = content
				const value =
					typeof disappearingMessagesInChat === 'boolean'
						? disappearingMessagesInChat
							? WA_DEFAULT_EPHEMERAL
							: 0
						: disappearingMessagesInChat
				await groupToggleEphemeral(jid, value)
			} else {
				const fullMsg = await generateWAMessage(jid, content, {
					logger,
					userJid,
					getUrlInfo: text =>
						getUrlInfo(text, {
							thumbnailWidth: linkPreviewImageThumbnailWidth,
							fetchOpts: {
								timeout: 3_000,
								...(httpRequestOptions || {})
							},
							logger,
							uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
						}),
					//TODO: CACHE
					getProfilePicUrl: sock.profilePictureUrl,
					getCallLink: sock.createCallLink,
					upload: waUploadToServer,
					mediaCache: config.mediaCache,
					options: config.options,
					messageId: generateMessageIDV2(sock.user?.id),
					...options
				})
				const isEventMsg = 'event' in content && !!content.event
				const isDeleteMsg = 'delete' in content && !!content.delete
				const isEditMsg = 'edit' in content && !!content.edit
				const isPinMsg = 'pin' in content && !!content.pin
				const isPollMessage = 'poll' in content && !!content.poll
				const isAiMsg = 'ai' in content && !!content.ai
				const additionalAttributes: BinaryNodeAttributes = {}
				const additionalNodes: BinaryNode[] = []
				// required for delete
				if (isDeleteMsg) {
					// if the chat is a group, and I am not the author, then delete the message as an admin
					if (isJidGroup(content.delete?.remoteJid as string) && !content.delete?.fromMe) {
						additionalAttributes.edit = '8'
					} else {
						additionalAttributes.edit = '7'
					}
				} else if (isEditMsg) {
					additionalAttributes.edit = '1'
				} else if (isPinMsg) {
					additionalAttributes.edit = '2'
				} else if (isPollMessage) {
					additionalNodes.push({
						tag: 'meta',
						attrs: {
							polltype: 'creation'
						}
					} as BinaryNode)
				} else if (isEventMsg) {
					additionalNodes.push({
						tag: 'meta',
						attrs: {
							event_type: 'creation'
						}
					} as BinaryNode)
				} else if (isAiMsg) {
					// AunuBaileys: AI label (from @itsliaaa/baileys) — private
					// chats only. P2e port from v6: this send-path branch did
					// not exist in v7, so `ai: true` was silently ignored.
					// (v6's isJidUser is isPnUser in the v7 jid-utils split.)
					if (!(isPnUser(jid) || isLidUser(jid))) {
						throw new Boom('AI icon on message are only allowed in private chat', { statusCode: 400 })
					}

					if (fullMsg.message?.messageContextInfo) {
						fullMsg.message.messageContextInfo.supportPayload = BIZ_BOT_SUPPORT_PAYLOAD
					}

					additionalNodes.push({
						tag: 'bot',
						attrs: { biz_bot: '1' },
						content: undefined
					} as BinaryNode)
					// AunuBaileys (1.0.72, HB-63): the ai flag used to be
					// deleted from the CALLER's content object here —
					// reusing the same object for a second send silently
					// lost the AI label. The flag is already consumed
					// above; the caller's object stays intact.
				}

				await relayMessage(jid, fullMsg.message!, {
					messageId: fullMsg.key.id!,
					useCachedGroupMetadata: options.useCachedGroupMetadata,
					additionalAttributes,
					statusJidList: options.statusJidList,
					additionalNodes
				})
				if (config.emitOwnEvents) {
					process.nextTick(async () => {
						await messageMutex.mutex(() => upsertMessage(fullMsg, 'append'))
					})
				}

				return fullMsg
			}
		}
	}
}

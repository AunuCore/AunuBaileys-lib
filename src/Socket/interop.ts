// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
import { getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } from '../WABinary/index.js'
import { executeWMexQuery } from './mex.js'

// AunuBaileys (1.0.71): interoperability (BirdyChat / Haiket), ported
// from @violetix/baileys lib/Socket/interop.js. MEX query IDs verbatim
// from the donor (source per the donor:
// whatsapp-android-mex_client_persist_ids.json, WA 2.26.26.4 APK assets).
const INTEROP_MEX_QUERY_IDS = {
	CREATE_GROUP: '25726817620301611', // GroupsCreateInteropGroup
	LEAVE_GROUP: '25346167795013271', // LeaveInteropGroup
	ADD_PARTICIPANTS: '25732168276369451', // AddParticipantsToInteropGroup
	QUERY_GROUP_INFO: '32734144032867938', // QueryInteropGroupInfo
	PRIVACY_SETTINGS_QUERY: '24849123668112654', // InteropPrivacySettingsQuery
	PRIVACY_SETTINGS_UPDATE: '25421856497452763', // InteropPrivacySettingsUpdate
	PRIVACY_SETTINGS_WITH_CONTACT_LIST: '24913399124998598' // InteropPrivacySettingWithContactListUpdate
}
/** Known integrator IDs (assigned by WhatsApp). */
export const INTEGRATOR_BIRDYCHAT = 12
export const INTEGRATOR_HAIKET = 13
/** TOS trackable results sent by WA on first interop opt-in. */
const TOS_TRACKABLE_ID = '20240306'
const TOS_RESULT_SHOWN = '105'
const TOS_RESULT_ACCEPTED = '160'
/** Maximum users per batch lookup (enforced server-side too). */
const INTEROP_BATCH_MAX = 256
// Wire form (donor lib/WABinary/decode.js readInteropJid):
// `${integrator}-${user}:${device}@${server}`, server defaults 'interop'.
// The user part is the external identifier: email for BirdyChat (12),
// phone-number string for Haiket (13).
const INTEROP_JID_RE = /^(\d+)-([^:]+):(\d+)@(.+)$/
/** True when the JID is an interop address (server 'interop'). */
export const isInteropJid = jid => {
	if (typeof jid !== 'string') {
		return false
	}
	const m = INTEROP_JID_RE.exec(jid)
	return !!m && m[4] === 'interop'
}
/**
 * Parse an interop JID into { integratorId, externalId, device, server }.
 * Returns null for non-interop JIDs. integratorId 12 = BirdyChat,
 * 13 = Haiket; externalId is the email (BirdyChat) or phone string (Haiket).
 */
export const parseInteropJid = jid => {
	if (typeof jid !== 'string') {
		return null
	}
	const m = INTEROP_JID_RE.exec(jid)
	if (!m || m[4] !== 'interop') {
		return null
	}
	return {
		integratorId: parseInt(m[1], 10),
		externalId: m[2],
		device: parseInt(m[3], 10),
		server: m[4]
	}
}
export const makeInteropSocket = sock => {
	const { ev, query, generateMessageTag, logger, signalRepository } = sock
	const mexQuery = (variables, queryId, dataPath) =>
		executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag)
	// AunuBaileys (1.0.71): recognition — every inbound upsert carrying an
	// interop address is re-emitted as an 'interop' event so hosts can
	// route BirdyChat/Haiket traffic without sniffing JIDs themselves.
	ev.on('messages.upsert', upsert => {
		try {
			const messages = (upsert?.messages || []).filter(
				m => isInteropJid(m?.key?.remoteJid) || isInteropJid(m?.key?.participant)
			)
			if (messages.length) {
				ev.emit('interop', { type: 'message', messages })
			}
		} catch {
			// recognition must never break message handling
		}
	})
	/**
	 * Fetch all available interop integrators from the server.
	 * Each integrator carries: id, name, status, icon, identifierType,
	 * optedIn, features.groupMessaging.
	 * status can be "active" | "onboarding" | "removed".
	 */
	const fetchIntegrators = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				type: 'get',
				xmlns: 'w:interop',
				to: S_WHATSAPP_NET
			},
			content: [{ tag: 'integrator', attrs: { fetch: 'all' } }]
		})
		const listNode = getBinaryNodeChild(result, 'integrator_list')
		if (!listNode) {
			return []
		}
		const globalOptedIn = listNode.attrs?.opted_in === 'true'
		return getBinaryNodeChildren(listNode, 'integrator').map(node => {
			const featuresNode = getBinaryNodeChild(node, 'features')
			return {
				id: parseInt(node.attrs.id, 10),
				name: node.attrs.name,
				status: node.attrs.status,
				icon: node.attrs.icon,
				identifierType: node.attrs.identifier_type,
				optedIn: node.attrs.opted_in === 'true' || globalOptedIn,
				features: {
					groupMessaging: featuresNode?.attrs?.group_messaging === 'true'
				}
			}
		})
	}
	/** Send a single TOS trackable item (shown or accepted). */
	const sendTOSTrackable = async (id, result) => {
		await query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'tos' },
			content: [{ tag: 'trackable', attrs: { id, result } }]
		})
	}
	/** Accept TOS for interop (shown 105, then accepted 160). Must be called before opting in. */
	const acceptInteropTOS = async () => {
		await sendTOSTrackable(TOS_TRACKABLE_ID, TOS_RESULT_SHOWN)
		await sendTOSTrackable(TOS_TRACKABLE_ID, TOS_RESULT_ACCEPTED)
	}
	/** Opt in to a list of integrators (by numeric ID). Defaults to BirdyChat + Haiket. */
	const optInIntegrators = async (integratorIds = [INTEGRATOR_BIRDYCHAT, INTEGRATOR_HAIKET]) => {
		await query({
			tag: 'iq',
			attrs: { type: 'set', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [
				{
					tag: 'opt_in_integrators',
					attrs: {},
					content: [
						{
							tag: 'integrator_list',
							attrs: {},
							content: integratorIds.map(id => ({
								tag: 'integrator',
								attrs: { id: id.toString() }
							}))
						}
					]
				}
			]
		})
	}
	/** Opt out of a list of integrators (by numeric ID). Mirror of optInIntegrators. */
	const optOutIntegrators = async (integratorIds = [INTEGRATOR_BIRDYCHAT, INTEGRATOR_HAIKET]) => {
		await query({
			tag: 'iq',
			attrs: { type: 'set', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [
				{
					tag: 'opt_out_integrators',
					attrs: {},
					content: [
						{
							tag: 'integrator_list',
							attrs: {},
							content: integratorIds.map(id => ({
								tag: 'integrator',
								attrs: { id: id.toString() }
							}))
						}
					]
				}
			]
		})
	}
	/**
	 * Resolve one or more interop users by external ID in a single IQ.
	 * Each entry: { externalId, integratorId } — BirdyChat (12): email;
	 * Haiket (13): phone number string (e.g. "19146088152").
	 * Max 256 entries per call (server limit).
	 */
	const resolveInteropUsers = async users => {
		if (!users || users.length === 0) {
			return []
		}
		if (users.length > INTEROP_BATCH_MAX) {
			throw new Error(`resolveInteropUsers: max ${INTEROP_BATCH_MAX} users per request`)
		}
		const result = await query({
			tag: 'iq',
			attrs: { type: 'get', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [
				{
					tag: 'users',
					attrs: {},
					content: users.map(({ externalId, integratorId }) => ({
						tag: 'user',
						attrs: {
							external_id: externalId,
							integrator_id: integratorId.toString()
						}
					}))
				}
			]
		})
		const usersNode = getBinaryNodeChild(result, 'users')
		if (!usersNode) {
			return []
		}
		return getBinaryNodeChildren(usersNode, 'user').map(userNode => {
			const errorNode = getBinaryNodeChild(userNode, 'error')
			if (errorNode) {
				return {
					externalId: userNode.attrs.external_id,
					integratorId: parseInt(userNode.attrs.integrator_id, 10),
					error: {
						code: parseInt(errorNode.attrs.code, 10),
						text: errorNode.attrs.text
					}
				}
			}
			return {
				jid: userNode.attrs.jid,
				externalId: userNode.attrs.external_id,
				normalizedExternalId: userNode.attrs.normalized_external_id,
				integratorId: parseInt(userNode.attrs.integrator_id, 10)
			}
		})
	}
	/** Convenience wrapper: resolve a single interop user. Returns the result object or null. */
	const resolveInteropUser = async (externalId, integratorId) => {
		const results = await resolveInteropUsers([{ externalId, integratorId }])
		return results[0] ?? null
	}
	/** Get reachability settings for interop contacts (interop presence/subscription mechanism). */
	const getReachabilitySettings = async () => {
		const result = await query({
			tag: 'iq',
			attrs: { type: 'get', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [{ tag: 'reachability_settings', attrs: {} }]
		})
		const settingsNode = getBinaryNodeChild(result, 'reachability_settings')
		if (!settingsNode) {
			return null
		}
		return {
			enabled: settingsNode.attrs?.enabled,
			users: getBinaryNodeChildren(settingsNode, 'user').map(n => ({
				externalId: n.attrs.external_id,
				integratorId: parseInt(n.attrs.integrator_id, 10),
				jid: n.attrs.jid
			}))
		}
	}
	/** Set reachability settings (subscribe to presence) for interop contacts. */
	const setReachabilitySettings = async (users, enabled = 'true') => {
		await query({
			tag: 'iq',
			attrs: { type: 'set', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [
				{
					tag: 'reachability_settings',
					attrs: { enabled },
					content: users.map(({ externalId, integratorId }) => ({
						tag: 'user',
						attrs: {
							external_id: externalId,
							integrator_id: integratorId.toString()
						}
					}))
				}
			]
		})
	}
	/** Block or unblock an interop user via the w:interop blocklist (not the regular WA block). */
	const updateInteropBlockStatus = async (jid, action) => {
		await query({
			tag: 'iq',
			attrs: { type: 'set', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [
				{
					tag: 'blocklist',
					attrs: {},
					content: [{ tag: 'item', attrs: { action, jid } }]
				}
			]
		})
	}
	const blockInteropUser = jid => updateInteropBlockStatus(jid, 'block')
	const unblockInteropUser = jid => updateInteropBlockStatus(jid, 'unblock')
	/** Report an interop contact as spam. spam_flow="account_info_block" = block + report (WA Web default). */
	const reportInteropSpam = async (jid, spamFlow = 'account_info_block') => {
		await query({
			tag: 'iq',
			attrs: { type: 'set', xmlns: 'spam', to: S_WHATSAPP_NET },
			content: [{ tag: 'spam_list', attrs: { jid, spam_flow: spamFlow } }]
		})
	}
	/** Mark an interop JID as trusted_contact in privacy tokens (WA calls this after the first outgoing message). */
	const trustInteropContact = async jid => {
		const t = Math.floor(Date.now() / 1000).toString()
		await query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, xmlns: 'privacy', type: 'set' },
			content: [
				{
					tag: 'tokens',
					attrs: {},
					content: [{ tag: 'token', attrs: { jid, type: 'trusted_contact', t } }]
				}
			]
		})
	}
	/**
	 * Full interop initialization sequence matching WA Web:
	 * 1. Fetch available integrators 2. Accept TOS 3. Opt-in to all
	 * active/onboarding integrators. Silently tolerates TOS/opt-in errors.
	 * NOTE (donor): receiving messages from interop contacts is NOT YET
	 * SUPPORTED on companions — the interop bridge only delivers to
	 * device 0 (primary phone) via a single Signal session.
	 */
	const initInterop = async () => {
		let integrators
		try {
			integrators = await fetchIntegrators()
		} catch (err) {
			logger?.warn?.({ err }, 'interop: failed to fetch integrators')
			return []
		}
		const toOptIn = integrators.filter(i => i.status === 'active' || i.status === 'onboarding')
		if (toOptIn.length === 0) {
			return integrators
		}
		try {
			await acceptInteropTOS()
		} catch (err) {
			logger?.warn?.({ err }, 'interop: failed to accept TOS')
		}
		try {
			await optInIntegrators(toOptIn.map(i => i.id))
		} catch (err) {
			logger?.warn?.({ err }, 'interop: failed to opt-in integrators')
		}
		logger?.info?.({ integrators: toOptIn.map(i => i.name) }, 'interop: opted in')
		logger?.warn?.(
			{ integrators: toOptIn.map(i => i.name) },
			'interop: receiving messages from interop contacts (BirdyChat/Haiket) is NOT YET SUPPORTED on companions. The interop bridge only delivers to device 0 (primary phone) via a single Signal session — no fan-out to companion devices. Opt-in and sending may work, but inbound messages will not arrive.'
		)
		return integrators
	}
	/** Reset the Signal session with an interop contact and force a fresh pkmsg handshake. */
	const resetInteropSession = async jid => {
		// AunuBaileys (1.0.72): this passed an ARRAY — deleteSession
		// expects a JID string, so every call threw a TypeError and
		// the reset never happened (HB-82).
		await signalRepository.deleteSession(jid)
		logger?.info?.({ jid }, '[interop] session reset — next send will use pkmsg')
	}
	/** Create an interop group via MEX. Donor: input { participants: [{ jid }] }. */
	const createInteropGroup = async participants => {
		const result = await mexQuery(
			{ input: { participants: participants.map(jid => ({ jid })) } },
			INTEROP_MEX_QUERY_IDS.CREATE_GROUP,
			'xwa2_interop_group_create'
		)
		logger?.info?.({ participants }, '[interop] group created via MEX')
		return result
	}
	/** Leave one or more interop groups via MEX (gid = raw group id without @g.us suffix). */
	const leaveInteropGroup = async jids => {
		const ids = Array.isArray(jids) ? jids : [jids]
		const result = await mexQuery(
			{ input: { groups_to_leave: ids.map(jid => ({ gid: jid.split('@')[0] })) } },
			INTEROP_MEX_QUERY_IDS.LEAVE_GROUP,
			'xwa2_interop_group_leave'
		)
		logger?.info?.({ jids: ids }, '[interop] left group(s) via MEX')
		return result
	}
	/** Add participants to an existing interop group via MEX. */
	const addParticipantsToInteropGroup = async (groupJid, participants) => {
		const gid = groupJid.split('@')[0]
		return mexQuery(
			{ input: { gid, participants: participants.map(jid => ({ jid })) } },
			INTEROP_MEX_QUERY_IDS.ADD_PARTICIPANTS,
			'xwa2_interop_add_participants_to_group'
		)
	}
	/** Query info about an interop group via MEX. */
	const queryInteropGroupInfo = async groupJid => {
		const gid = groupJid.split('@')[0]
		return mexQuery({ group_input: { gid } }, INTEROP_MEX_QUERY_IDS.QUERY_GROUP_INFO, 'xwa2_interop_group_query_by_id')
	}
	/** Update an interop privacy setting via MEX. Known feature "GROUPADD"; settings "ALL" | "CONTACTS" | "NONE". */
	const updateInteropPrivacySetting = async (feature, setting) => {
		return mexQuery(
			{ feature, setting },
			INTEROP_MEX_QUERY_IDS.PRIVACY_SETTINGS_UPDATE,
			'xwa2_interop_privacy_setting_update'
		)
	}
	/** Update an interop privacy setting with an explicit contact list via MEX. */
	const updateInteropPrivacySettingWithContactList = async (
		feature,
		setting,
		contacts,
		contactListType,
		dhash = 'none'
	) => {
		return mexQuery(
			{ feature, setting, contacts, contact_list_type: contactListType, dhash },
			INTEROP_MEX_QUERY_IDS.PRIVACY_SETTINGS_WITH_CONTACT_LIST,
			'xwa2_interop_privacy_setting_with_contact_list_update'
		)
	}
	/** Query all interop privacy settings via MEX. */
	const queryInteropPrivacySettings = () =>
		mexQuery({}, INTEROP_MEX_QUERY_IDS.PRIVACY_SETTINGS_QUERY, 'xwa2_interop_privacy_settings')
	/**
	 * Check whether an interop user allows being added to groups (GROUPADD privacy).
	 * Returns true only when the server confirms the user can be added.
	 */
	const getInteropGroupAddPrivacy = async (jid, integratorId) => {
		const result = await query({
			tag: 'iq',
			attrs: { type: 'get', xmlns: 'w:interop', to: S_WHATSAPP_NET },
			content: [
				{
					tag: 'privacy',
					attrs: { feature: 'GROUPADD' },
					content: [
						{
							tag: 'user',
							attrs: {
								jid,
								integrator_id: integratorId.toString()
							}
						}
					]
				}
			]
		})
		const privacyNode = getBinaryNodeChild(result, 'privacy')
		const userNode = getBinaryNodeChild(privacyNode, 'user')
		return userNode?.attrs?.result === 'allowed'
	}
	/**
	 * Minimal interop send path. Validates the address, then delegates to
	 * the normal sendMessage relay (which preserves the 'interop' server
	 * since 1.0.71) and emits an 'interop' event on success.
	 * BEST-EFFORT, UNVERIFIED LIVE: no live interop test vector exists;
	 * USync device discovery for interop JIDs is unproven and the donor
	 * warns inbound delivery does not fan out to companions.
	 */
	const sendInteropMessage = async (jid, content, options) => {
		if (!isInteropJid(jid)) {
			throw new Error(`sendInteropMessage: not an interop JID: ${jid}`)
		}
		const sent = await sock.sendMessage(jid, content, options)
		// AunuBaileys (1.0.81, HB-196): this emit reports a send
		// that has ALREADY succeeded — a throwing 'interop'
		// listener used to reject the promise anyway, so the
		// caller saw a failure and retried, duplicating a
		// delivered message. Log the listener error and return
		// the send result.
		try {
			ev.emit('interop', { type: 'message.sent', jid, id: sent?.key?.id })
		} catch (err) {
			logger?.error?.({ err }, 'interop: error in message.sent listener')
		}
		return sent
	}
	return {
		...sock,
		isInteropJid,
		parseInteropJid,
		fetchIntegrators,
		acceptInteropTOS,
		optInIntegrators,
		optOutIntegrators,
		resolveInteropUser,
		resolveInteropUsers,
		getReachabilitySettings,
		setReachabilitySettings,
		blockInteropUser,
		unblockInteropUser,
		reportInteropSpam,
		trustInteropContact,
		initInterop,
		resetInteropSession,
		createInteropGroup,
		leaveInteropGroup,
		addParticipantsToInteropGroup,
		queryInteropGroupInfo,
		queryInteropPrivacySettings,
		updateInteropPrivacySetting,
		updateInteropPrivacySettingWithContactList,
		getInteropGroupAddPrivacy,
		sendInteropMessage,
		INTEGRATOR_BIRDYCHAT,
		INTEGRATOR_HAIKET,
		INTEROP_MEX_QUERY_IDS
	}
}

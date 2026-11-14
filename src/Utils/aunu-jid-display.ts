// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
/**
 * AunuBaileys (1.0.71): LID -> PN display normalisation — pure util.
 *
 * Our LID layer (jidNormalizedUser + the LID store) already maps LIDs to
 * PNs for routing; what it never had is DISPLAY normalisation: turning
 * the LIDs that show up in a received message's key / mentions into the
 * phone-number JIDs a human (or a host matching against a contact list)
 * expects to see. This module is that layer: hints from the message key
 * (alt fields) and from group participant data, then an injected
 * resolver (e.g. lidStore.getPNForLID / signalRepository lidMapping),
 * plus an opt-in debug trace (LID_PN_DEBUG=1).
 *
 * Deliberate deviation from the donor: there is NO fabricated fallback.
 * A LID is not a phone number, so mapping an unmapped LID to
 * "<lid-user>@s.whatsapp.net" would invent a PN that belongs to nobody
 * (or worse, to someone else). An unmapped LID is left as-is.
 */
import { jidDecode } from '../WABinary/index.js'

const isLidJid = jid => typeof jid === 'string' && (jid.endsWith('@lid') || jid.endsWith('@hosted.lid'))
const isPnJid = jid => typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@hosted'))

const createLidPnDebug = logger => {
	const enabled = process.env.LID_PN_DEBUG === '1' || process.env.LID_PN_DEBUG === 'true'
	return (phase, payload) => {
		if (!enabled) {
			return
		}
		logger?.debug({ ...payload, phase }, 'lid->pn normalization trace')
	}
}

/** Strip a device suffix (":n") and normalise the server of a PN JID. */
const toDisplayPnJid = jid => {
	if (!jid || typeof jid !== 'string') {
		return jid
	}
	const decoded = jidDecode(jid)
	if (!decoded?.user) {
		return jid
	}
	if (!isPnJid(jid)) {
		return jid
	}
	const user = decoded.user.split(':')[0]
	if (!user) {
		return jid
	}
	const server = decoded.server === 'hosted' ? 'hosted' : 's.whatsapp.net'
	return `${user}@${server}`
}

/**
 * Build LID -> PN hints from a message key's alt fields
 * (participant/participantAlt, remoteJid/remoteJidAlt).
 */
export const buildAunuLidPnHints = key => {
	const hints = new Map()
	if (!key) {
		return hints
	}
	const addHint = (lid, pn) => {
		if (!isLidJid(lid)) {
			return
		}
		if (!isPnJid(pn)) {
			return
		}
		hints.set(lid, pn)
		const lidDecoded = jidDecode(lid)
		const pnDecoded = jidDecode(pn)
		if (lidDecoded?.user && pnDecoded?.user) {
			hints.set(`${lidDecoded.user}@lid`, `${pnDecoded.user}@s.whatsapp.net`)
		}
	}
	addHint(key.participant, key.participantAlt)
	addHint(key.remoteJid, key.remoteJidAlt)
	addHint(key.participantAlt, key.participant)
	addHint(key.remoteJidAlt, key.remoteJid)
	return hints
}

/** Merge LID -> PN hints from group participant data (lid/phoneNumber). */
export const mergeAunuGroupDataHints = (hints, groupData, debug) => {
	if (!groupData?.participants?.length) {
		return
	}
	debug?.('groupData-size', { participants: groupData.participants.length })
	for (const participant of groupData.participants) {
		const lidCandidate = participant?.lid
		const idCandidate = participant?.id
		const pnCandidate = participant?.phoneNumber
		const lid = (isLidJid(lidCandidate) ? lidCandidate : undefined) || (isLidJid(idCandidate) ? idCandidate : undefined)
		const pn = (isPnJid(pnCandidate) ? pnCandidate : undefined) || (isPnJid(idCandidate) ? idCandidate : undefined)
		if (!lid || !pn) {
			continue
		}
		const displayPn = toDisplayPnJid(pn)
		hints.set(lid, displayPn)
		const lidDecoded = jidDecode(lid)
		if (lidDecoded?.user) {
			hints.set(`${lidDecoded.user}@lid`, displayPn)
		}
		debug?.('group-hint', { lid, pn: displayPn })
	}
}

/**
 * Normalise one JID for display: LID -> PN via hints, then via the
 * injected resolver. Non-LIDs pass through untouched; an unmapped LID
 * is returned as-is (never fabricated into a PN).
 * @param {string} jid
 * @param {Map} hints LID -> PN hints
 * @param {function} [resolvePn] async (lidJid) => pnJid | undefined
 * @param {function} [debug] trace logger
 */
export const normalizeAunuToPnJid = async (jid, hints, resolvePn, debug) => {
	if (!jid || typeof jid !== 'string') {
		return jid
	}
	if (!isLidJid(jid)) {
		return jid
	}
	debug?.('input', { lid: jid })
	const hinted = hints?.get(jid)
	if (hinted) {
		const normalized = toDisplayPnJid(hinted)
		debug?.('hint-exact', { lid: jid, hinted, normalized })
		return normalized
	}
	const decoded = jidDecode(jid)
	if (decoded?.user) {
		const userHint = hints?.get(`${decoded.user}@lid`)
		if (userHint) {
			const normalized = toDisplayPnJid(userHint)
			debug?.('hint-user', { lid: jid, userHint, normalized })
			return normalized
		}
	}
	const mapped = await resolvePn?.(jid)
	if (mapped) {
		const normalized = toDisplayPnJid(mapped)
		debug?.('mapping', { lid: jid, mapped, normalized })
		return normalized
	}
	debug?.('unmapped', { lid: jid })
	return jid
}

const normalizeMentionedJidsToPn = async (node, hints, resolvePn, debug) => {
	if (!node || typeof node !== 'object') {
		return
	}
	if (Array.isArray(node)) {
		for (const item of node) {
			await normalizeMentionedJidsToPn(item, hints, resolvePn, debug)
		}
		return
	}
	if (Array.isArray(node.mentionedJid)) {
		const before = [...node.mentionedJid]
		node.mentionedJid = await Promise.all(
			node.mentionedJid.map(jid => normalizeAunuToPnJid(jid, hints, resolvePn, debug))
		)
		debug?.('mentions', { before, after: node.mentionedJid })
	}
	if (typeof node.participant === 'string') {
		const before = node.participant
		node.participant = await normalizeAunuToPnJid(node.participant, hints, resolvePn, debug)
		if (before !== node.participant) {
			debug?.('participant-field', { before, after: node.participant })
		}
	}
	if (typeof node.remoteJid === 'string') {
		const before = node.remoteJid
		node.remoteJid = await normalizeAunuToPnJid(node.remoteJid, hints, resolvePn, debug)
		if (before !== node.remoteJid) {
			debug?.('remoteJid-field', { before, after: node.remoteJid })
		}
	}
	for (const value of Object.values(node)) {
		if (value && typeof value === 'object') {
			await normalizeMentionedJidsToPn(value, hints, resolvePn, debug)
		}
	}
}

/**
 * Normalize mentions in a message array for sending (LID -> PN).
 * @param {string[]} mentions
 * @param {object} [groupData] { participants: [{ lid, id, phoneNumber }] }
 * @param {function} [resolvePn] async (lidJid) => pnJid | undefined
 * @param {object} [logger] pino-style logger for the LID_PN_DEBUG trace
 */
export const normalizeAunuMentionedJidsForSend = async (mentions, groupData, resolvePn, logger) => {
	if (!Array.isArray(mentions)) {
		return mentions
	}
	const debug = createLidPnDebug(logger)
	const hints = new Map()
	mergeAunuGroupDataHints(hints, groupData, debug)
	const normalized = await Promise.all(mentions.map(jid => normalizeAunuToPnJid(jid, hints, resolvePn, debug)))
	debug('send-mentions-result', { before: mentions, after: normalized })
	return normalized
}

/**
 * Normalize a WebMessageInfo's key JIDs and mentionedJids for display
 * (LID -> PN). Mutates the key / message in place (donor behaviour)
 * and returns the same messageInfo.
 * @param {object} messageInfo WebMessageInfo
 * @param {function} [resolvePn] async (lidJid) => pnJid | undefined
 * @param {object} [logger] pino-style logger for the LID_PN_DEBUG trace
 * @param {object} [groupData] { participants: [{ lid, id, phoneNumber }] }
 */
export const normalizeAunuMessageForDisplayJids = async (messageInfo, resolvePn, logger, groupData) => {
	if (!messageInfo?.key) {
		return messageInfo
	}
	const debug = createLidPnDebug(logger)
	const hints = buildAunuLidPnHints(messageInfo.key)
	mergeAunuGroupDataHints(hints, groupData, debug)
	const beforeKey = { ...messageInfo.key }
	messageInfo.key.participant = await normalizeAunuToPnJid(messageInfo.key.participant, hints, resolvePn, debug)
	messageInfo.key.participantAlt = await normalizeAunuToPnJid(messageInfo.key.participantAlt, hints, resolvePn, debug)
	messageInfo.key.remoteJid = await normalizeAunuToPnJid(messageInfo.key.remoteJid, hints, resolvePn, debug)
	messageInfo.key.remoteJidAlt = await normalizeAunuToPnJid(messageInfo.key.remoteJidAlt, hints, resolvePn, debug)
	await normalizeMentionedJidsToPn(messageInfo.message, hints, resolvePn, debug)
	debug('display-key-result', { before: beforeKey, after: messageInfo.key })
	return messageInfo
}

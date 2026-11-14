// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
/**
 * AunuBaileys (1.0.71): crash-payload guard — ORIGINAL implementation
 * written from the AnchorGuard behaviour spec (oversized text/caption,
 * invisible/combining-char runs, control chars, wrapper nesting >= 6,
 * mention bombs, native-flow button abuse, list/carousel/poll/contact
 * floods, invalid lat/lng, AI-rich floods, oversized encoded payload).
 * No elaina-anchorguard source was read or copied.
 *
 * `detectBugMessage` is pure: it never sends, deletes or blocks anything.
 * `attachAunuBugGuard` wires it to a socket — by default it only logs
 * (and emits `aunu.bugGuard`); outbound bug payloads are refused, and
 * revoke / kick / block run ONLY when explicitly enabled in options.
 */
import { Boom } from '@hapi/boom'

/** Thresholds are deliberately conservative: real clients never produce these shapes. */
export const AUNU_BUG_GUARD_LIMITS = {
	maxTextLength: 65536,
	maxEncodedBytes: 3 * 1024 * 1024,
	maxInvisibleChars: 1000,
	maxInvisibleRun: 200,
	maxCombiningRun: 100,
	maxControlChars: 20,
	maxWrapperDepth: 6,
	maxMentions: 100,
	maxGroupMentions: 50,
	maxNativeFlowButtons: 20,
	maxButtonParamsBytes: 65536,
	maxMessageParamsBytes: 65536,
	maxListRows: 100,
	maxCarouselCards: 10,
	maxPollOptions: 12,
	maxContacts: 50,
	maxAIRichSubmessages: 50
}

/** Wrapper keys whose `.message` holds the real content. */
const WRAPPER_KEYS = [
	'ephemeralMessage',
	'viewOnceMessage',
	'viewOnceMessageV2',
	'viewOnceMessageV2Extension',
	'documentWithCaptionMessage',
	'botForwardedMessage',
	'groupMentionedMessage'
]

/** Peels wrapper layers; returns the innermost content and the depth. */
const unwrapAunuBugContent = content => {
	let current = content
	let depth = 0
	while (current && typeof current === 'object' && depth <= 20) {
		const key = WRAPPER_KEYS.find(k => current[k]?.message && typeof current[k].message === 'object')
		if (!key) {
			break
		}
		current = current[key].message
		depth += 1
	}
	return { content: current, depth }
}

/** Text-bearing keys collected for the size / invisible / control checks. */
const TEXT_KEYS = new Set([
	'conversation',
	'text',
	'caption',
	'name',
	'title',
	'body',
	'comment',
	'address',
	'displayName',
	'optionName',
	'vcard'
])

const collectAunuBugStrings = (node, out, budget, depth = 0) => {
	if (!node || typeof node !== 'object' || depth > 8 || out.count >= budget) {
		return
	}
	if (Buffer.isBuffer(node) || node instanceof Uint8Array) {
		return
	}
	for (const [key, value] of Object.entries(node)) {
		if (out.count >= budget) {
			return
		}
		if (typeof value === 'string') {
			if (TEXT_KEYS.has(key)) {
				out.strings.push(value)
				out.count += 1
			}
		} else if (value && typeof value === 'object') {
			collectAunuBugStrings(value, out, budget, depth + 1)
		}
	}
}

/** Collects every array found under `key` anywhere in the tree. */
const findAunuArrays = (node, key, out, depth = 0, seen = new Set()) => {
	if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) {
		return
	}
	if (Buffer.isBuffer(node) || node instanceof Uint8Array) {
		return
	}
	seen.add(node)
	for (const [k, value] of Object.entries(node)) {
		if (k === key && Array.isArray(value)) {
			out.push(value)
		} else if (value && typeof value === 'object') {
			findAunuArrays(value, key, out, depth + 1, seen)
		}
	}
}

/** Collects every object found under `key` anywhere in the tree. */
const findAunuObjects = (node, key, out, depth = 0, seen = new Set()) => {
	if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) {
		return
	}
	if (Buffer.isBuffer(node) || node instanceof Uint8Array) {
		return
	}
	seen.add(node)
	for (const [k, value] of Object.entries(node)) {
		if (k === key && value && typeof value === 'object') {
			out.push(value)
		} else if (value && typeof value === 'object') {
			findAunuObjects(value, key, out, depth + 1, seen)
		}
	}
}

const countInvisible = text => (text.match(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g) || []).length

/**
 * Pure scan. `message` is a WAMessage (`{ key, message }`) or a proto
 * content object (`{ conversation }`, `{ extendedTextMessage }`, ...),
 * or a send-content object (`{ text }`, `{ image, caption }`, ...).
 * Returns `{ isBug, reasons }`; each reason is `code: detail`.
 */
export const detectBugMessage = (message, options = {}) => {
	const limits = { ...AUNU_BUG_GUARD_LIMITS, ...(options.limits || {}) }
	const reasons = []
	const seenCodes = new Set()
	const add = (code, detail) => {
		if (!seenCodes.has(code)) {
			seenCodes.add(code)
			reasons.push(`${code}: ${detail}`)
		}
	}
	const raw = message?.message ?? message ?? {}
	if (!raw || typeof raw !== 'object') {
		return { isBug: false, reasons }
	}
	const { content, depth } = unwrapAunuBugContent(raw)
	if (depth >= limits.maxWrapperDepth) {
		add('deep-nesting', `${depth} wrapper layers (max ${limits.maxWrapperDepth})`)
	}
	// Oversized encoded payload (whole message, wrappers included).
	let encodedBytes = 0
	try {
		encodedBytes = Buffer.byteLength(JSON.stringify(raw))
	} catch {
		encodedBytes = 0
	}
	if (encodedBytes > limits.maxEncodedBytes) {
		add('oversized-encoded', `${encodedBytes} encoded bytes (max ${limits.maxEncodedBytes})`)
	}
	// Text / caption size, invisible & combining runs, control chars.
	const bag = { strings: [], count: 0 }
	collectAunuBugStrings(content, bag, 200)
	for (const text of bag.strings) {
		if (text.length > limits.maxTextLength) {
			add('oversized-text', `${text.length} chars (max ${limits.maxTextLength})`)
		}
		if (countInvisible(text) > limits.maxInvisibleChars) {
			add('invisible-chars', `${countInvisible(text)} invisible chars (max ${limits.maxInvisibleChars})`)
		}
		if (/[\u200B-\u200F\u2060\uFEFF\u00AD]{200,}/.test(text)) {
			add('invisible-run', `invisible-char run of >= ${limits.maxInvisibleRun}`)
		}
		if (/[\u0300-\u036F]{100,}/.test(text)) {
			add('combining-run', `combining-char run of >= ${limits.maxCombiningRun}`)
		}
		const controls = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) || []).length
		if (controls > limits.maxControlChars) {
			add('control-chars', `${controls} control chars (max ${limits.maxControlChars})`)
		}
	}
	// Mention bombs (mentionedJid / groupMentions anywhere in the tree).
	const mentionLists = []
	findAunuArrays(content, 'mentionedJid', mentionLists)
	const mentions = mentionLists.reduce((sum, list) => sum + list.length, 0)
	if (mentions > limits.maxMentions) {
		add('mention-bomb', `${mentions} mentionedJid (max ${limits.maxMentions})`)
	}
	const groupMentionLists = []
	findAunuArrays(content, 'groupMentions', groupMentionLists)
	const groupMentions = groupMentionLists.reduce((sum, list) => sum + list.length, 0)
	if (groupMentions > limits.maxGroupMentions) {
		add('mention-bomb', `${groupMentions} groupMentions (max ${limits.maxGroupMentions})`)
	}
	// Native-flow button abuse.
	const flows = []
	findAunuObjects(content, 'nativeFlowMessage', flows)
	for (const flow of flows) {
		const buttons = Array.isArray(flow.buttons) ? flow.buttons : []
		if (buttons.length > limits.maxNativeFlowButtons) {
			add('native-flow-abuse', `${buttons.length} buttons (max ${limits.maxNativeFlowButtons})`)
		}
		for (const button of buttons) {
			const params = typeof button?.buttonParamsJson === 'string' ? button.buttonParamsJson : ''
			if (params.length > limits.maxButtonParamsBytes) {
				add('native-flow-abuse', `buttonParamsJson ${params.length} bytes (max ${limits.maxButtonParamsBytes})`)
			}
		}
		if (typeof flow.messageParamsJson === 'string' && flow.messageParamsJson.length > limits.maxMessageParamsBytes) {
			add(
				'native-flow-abuse',
				`messageParamsJson ${flow.messageParamsJson.length} bytes (max ${limits.maxMessageParamsBytes})`
			)
		}
	}
	// List / carousel / poll / contact floods.
	const lists = []
	findAunuObjects(content, 'listMessage', lists)
	for (const list of lists) {
		const rows = (Array.isArray(list.sections) ? list.sections : []).reduce(
			(sum, section) => sum + (Array.isArray(section?.rows) ? section.rows.length : 0),
			0
		)
		if (rows > limits.maxListRows) {
			add('list-flood', `${rows} list rows (max ${limits.maxListRows})`)
		}
	}
	const carousels = []
	findAunuObjects(content, 'carouselMessage', carousels)
	for (const carousel of carousels) {
		if (Array.isArray(carousel.cards) && carousel.cards.length > limits.maxCarouselCards) {
			add('carousel-flood', `${carousel.cards.length} cards (max ${limits.maxCarouselCards})`)
		}
	}
	for (const pollKey of [
		'pollCreationMessage',
		'pollCreationMessageV2',
		'pollCreationMessageV3',
		'pollCreationMessageV5',
		'pollCreationMessageV6'
	]) {
		const polls = []
		findAunuObjects(content, pollKey, polls)
		for (const poll of polls) {
			if (Array.isArray(poll.options) && poll.options.length > limits.maxPollOptions) {
				add('poll-flood', `${poll.options.length} options (max ${limits.maxPollOptions})`)
			}
		}
	}
	const contactArrays = []
	findAunuObjects(content, 'contactsArrayMessage', contactArrays)
	for (const arr of contactArrays) {
		if (Array.isArray(arr.contacts) && arr.contacts.length > limits.maxContacts) {
			add('contact-flood', `${arr.contacts.length} contacts (max ${limits.maxContacts})`)
		}
	}
	// Invalid lat/lng.
	const locations = []
	findAunuObjects(content, 'locationMessage', locations)
	findAunuObjects(content, 'liveLocationMessage', locations)
	for (const loc of locations) {
		const lat = loc.degreesLatitude
		const lng = loc.degreesLongitude
		if (typeof lat === 'number' && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
			add('invalid-location', `latitude ${lat} is outside -90..90`)
		}
		if (typeof lng === 'number' && (!Number.isFinite(lng) || lng < -180 || lng > 180)) {
			add('invalid-location', `longitude ${lng} is outside -180..180`)
		}
	}
	// AI-rich flood.
	const rich = []
	findAunuObjects(content, 'richResponseMessage', rich)
	for (const item of rich) {
		if (Array.isArray(item.submessages) && item.submessages.length > limits.maxAIRichSubmessages) {
			add('ai-rich-flood', `${item.submessages.length} submessages (max ${limits.maxAIRichSubmessages})`)
		}
	}
	return { isBug: reasons.length > 0, reasons }
}

/** Meta AI's phone range (1313555...) — used by the group-add guard. */
export const isAunuMetaAIJid = jid => /^1313555\d+@/.test(String(jid || ''))

/**
 * Wires the detector to a socket. Options:
 *   logger (default sock.logger), onBug(detail) callback,
 *   dropOutbound (default true — a flagged send is refused with a Boom),
 *   scanInbound (default true), burstWindowMs (default 60000),
 *   burstThreshold (default 2 — second flag inside the window marks a burst),
 *   enableRevoke / enableKick / enableBlock (all default false — the
 *   destructive actions run ONLY when explicitly enabled).
 * Returns `{ detach, detect }`; `detach()` restores `sendMessage` and
 * removes the upsert listener.
 */
export const attachAunuBugGuard = (sock, options = {}) => {
	const logger = options.logger || sock?.logger || { warn() {}, debug() {}, error() {} }
	const dropOutbound = options.dropOutbound !== false
	const scanInbound = options.scanInbound !== false
	const burstWindowMs = options.burstWindowMs ?? 60000
	const burstThreshold = options.burstThreshold ?? 2
	const recentBySender = new Map()
	const noteDetection = sender => {
		if (!sender) {
			return false
		}
		const now = Date.now()
		const stamps = (recentBySender.get(sender) || []).filter(t => now - t < burstWindowMs)
		stamps.push(now)
		recentBySender.set(sender, stamps)
		// AunuBaileys (1.0.74): HB-103 — stale senders were never
		// evicted from this map (their stamp lists got filtered, the
		// keys stayed), so it grew by one entry per distinct flagged
		// sender for the life of the process. Lazy sweep, only past
		// the threshold: drop senders whose newest detection is
		// already outside the burst window.
		if (recentBySender.size > 1000) {
			for (const [other, otherStamps] of recentBySender) {
				const newest = otherStamps[otherStamps.length - 1]
				if (newest === undefined || now - newest >= burstWindowMs) {
					recentBySender.delete(other)
				}
			}
		}
		return stamps.length >= burstThreshold
	}
	const handleBug = async (message, result, where) => {
		const key = message?.key
		const sender = key?.participant || key?.remoteJid
		const burst = noteDetection(sender)
		const detail = { message, result, where, burst }
		logger.warn({ sender, reasons: result.reasons, burst }, 'aunu-bug-guard: crash-payload pattern detected')
		try {
			sock.ev?.emit('aunu.bugGuard', detail)
		} catch {
			// emitting is best-effort; the log above already recorded it
		}
		try {
			await options.onBug?.(detail)
		} catch {
			// a throwing onBug must not break the send/receive path
		}
		if (where !== 'inbound') {
			return detail
		}
		// Destructive actions — only when explicitly enabled, each best-effort.
		if (options.enableRevoke && key?.id && key?.remoteJid) {
			try {
				await sock.sendMessage(key.remoteJid, { delete: key })
			} catch {
				// revoke needs admin in groups; failure just means it stays
			}
		}
		const isGroup = typeof key?.remoteJid === 'string' && key.remoteJid.endsWith('@g.us')
		if (isGroup && sender && options.enableKick && typeof sock.groupParticipantsUpdate === 'function') {
			try {
				await sock.groupParticipantsUpdate(key.remoteJid, [sender], 'remove')
			} catch {
				// kick needs admin; failure just means the sender stays
			}
		}
		if (sender && options.enableBlock && typeof sock.updateBlockStatus === 'function') {
			try {
				await sock.updateBlockStatus(sender, 'block')
			} catch {
				// blocking is best-effort
			}
		}
		return detail
	}
	const onUpsert = ({ messages }) => {
		if (!scanInbound) {
			return
		}
		for (const msg of messages || []) {
			const result = detectBugMessage(msg, options)
			if (result.isBug) {
				void handleBug(msg, result, 'inbound')
			}
		}
	}
	sock.ev?.on('messages.upsert', onUpsert)
	const originalSend = sock.sendMessage.bind(sock)
	sock.sendMessage = async (jid, content, sendOptions) => {
		const result = detectBugMessage(content, options)
		if (result.isBug) {
			await handleBug({ key: { remoteJid: jid, fromMe: true }, message: content }, result, 'outbound')
			if (dropOutbound) {
				throw new Boom('aunu-bug-guard: refusing to send a message flagged as a crash payload', { statusCode: 400 })
			}
		}
		return originalSend(jid, content, sendOptions)
	}
	return {
		detect: detectBugMessage,
		detach: () => {
			sock.sendMessage = originalSend
			if (typeof sock.ev?.off === 'function') {
				sock.ev.off('messages.upsert', onUpsert)
			} else if (typeof sock.ev?.removeListener === 'function') {
				sock.ev.removeListener('messages.upsert', onUpsert)
			}
		}
	}
}

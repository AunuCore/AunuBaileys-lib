// (45) Batch 2.8.0 — Group D (themed features) regressions:
// aunuSendChatTheme (protocolMessage 34), HB-499 (aunuSendGroupStatus
// wrap), D-1102 (scheduled-message builders, clean-room), D-1103 (HD
// preview), D-1104-A (group-metadata LID<->PN harvest), D-1106-A
// (mex.notification passthrough + PaidPartnershipUpdate routing),
// D-1107 (beta-message dispatcher), D-1108 (AI rich-tag card),
// diezysync candidate (newsletter metadata query-ID rotation +
// tolerant extraction). D-1105-A and parseArgoNewsletter are DEFERRED
// (no recorded query IDs / Argo byte format in the ledger) and have
// no tests here. Fully offline: fake transports only — the senders
// and builders under test are the real ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lib, makeOfflineSocket, fakeOpenTransport, waitFor, sleep, endQuietly, silentLogger } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { decodeBinaryNode } from '../lib/WABinary/decode.js'
import { attachAunuExperimental } from '../lib/Socket/aunu-experimental.js'
import { extractNewsletterMetadata, NEWSLETTER_METADATA_QUERY_IDS } from '../lib/Socket/newsletter.js'
import { collectGroupLidPnPairs, extractGroupMetadata } from '../lib/Socket/groups.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sharp = createRequire(path.join(ROOT, 'package.json'))('sharp')
const isBoom = (err, code) => !!err?.isBoom && err.output?.statusCode === code
const GROUP = '120207123456789@g.us'
const PEER = '6281234567890@s.whatsapp.net'

// ── fake-sock harness for the relayBuilt/sendMessage-based senders ──
const makeFakeSock = () => {
	const calls = { relay: [], send: [] }
	const sock = {
		logger: silentLogger,
		user: { id: '628999888777@s.whatsapp.net' },
		sendMessage: async (jid, content, options) => {
			calls.send.push({ jid, content, options })
			return { key: { id: 'FAKE1', remoteJid: jid } }
		},
		relayMessage: async (jid, message, opts) => {
			calls.relay.push({ jid, message, opts })
			return opts?.messageId
		},
		waUploadToServer: async () => ({})
	}
	attachAunuExperimental(sock)
	return { sock, calls }
}

// ── Item 1: aunuSendChatTheme ───────────────────────────────────────
test('aunuSendChatTheme sends a protocolMessage type 34 carrying the ChatThemeSetting', async () => {
	const { sock, calls } = makeFakeSock()
	await sock.aunuSendChatTheme(PEER, { solidColor: { backgroundLightArgb: 4278190080 } })
	assert.equal(calls.relay.length, 1)
	const proto = calls.relay[0].message.protocolMessage
	assert.equal(proto.type, 34)
	assert.equal(proto.chatThemeSetting.solidColor.backgroundLightArgb, 4278190080)
	assert.equal(typeof proto.chatThemeSetting.settingTimestampMs, 'number')
	// and the whole thing survives a real proto encode/decode
	const back = lib.waproto.Message.decode(lib.waproto.Message.encode(lib.waproto.Message.create(calls.relay[0].message)).finish())
	assert.ok(back.protocolMessage.type === 34 || back.protocolMessage.type === 'CHAT_THEME_SETTING', 'decoded type is CHAT_THEME_SETTING (34)')
	assert.equal(back.protocolMessage.chatThemeSetting.solidColor.backgroundLightArgb, 4278190080)
})

test('aunuSendChatTheme validates its arguments with Boom 400', async () => {
	const { sock, calls } = makeFakeSock()
	await assert.rejects(sock.aunuSendChatTheme(PEER, { solidColor: {}, stockImage: { stockImageId: '1' } }), e => isBoom(e, 400), 'two wallpapers')
	await assert.rejects(sock.aunuSendChatTheme(PEER, { clearTheme: true, colorSchemeId: 'x' }), e => isBoom(e, 400), 'clearTheme + scheme')
	await assert.rejects(sock.aunuSendChatTheme(PEER, { notAField: 1 }), e => isBoom(e, 400), 'unknown field')
	await assert.rejects(sock.aunuSendChatTheme(PEER, {}), e => isBoom(e, 400), 'empty setting')
	await assert.rejects(sock.aunuSendChatTheme('', { clearTheme: true }), e => isBoom(e, 400), 'empty jid')
	assert.equal(calls.relay.length, 0, 'nothing was relayed for invalid settings')
	await sock.aunuSendChatTheme(PEER, { clearTheme: true })
	assert.equal(calls.relay.at(-1).message.protocolMessage.chatThemeSetting.clearTheme, true)
})

// ── Item 2 / HB-499: aunuSendGroupStatus really wraps ───────────────
test('HB-499: aunuSendGroupStatus wraps content in groupStatusMessageV2 with isGroupStatus contextInfo', async () => {
	const { sock, calls } = makeFakeSock()
	await sock.aunuSendGroupStatus(GROUP, { text: 'halo status' })
	assert.equal(calls.relay.length, 1)
	const msg = calls.relay[0].message
	assert.ok(msg.groupStatusMessageV2, 'groupStatusMessageV2 wrapper present (was a dead flag before the fix)')
	assert.equal(msg.groupStatusMessageV2.message.extendedTextMessage.text, 'halo status')
	const ctx = msg.groupStatusMessageV2.message.extendedTextMessage.contextInfo
	assert.equal(ctx.isGroupStatus, true)
	assert.equal(ctx.statusAttributions[0].type, 5, 'GROUP_STATUS attribution')
	assert.equal(ctx.statusAttributions[0].groupStatus.authorJid, '628999888777@s.whatsapp.net')
	assert.equal(ctx.featureEligibilities.canReceiveMultiReact, true)
	assert.equal(msg.messageContextInfo.messageSecret.length, 32, 'outer messageSecret')
	assert.equal(msg.groupStatusMessageV2.message.messageContextInfo.messageSecret.length, 32, 'inner messageSecret')
	const back = lib.waproto.Message.decode(lib.waproto.Message.encode(lib.waproto.Message.create(msg)).finish())
	assert.equal(back.groupStatusMessageV2.message.extendedTextMessage.contextInfo.isGroupStatus, true)
})

test('HB-499: aunuSendGroupStatus rejects a non-group jid with Boom 400', async () => {
	const { sock, calls } = makeFakeSock()
	await assert.rejects(sock.aunuSendGroupStatus(PEER, { text: 'x' }), e => isBoom(e, 400))
	assert.equal(calls.relay.length, 0)
})

// ── Item 3 / D-1102: scheduled-message builders (clean-room) ────────
test('D-1102: scheduled message seal/open round-trips the inner message (AES-256-GCM)', () => {
	const built = lib.buildScheduledMessage({ conversation: 'nanti ya' }, Date.now() + 3600_000)
	const crm = built.message.conditionalRevealMessage
	assert.equal(crm.conditionalRevealMessageType, 1, 'SCHEDULED_MESSAGE')
	assert.equal(crm.encIv.length, 12)
	assert.ok(crm.encPayload.length > 16, 'ciphertext + 16-byte tag')
	assert.equal(crm.revealKeyId, built.revealKeyId)
	const opened = lib.decodeScheduledMessageContent(crm, built.revealKey)
	assert.equal(opened.conversation, 'nanti ya')
})

test('D-1102: meta node carries the reveal time and key id; unschedule is protocol type 32', () => {
	const built = lib.buildScheduledMessage({ conversation: 'x' }, Date.now() + 60_000)
	assert.equal(built.metaNode.tag, 'meta')
	assert.equal(built.metaNode.attrs.type, 'scheduled_message')
	assert.ok(Math.abs(Number(built.metaNode.attrs.st) * 1000 - Date.now()) < 120_000)
	assert.equal(built.metaNode.content[0].tag, 'key')
	assert.equal(built.metaNode.content[0].attrs.rkid, built.revealKeyId)
	assert.equal(Buffer.from(built.metaNode.content[0].content.toString(), 'base64').length, 32, 'the <key> node carries the 32-byte reveal key')
	const un = lib.buildUnscheduleProtocolMessage({ remoteJid: PEER, fromMe: true, id: 'ABC' })
	assert.equal(un.protocolMessage.type, 32, 'MESSAGE_UNSCHEDULE')
	assert.equal(lib.SCHEDULED_MSG_MAX_PER_CHAT, 30)
	assert.equal(lib.SCHEDULED_MESSAGE_NACK_CODE, 419)
})

test('D-1102: validation — past/beyond-retention reveal times, bad keys and tampered payloads are Boom 400', () => {
	assert.throws(() => lib.buildScheduledMessage({ conversation: 'x' }, Date.now() - 1000), e => isBoom(e, 400))
	assert.throws(() => lib.buildScheduledMessage({ conversation: 'x' }, Date.now() + 31 * 24 * 3600_000), e => isBoom(e, 400))
	assert.throws(() => lib.encodeScheduledMessage({ conversation: 'x' }, Buffer.alloc(16)), e => isBoom(e, 400))
	const built = lib.buildScheduledMessage({ conversation: 'x' }, Date.now() + 60_000)
	assert.throws(() => lib.decodeScheduledMessage(built.message.conditionalRevealMessage, Buffer.alloc(32, 9)), e => isBoom(e, 400), 'wrong key fails the GCM check')
	const tampered = { ...built.message.conditionalRevealMessage, encPayload: Buffer.from(built.message.conditionalRevealMessage.encPayload) }
	tampered.encPayload[0] ^= 0xff
	assert.throws(() => lib.decodeScheduledMessage(tampered, built.revealKey), e => isBoom(e, 400), 'tampered ciphertext fails the GCM check')
	assert.throws(() => lib.buildUnscheduleProtocolMessage({ remoteJid: PEER }), e => isBoom(e, 400))
})

// ── Item 4 / D-1103: HD preview ─────────────────────────────────────
test('D-1103: hd:true enlarges only the thumbnail — media bytes are identical, no hd field leaks to the wire object', async () => {
	const img = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer()
	const upload = async () => ({ mediaUrl: 'https://mmg.example/x', directPath: '/x' })
	const hdObj = await lib.prepareWAMessageMedia({ image: img, hd: true }, { upload, logger: silentLogger })
	const sdObj = await lib.prepareWAMessageMedia({ image: img }, { upload, logger: silentLogger })
	const hdWidth = (await sharp(Buffer.from(hdObj.imageMessage.jpegThumbnail, 'base64')).metadata()).width
	const sdWidth = (await sharp(Buffer.from(sdObj.imageMessage.jpegThumbnail, 'base64')).metadata()).width
	assert.equal(hdWidth, 200, 'HD thumbnail is 200px wide')
	assert.equal(sdWidth, 32, 'default thumbnail stays 32px wide')
	assert.ok(hdObj.imageMessage.fileSha256.equals(sdObj.imageMessage.fileSha256), 'media bytes are NOT re-encoded in HD mode')
	assert.ok(!('hd' in hdObj.imageMessage), 'hd is a send-side flag, never a wire field')
})

test('D-1103: aunuSendHD forwards image/video content with hd set and rejects other content', async () => {
	const { sock, calls } = makeFakeSock()
	await sock.aunuSendHD(PEER, { image: Buffer.from('x'), caption: 'c' })
	assert.equal(calls.send.at(-1).content.hd, true)
	await assert.rejects(sock.aunuSendHD(PEER, { text: 'x' }), e => isBoom(e, 400))
})

// ── Item 5 / D-1104-A: LID<->PN harvest ─────────────────────────────
test('D-1104-A: collectGroupLidPnPairs reads both participant shapes and skips unpaired ones', () => {
	const pairs = collectGroupLidPnPairs({
		participants: [
			{ id: '111222333@lid', phoneNumber: '628111222333@s.whatsapp.net' },
			{ id: '628444555666@s.whatsapp.net', lid: '444555666@lid' },
			{ id: '628777888999@s.whatsapp.net' },
			null,
			{ id: '999000111@lid' }
		]
	})
	assert.deepEqual(pairs, [
		{ lid: '111222333@lid', pn: '628111222333@s.whatsapp.net' },
		{ lid: '444555666@lid', pn: '628444555666@s.whatsapp.net' }
	])
	// extractGroupMetadata output shape is unchanged by the harvest
	const meta = extractGroupMetadata({
		tag: 'result', attrs: {},
		content: [{ tag: 'group', attrs: { id: '120207123456789', subject: 'G', creation: '1700000000', s_t: '1700000000' }, content: [{ tag: 'participant', attrs: { jid: '111222333@lid', phone_number: '628111222333@s.whatsapp.net' } }] }]
	})
	assert.equal(meta.participants[0].phoneNumber, '628111222333@s.whatsapp.net')
})

// ── shared live-socket harness (items 5, 6, 10) ─────────────────────
const tryDecodeFrame = async buf => {
	for (let k = 0; k <= Math.min(64, buf.length - 4); k++) {
		const len = (buf[k] << 16) | (buf[k + 1] << 8) | buf[k + 2]
		if (len !== buf.length - k - 3) continue
		try {
			return await decodeBinaryNode(buf.subarray(k + 3))
		} catch { /* not a node */ }
	}
	return null
}

const withStubbedConnect = async (t, fn) => {
	const original = WebSocketClient.prototype.connect
	WebSocketClient.prototype.connect = async () => {}
	t.after(() => { WebSocketClient.prototype.connect = original })
	return fn()
}

test('D-1104-A: groupMetadata harvests participant pairs into the LID mapping store', { timeout: 30_000 }, async t => {
	await withStubbedConnect(t, async () => {
		const sock = await makeOfflineSocket()
		t.after(() => endQuietly(sock))
		const sends = []
		fakeOpenTransport(sock, sends)
		let processed = 0
		const answered = new Set()
		const timer = setInterval(async () => {
			while (processed < sends.length) {
				const node = await tryDecodeFrame(sends[processed++])
				if (node?.tag !== 'iq' || answered.has(node.attrs.id) || node.attrs.xmlns !== 'w:g2') continue
				answered.add(node.attrs.id)
				sock.ws.emit(`TAG:${node.attrs.id}`, {
					tag: 'iq', attrs: { id: node.attrs.id, type: 'result', from: GROUP },
					content: [{ tag: 'group', attrs: { id: '120207123456789', subject: 'G', creation: '1700000000', s_t: '1700000000', addressing_mode: 'lid' }, content: [
						{ tag: 'participant', attrs: { jid: '111222333@lid', phone_number: '628111222333@s.whatsapp.net' } },
						{ tag: 'participant', attrs: { jid: '628444555666@s.whatsapp.net', lid: '444555666@lid' } }
					] }]
				})
			}
		}, 5)
		t.after(() => clearInterval(timer))
		const meta = await sock.groupMetadata(GROUP)
		assert.equal(meta.participants.length, 2, 'public metadata shape unchanged')
		const pn = await waitFor(async () => await sock.signalRepository.lidMapping.getPNForLID('111222333@lid'), 3000)
		assert.ok(pn, 'LID->PN pair was harvested from group metadata')
		assert.ok(String(await sock.signalRepository.lidMapping.getPNForLID('111222333@lid')).startsWith('628111222333'))
		assert.equal(await sock.signalRepository.lidMapping.getLIDForPN('628444555666@s.whatsapp.net'), '444555666@lid', 'PN->LID pair was harvested')
	})
})

// ── Item 10: newsletter metadata resilience ─────────────────────────
test('newsletter resilience: extractNewsletterMetadata tolerates strings, envelopes and create-shaped payloads', () => {
	const meta = { id: '120363999@newsletter', name: 'Chan' }
	assert.equal(extractNewsletterMetadata(meta).id, meta.id)
	assert.equal(extractNewsletterMetadata(JSON.stringify(meta)).id, meta.id)
	assert.equal(extractNewsletterMetadata({ xwa2_newsletter_metadata: meta }).id, meta.id)
	assert.equal(extractNewsletterMetadata({ xwa2_newsletter: meta }).id, meta.id)
	assert.equal(extractNewsletterMetadata({ result: meta }).id, meta.id)
	assert.equal(extractNewsletterMetadata({ somethingElse: meta }).id, meta.id, 'first object value carrying an id')
	const created = extractNewsletterMetadata({ id: '120363999@newsletter', thread_metadata: { name: { text: 'Raw' }, invite: '0029Va' }, viewer_metadata: {} })
	assert.equal(created.name, 'Raw')
	assert.equal(extractNewsletterMetadata({ nope: true }), null)
	assert.equal(extractNewsletterMetadata('not json'), null)
	assert.equal(extractNewsletterMetadata(null), null)
	assert.deepEqual([...NEWSLETTER_METADATA_QUERY_IDS], ['6563316087068696', '6620195908089573', '27456920720571478'])
})

test('newsletter resilience: newsletterMetadata rotates to the fallback query ID when the first yields no metadata', { timeout: 30_000 }, async t => {
	await withStubbedConnect(t, async () => {
		const sock = await makeOfflineSocket()
		t.after(() => endQuietly(sock))
		const sends = []
		fakeOpenTransport(sock, sends)
		const seenQueryIds = []
		let processed = 0
		const answered = new Set()
		const timer = setInterval(async () => {
			while (processed < sends.length) {
				const node = await tryDecodeFrame(sends[processed++])
				if (node?.tag !== 'iq' || answered.has(node.attrs.id) || node.attrs.xmlns !== 'w:mex') continue
				answered.add(node.attrs.id)
				const queryNode = node.content?.find(c => c.tag === 'query')
				seenQueryIds.push(queryNode?.attrs?.query_id)
				const payload = seenQueryIds.length === 1
					? { data: { xwa2_newsletter: {} } }
					: { data: { xwa2_newsletter: { xwa2_newsletter: { id: '120363999@newsletter', name: 'Chan' } } } }
				sock.ws.emit(`TAG:${node.attrs.id}`, {
					tag: 'iq', attrs: { id: node.attrs.id, type: 'result', from: 's.whatsapp.net' },
					content: [{ tag: 'result', attrs: {}, content: Buffer.from(JSON.stringify(payload)) }]
				})
			}
		}, 5)
		t.after(() => clearInterval(timer))
		const meta = await sock.newsletterMetadata('jid', '120363999@newsletter')
		assert.equal(meta.id, '120363999@newsletter')
		assert.deepEqual(seenQueryIds, ['6563316087068696', '6620195908089573'], 'primary ID first, recorded fallback second')
	})
})

// ── Item 7 / D-1106-A: MEX notification passthrough ─────────────────
test('D-1106-A: an unmodelled MEX op is re-emitted as mex.notification; PaidPartnershipUpdate routes to the newsletter handler', { timeout: 30_000 }, async t => {
	await withStubbedConnect(t, async () => {
		const sock = await makeOfflineSocket()
		t.after(() => endQuietly(sock))
		fakeOpenTransport(sock, [])
		const events = []
		sock.ev.on('mex.notification', payload => events.push(payload))
		const mexNode = (opName, data) => ({
			tag: 'notification', attrs: { type: 'mex', from: 's.whatsapp.net' },
			content: [{ tag: 'update', attrs: { op_name: opName }, content: Buffer.from(JSON.stringify({ data })) }]
		})
		sock.ws.emit('CB:notification', mexNode('NotificationEventDelete', { xwa2_event_delete: { id: '7' } }))
		assert.ok(await waitFor(() => events.length >= 1, 3000), 'unmodelled op produced a mex.notification event')
		assert.equal(events[0].operation, 'NotificationEventDelete')
		assert.deepEqual(events[0].data, { xwa2_event_delete: { id: '7' } })
		assert.deepEqual(events[0].updates, { data: { xwa2_event_delete: { id: '7' } } }, 'raw parsed response rides along verbatim')
		sock.ws.emit('CB:notification', mexNode('NotificationNewsletterPaidPartnershipUpdate', { x: 1 }))
		await sleep(300)
		assert.equal(events.length, 1, 'the ...Update spelling is routed to the newsletter handler, not the passthrough')
	})
})

// ── Item 8 / D-1107: beta-message dispatcher ────────────────────────
test('D-1107: detectBetaKey and buildBetaMessage validate beta content with Boom 400', () => {
	assert.equal(lib.detectBetaKey({ music: { songUri: 'https://x' } }), 'music')
	assert.equal(lib.detectBetaKey({ text: 'a' }), undefined)
	assert.equal(lib.detectBetaKey(null), undefined)
	assert.deepEqual(lib.buildBetaMessage({ eventInvite: { eventId: 'E1' } }), { eventInvite: { eventId: 'E1' } })
	assert.throws(() => lib.buildBetaMessage({ music: {} }), e => isBoom(e, 400), 'music without songUri')
	assert.throws(() => lib.buildBetaMessage({ eventInvite: {} }), e => isBoom(e, 400), 'eventInvite without eventId')
	assert.throws(() => lib.buildBetaMessage({ payment: { amount: 1 } }), e => isBoom(e, 400), 'blocked class')
	assert.throws(() => lib.buildBetaMessage({ text: 'plain' }), e => isBoom(e, 400), 'no beta key')
	assert.throws(() => lib.buildBetaMessage({ music: { songUri: 'u' }, beta: {} }), e => isBoom(e, 400), 'two beta keys')
	assert.ok(lib.BETA_CONTENT_KEYS.includes('instantVideo') && lib.BETA_BLOCKED_KEYS.includes('rootsecret'))
})

// ── Item 9 / D-1108: AI rich-tag card ───────────────────────────────
test('D-1108: buildAIRichTagCard builds the botForwardedMessage envelope with model/invoker/caps botMetadata', () => {
	const card = lib.buildAIRichTagCard({
		text: 'halo',
		modelNameOverride: 'AunuWise-1',
		invokerJid: '628111@s.whatsapp.net',
		caps: ['RICH_RESPONSE_TABLE', 2]
	})
	assert.equal(card.messageContextInfo.botMetadata.modelMetadata.modelNameOverride, 'AunuWise-1')
	assert.equal(card.messageContextInfo.botMetadata.invokerJid, '628111@s.whatsapp.net')
	assert.deepEqual(card.messageContextInfo.botMetadata.capabilityMetadata.capabilities, [6, 2], 'cap names resolve to BotCapabilityType numbers')
	const rich = card.botForwardedMessage.message.richResponseMessage
	assert.equal(rich.submessages[0].messageText, 'halo')
	const back = lib.waproto.Message.decode(lib.waproto.Message.encode(lib.waproto.Message.create(card)).finish())
	assert.equal(back.messageContextInfo.botMetadata.modelMetadata.modelNameOverride, 'AunuWise-1')
	assert.deepEqual([...back.messageContextInfo.botMetadata.capabilityMetadata.capabilities].map(String), ['6', '2'], 'caps survive the wire as RICH_RESPONSE_TABLE(6) + RICH_RESPONSE_HEADING(2)')
})

test('D-1108: buildAIRichTagCard validation and the socket sender relay the real envelope', async () => {
	assert.throws(() => lib.buildAIRichTagCard({}), e => isBoom(e, 400), 'no text/submessages')
	assert.throws(() => lib.buildAIRichTagCard({ text: 'x', caps: ['NOPE'] }), e => isBoom(e, 400), 'unknown cap name')
	assert.throws(() => lib.buildAIRichTagCard({ text: 'x', invokerJid: 'not-a-jid' }), e => isBoom(e, 400), 'bad invoker jid')
	const { sock, calls } = makeFakeSock()
	await sock.aunuSendAIRichTagCard(PEER, { text: 'halo', modelNameOverride: 'M' })
	assert.equal(calls.relay.length, 1)
	assert.ok(calls.relay[0].message.botForwardedMessage.message.richResponseMessage, 'sender relays the built envelope')
	assert.equal(typeof sock.aunuSendChatTheme, 'function')
	assert.equal(typeof sock.aunuSendHD, 'function')
})

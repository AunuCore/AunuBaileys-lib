// AunuBaileys 2.7.0 — HB-299 addendum + facet 2 regression tests.
// A self-send from a PHONE session (device 0) used to pass both HB-299
// guards and then have its only device dropped by the HB-403 partition
// as the exact sender device — relayMessage sent a <message> stanza
// with no <enc> and no <participants> and RESOLVED as if delivered:
//   facet 1 (run-1044): category 'peer' (PDO) self-send — the device
//     placeholder is never replaced by USync enumeration;
//   facet 2 (run-1051): non-peer self-DM — USync returns [device 0]
//     only, which extractDeviceJids keeps because a bare me.id decodes
//     to device undefined (not 0).
// Fix: a post-partition guard in the DM branch rejects a non-retry
// send whose recipient list is empty after the partition. (The
// extractDeviceJids `myDevice ?? 0` alternative cannot close facet 1,
// whose placeholder never passes through extractDeviceJids.)
// Fails without the fix: both sends resolve and an empty stanza is
// sent.
import { test } from 'node:test'
import assert from 'node:assert'
import { lib, silentLogger, tmpDir, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { decodeBinaryNode, getBinaryNodeChild } from '../lib/WABinary/index.js'

WebSocketClient.prototype.connect = () => {}

const ME_PHONE = '6280000000000@s.whatsapp.net' // device 0 (the phone)
const ME_COMPANION = '6280000000000:42@s.whatsapp.net' // companion :42

const mkSock = async meId => {
	const { state } = await lib.useMultiFileAuthState(tmpDir('aunu-hb299-'))
	state.creds.me = { id: meId, lid: '' }
	const sock = lib.makeWASocket({
		auth: state,
		logger: silentLogger,
		browser: ['aunu-hb299', 'test', '1'],
		markOnlineOnConnect: false,
		fireInitQueries: false,
		shouldSyncHistoryMessage: () => false,
		connectTimeoutMs: 3000,
		defaultQueryTimeoutMs: 800,
		getMessage: async () => ({ conversation: 'hi' })
	})
	return sock
}

const tryDecodeFrame = async buf => {
	for (let k = 0; k <= Math.min(64, buf.length - 4); k++) {
		const len = (buf[k] << 16) | (buf[k + 1] << 8) | buf[k + 2]
		if (len !== buf.length - k - 3) continue
		try {
			return await decodeBinaryNode(buf.subarray(k + 3))
		} catch {
			// not a node at this offset
		}
	}
	return null
}

// Fake transport recording every frame. When usyncDevicesForSelf is
// given, USync IQs are answered with that device list for the self
// user (the run-1051 facet-2 trigger).
const attachFake = (sock, usyncDevicesForSelf) => {
	const sends = []
	const fake = {
		send: (data, cb) => {
			sends.push(Buffer.from(data))
			if (cb) cb()
			if (!usyncDevicesForSelf) return
			setImmediate(async () => {
				const node = await tryDecodeFrame(Buffer.from(data))
				if (!node || node.tag !== 'iq' || !getBinaryNodeChild(node, 'usync')) return
				const res = {
					tag: 'iq',
					attrs: { id: node.attrs.id, type: 'result', from: 's.whatsapp.net' },
					content: [{
						tag: 'usync',
						attrs: {},
						content: [{
							tag: 'list',
							attrs: {},
							content: [{
								tag: 'user',
								attrs: { jid: ME_PHONE },
								content: [{
									tag: 'devices',
									attrs: {},
									content: [{
										tag: 'device-list',
										attrs: {},
										content: usyncDevicesForSelf.map(d => ({
											tag: 'device',
											attrs: { id: String(d), 'key-index': '1' }
										}))
									}]
								}]
							}]
						}]
					}]
				}
				sock.ws.emit(`TAG:${node.attrs.id}`, res)
			})
		},
		close() {}
	}
	Object.defineProperty(sock.ws, 'socket', { get: () => fake, set: () => {}, configurable: true })
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })
	return sends
}

const messageStanzas = async sends => {
	const out = []
	for (const buf of sends) {
		const n = await tryDecodeFrame(buf)
		if (n?.tag === 'message') out.push(n)
	}
	return out
}

const PDO = {
	placeholderMessageResendRequest: [{
		messageKey: { remoteJid: '6281234567890@s.whatsapp.net', id: '3EB0TESTPDO00000000001', fromMe: true }
	}],
	peerDataOperationRequestType: 2 // PLACEHOLDER_MESSAGE_RESEND
}

test('HB-299 addendum: phone-session PDO self-send rejects instead of resolving with an empty stanza', async () => {
	const sock = await mkSock(ME_PHONE)
	const sends = attachFake(sock)
	try {
		await assert.rejects(
			() => sock.sendPeerDataOperationMessage(PDO),
			err => err?.output?.statusCode === 400,
			'the PDO self-send must fail loudly (Boom 400), not resolve'
		)
		assert.deepEqual(await messageStanzas(sends), [], 'no <message> stanza may be sent')
	} finally {
		endQuietly(sock)
	}
})

test('HB-299 addendum control: companion-session PDO self-send does not quietly resolve either', async () => {
	const sock = await mkSock(ME_COMPANION)
	attachFake(sock)
	try {
		await assert.rejects(() => sock.sendPeerDataOperationMessage(PDO))
	} finally {
		endQuietly(sock)
	}
})

test('HB-299 facet 2: phone-session self-DM with USync [device 0] only rejects instead of resolving with an empty stanza', async () => {
	const sock = await mkSock(ME_PHONE)
	const sends = attachFake(sock, [0])
	try {
		await assert.rejects(
			() => sock.sendMessage(ME_PHONE, { text: 'hi self' }),
			err => err?.output?.statusCode === 400,
			'the phone-only self-DM must fail loudly (Boom 400), not resolve'
		)
		assert.deepEqual(await messageStanzas(sends), [], 'no <message> stanza may be sent')
	} finally {
		endQuietly(sock)
	}
})

test('HB-299 facet 2 control: phone-session self-DM with a linked companion [0, 42] attempts the echo (encryption path runs)', async () => {
	const sock = await mkSock(ME_PHONE)
	attachFake(sock, [0, 42])
	try {
		// The companion's key bundle is never answered by the fake
		// transport, so the send must reject on the session-assertion
		// path — proving the recipient list was NOT empty and the
		// encryption path ran (the run-1051 harness control).
		await assert.rejects(
			() => sock.sendMessage(ME_PHONE, { text: 'hi self' }),
			/Timed out fetching key bundles/
		)
	} finally {
		endQuietly(sock)
	}
})

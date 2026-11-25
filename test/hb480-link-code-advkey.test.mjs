// HB-480 (2.7.0): link_code_companion_reg must NOT mutate
// creds.advSecretKey before the companion_finish IQ succeeds.
// Pre-fix the derived key was written into live creds first, so a
// failed/timed-out IQ left an unconfirmed key in memory that the next
// unrelated creds.update persisted to disk. Fails without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Curve, aesEncryptCTR, derivePairingCodeKey } from '../lib/Utils/crypto.js'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { lib, makeAuthState, silentLogger, sleep } from './helpers.mjs'

WebSocketClient.prototype.connect = async () => {}

test('HB-480: a failed companion_finish IQ leaves creds.advSecretKey untouched', async t => {
	const { state } = await makeAuthState()
	const sock = lib.makeWASocket({
		auth: state,
		logger: silentLogger,
		waWebSocketUrl: 'ws://127.0.0.1:9/ws/chat',
		connectTimeoutMs: 800,
		defaultQueryTimeoutMs: 800,
		keepAliveIntervalMs: 3_600_000,
		markOnlineOnConnect: false,
		syncFullHistory: false,
		shouldSyncHistoryMessage: () => false,
		generateHighQualityLinkPreview: false,
		banSentinel: false,
		browser: ['aunu-p8', 'test', '1']
	})
	t.after(() => {
		try {
			sock.end(undefined)
		} catch {}
	})

	sock.authState.creds.me = { id: '6281234567890:12@s.whatsapp.net', name: '~' }
	sock.authState.creds.pairingCode = '1234-5678'
	sock.authState.creds.registered = false
	const origAdv = sock.authState.creds.advSecretKey

	const sent = []
	sock.ws.socket = {
		readyState: 1,
		_closeFn: null,
		once(ev, fn) {
			if (ev === 'close') this._closeFn = fn
		},
		on() {},
		send(_data, cb) {
			sent.push(_data)
			if (cb) cb()
		},
		close() {
			this.readyState = 3
			if (this._closeFn) this._closeFn()
		},
		terminate() {
			this.readyState = 3
			if (this._closeFn) this._closeFn()
		}
	}

	// Well-formed fixture: wrapped ephemeral pub is AES-CTR under the
	// pairing-code-derived key, as decipherLinkPublicKey expects.
	const primaryKp = Curve.generateKeyPair()
	const salt = randomBytes(32)
	const iv = randomBytes(16)
	const wrapKey = await derivePairingCodeKey('1234-5678', salt)
	const wrapped = Buffer.concat([salt, iv, aesEncryptCTR(primaryKp.public, wrapKey, iv)])
	const node = {
		tag: 'notification',
		attrs: { from: 's.whatsapp.net', id: 'notif-1', t: String(Math.floor(Date.now() / 1000)), type: 'link_code_companion_reg' },
		content: [
			{
				tag: 'link_code_companion_reg',
				attrs: {},
				content: [
					{ tag: 'link_code_pairing_ref', attrs: {}, content: Buffer.from('test-ref') },
					{ tag: 'primary_identity_pub', attrs: {}, content: Buffer.from(primaryKp.public) },
					{ tag: 'link_code_pairing_wrapped_primary_ephemeral_pub', attrs: {}, content: wrapped }
				]
			}
		]
	}

	sock.ws.emit('CB:notification', node)
	// The IQ has no responder on the fake transport: query() times out
	// (800 ms) and the handler throws; processNode logs and continues.
	await sleep(2500)

	assert.ok(sent.length > 0, 'the companion_finish IQ was attempted')
	assert.equal(sock.authState.creds.registered, false, 'registration did not complete')
	assert.equal(
		sock.authState.creds.advSecretKey,
		origAdv,
		'advSecretKey must stay at the old value until companion_finish succeeds'
	)
})

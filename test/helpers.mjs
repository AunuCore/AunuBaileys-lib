// Shared helpers for the P8 regression suite (node --test, no deps).
// Everything runs against the BUILT lib/ tree, offline: sockets are
// pointed at a dead local WS URL so construction never touches WA.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const lib = await import(path.join(ROOT, 'lib/index.js'))

export const silentLogger = {
	level: 'silent',
	child() { return silentLogger },
	trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}
}

export const tmpDir = (prefix = 'aunu-p8-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

export const waitFor = async (fn, timeoutMs = 6000, stepMs = 50) => {
	const t0 = Date.now()
	for (;;) {
		try { if (await fn()) return true } catch { /* keep polling */ }
		if (Date.now() - t0 > timeoutMs) return false
		await new Promise(r => setTimeout(r, stepMs))
	}
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Fresh multi-file auth state in a temp dir (never the repo tree). */
export const makeAuthState = async () => {
	const dir = tmpDir('aunu-p8-auth-')
	const { state, saveCreds } = await lib.useMultiFileAuthState(dir)
	return { dir, state, saveCreds }
}

/**
 * Construct a real WASocket without any network: the WS URL points at
 * a dead local port, BanSentinel is disabled (its own suite covers it)
 * and timeouts are short so stray waits settle fast.
 */
export const makeOfflineSocket = async (extra = {}) => {
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
		browser: ['aunu-p8', 'test', '1'],
		...extra
	})
	return sock
}

/**
 * Replace the transport socket inside sock.ws with a fake OPEN socket:
 * send() records frames and calls back success; close() completes the
 * close handshake immediately. Lets stanza handlers run end-to-end
 * (encode -> sendRawMessage -> ws.send) with no server.
 */
export const fakeOpenTransport = (sock, record = []) => {
	const fake = {
		readyState: 1,
		_closeFn: null,
		once(ev, fn) { if (ev === 'close') this._closeFn = fn },
		on() {},
		send(_data, cb) { record.push(_data); if (cb) cb() },
		close() { this.readyState = 3; if (this._closeFn) this._closeFn() }
	}
	sock.ws.socket = fake
	return fake
}

export const endQuietly = sock => {
	try { sock.end(undefined) } catch { /* already closed */ }
}

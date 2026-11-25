// AunuBaileys 2.7.0 — Zapo D3: syncSignalSession. Offline socket:
// the bundle fetch IQ is recorded by the fake transport and then
// times out (Boom 408 from assertSessions), which still proves the
// ordering that matters — drop first, fetch second — plus the
// reason="identity" stamp and the identity-key drop for
// reasonIdentity. The plain (no-option) call must not touch an
// existing session at all.
import { test } from 'node:test'
import assert from 'node:assert'
import { makeOfflineSocket, fakeOpenTransport, silentLogger, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
// No real connection attempts anywhere in this file.
WebSocketClient.prototype.connect = () => {}
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { Curve, generateSignalPubKey, signedKeyPair } from '../lib/Utils/crypto.js'
import { decodeBinaryNode, getBinaryNodeChild, getBinaryNodeChildren } from '../lib/WABinary/index.js'

const ME = '628123456789@s.whatsapp.net'
const PEER = '628987654321@s.whatsapp.net'

const bundleFor = () => {
	const identity = Curve.generateKeyPair()
	const signed = signedKeyPair(identity, 1)
	const pre = Curve.generateKeyPair()
	return {
		registrationId: 1234,
		identityKey: generateSignalPubKey(identity.public),
		signedPreKey: { keyId: 1, publicKey: generateSignalPubKey(signed.keyPair.public), signature: signed.signature },
		preKey: { keyId: 11, publicKey: generateSignalPubKey(pre.public) }
	}
}

const decodeFrame = async data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) {
		off = 4
	}

	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	return decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
}

const setup = async () => {
	const sock = await makeOfflineSocket()
	sock.authState.creds.me = { id: ME }
	const repo = makeLibSignalRepository(sock.authState, silentLogger)
	await repo.injectE2ESession({ jid: PEER, session: bundleFor() })
	assert.equal((await repo.validateSession(PEER)).exists, true, 'session seeded')
	return { sock, repo }
}

test('syncSignalSession: plain call with an open session fetches nothing and keeps the session', async () => {
	const { sock, repo } = await setup()
	try {
		const record = []
		fakeOpenTransport(sock, record)
		const fetched = await sock.syncSignalSession(PEER)
		assert.equal(fetched, false)
		// no encrypt IQ may go out (socket machinery may emit other
		// housekeeping frames; a bundle fetch is the one thing that
		// must not happen for an already-open session)
		for (const frame of record) {
			try {
				const node = await decodeFrame(frame)
				assert.ok(!(node.tag === 'iq' && node.attrs.xmlns === 'encrypt'), 'no encrypt IQ sent')
			} catch {
				// undecodable frame — ignore
			}
		}

		assert.equal((await repo.validateSession(PEER)).exists, true)
	} finally {
		endQuietly(sock)
	}
})

test('syncSignalSession force: drops the session, then fetches a fresh bundle with reason=identity', async () => {
	const { sock, repo } = await setup()
	try {
		const record = []
		fakeOpenTransport(sock, record)
		// offline transport: the fetch IQ times out -> Boom 408
		await assert.rejects(sock.syncSignalSession(PEER, { force: true }), err => err?.output?.statusCode === 408)
		assert.equal((await repo.validateSession(PEER)).exists, false, 'session was dropped before the fetch')

		const frames = []
		for (const frame of record) {
			try {
				frames.push(await decodeFrame(frame))
			} catch {
				// undecodable frame — ignore
			}
		}

		const iq = frames.find(f => f.tag === 'iq' && f.attrs.xmlns === 'encrypt')
		assert.ok(iq, 'encrypt IQ sent')
		const key = getBinaryNodeChild(iq, 'key')
		const users = getBinaryNodeChildren(key, 'user')
		assert.equal(users.length, 1)
		assert.equal(users[0].attrs.jid, PEER)
		assert.equal(users[0].attrs.reason, 'identity')
	} finally {
		endQuietly(sock)
	}
})

test('syncSignalSession reasonIdentity: also drops the stored identity key', async () => {
	const { sock, repo } = await setup()
	try {
		const addr = repo.jidToSignalProtocolAddress(PEER)
		// seed a stored identity key for the peer (as a prior
		// session's saveIdentity would have left it)
		await sock.authState.keys.set({ 'identity-key': { [addr]: new Uint8Array(33).fill(7) } })
		const before = await sock.authState.keys.get('identity-key', [addr])
		assert.ok(before[addr], 'identity key seeded')

		fakeOpenTransport(sock, [])
		await assert.rejects(
			sock.syncSignalSession(PEER, { reasonIdentity: true }),
			err => err?.output?.statusCode === 408
		)
		assert.equal((await repo.validateSession(PEER)).exists, false, 'session dropped')
		const after = await sock.authState.keys.get('identity-key', [addr])
		assert.ok(!after[addr], 'identity key dropped — the fresh bundle is trusted as a new identity')
	} finally {
		endQuietly(sock)
	}
})

test('syncSignalSession: invalid JID is Boom 400 and a pre-pairing call is Not authenticated', async () => {
	const { sock } = await setup()
	try {
		await assert.rejects(sock.syncSignalSession('bukan-jid'), err => err?.output?.statusCode === 400)
	} finally {
		endQuietly(sock)
	}

	const bare = await makeOfflineSocket()
	try {
		await assert.rejects(bare.syncSignalSession(PEER, { force: true }), /Not authenticated/)
	} finally {
		endQuietly(bare)
	}
})

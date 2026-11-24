// Batch 2.6.0 follow-up — HB-479 + HB-253 addendum (run-1015/1016).
// Each test names the item it locks and fails without its fix
// (verified fail-first against the 2.5.0 lib/ before the fix landed).
// Everything runs offline against the built lib/.
//
// HB-479: the CB:iq,,pair-success handler used to emit creds.update +
// connection.update { isNewLogin } BEFORE the pair-device-sign reply
// went out, so a transport failure in that window left the paired
// identity persisted (in-memory via the internal creds.update listener
// and on disk via the host's saveCreds) although the server may never
// have seen the reply. The fix emits only after sendNode(reply)
// succeeds (mirror HB-262 in requestPairingCode).
//
// HB-253 addendum: six generateWAMessageContent branches manufactured
// an empty proto message from a `{}` input that the relay's HB-253
// guard (object with at least one content key) cannot see one level
// down. Each branch now validates its content fields branch-locally
// (Boom 400), mirroring the album branch. The relay guard itself is
// untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waproto } from '../WAProto/index.js'
import { WA_ADV_ACCOUNT_SIG_PREFIX } from '../lib/Defaults/index.js'
import { Curve, hmacSign } from '../lib/Utils/crypto.js'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { lib, makeOfflineSocket, silentLogger, sleep, waitFor } from './helpers.mjs'

// No real connection attempts anywhere in this file.
WebSocketClient.prototype.connect = () => {}

const isBoom400 = err => err?.isBoom && err?.output?.statusCode === 400

const genOpts = () => ({
	logger: silentLogger,
	userJid: '1@s.whatsapp.net',
	getProfilePicUrl: async () => undefined,
	getProfileName: async () => 'x',
	waUploadToServer: async () => ({}),
	mediaCache: undefined,
	options: {}
})

// --- HB-479 fixture (same shape as test/29's HB-239 builder) ---

const pairSuccessIdentKp = Curve.generateKeyPair()
const pairSuccessAcctKp = Curve.generateKeyPair()
const pairSuccessAdvSecretKey = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex').toString('base64')
const PAIRED_ME = '6281234567890:12@s.whatsapp.net'

function buildPairSuccessStanza() {
	const deviceDetails = waproto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()
	const accountMsg = Buffer.concat([WA_ADV_ACCOUNT_SIG_PREFIX, deviceDetails, pairSuccessIdentKp.public])
	const accountSignature = Curve.sign(pairSuccessAcctKp.private, accountMsg)
	const account = { accountSignatureKey: pairSuccessAcctKp.public, accountSignature, details: deviceDetails }
	const details = waproto.ADVSignedDeviceIdentity.encode(account).finish()
	const hmac = hmacSign(details, Buffer.from(pairSuccessAdvSecretKey, 'base64'))
	const hmacNode = waproto.ADVSignedDeviceIdentityHMAC.encode({ details, hmac }).finish()
	return {
		tag: 'iq',
		attrs: { id: 'pair-1', type: 'set' },
		content: [{
			tag: 'pair-success',
			attrs: {},
			content: [
				{ tag: 'device-identity', attrs: {}, content: hmacNode },
				{ tag: 'device', attrs: { jid: PAIRED_ME } },
				{ tag: 'platform', attrs: { name: 'TestPlatform' } }
			]
		}]
	}
}

// Emit a valid pair-success stanza against a fake transport whose
// send() either succeeds or fails, and report what happened.
const runPairSuccess = async failing => {
	const sock = await makeOfflineSocket()
	sock.authState.creds.advSecretKey = pairSuccessAdvSecretKey
	sock.authState.creds.signedIdentityKey = pairSuccessIdentKp
	sock.authState.creds.signalIdentities = []
	const events = []
	sock.ev.on('creds.update', u => events.push({ kind: 'creds.update', me: u.me?.id ?? null }))
	sock.ev.on('connection.update', u => events.push({ kind: 'conn', connection: u.connection ?? null, isNewLogin: u.isNewLogin ?? null }))
	const sent = []
	const fake = {
		readyState: 1,
		_closeFn: null,
		once(ev, fn) { if (ev === 'close') this._closeFn = fn },
		on() {},
		send(_data, cb) {
			sent.push(_data)
			if (cb) cb(failing ? new Error('transport boom') : undefined)
		},
		close() { this.readyState = 3; if (this._closeFn) this._closeFn() },
		terminate() { this.readyState = 3; if (this._closeFn) this._closeFn() }
	}
	sock.ws.socket = fake
	sock.ws.emit('CB:iq,,pair-success', buildPairSuccessStanza())
	if (failing) {
		await waitFor(() => events.some(e => e.kind === 'conn' && e.connection === 'close'), 3000)
	} else {
		await waitFor(() => events.some(e => e.kind === 'creds.update'), 3000)
	}
	// Let any late emit land before asserting.
	await sleep(300)
	const result = {
		credsUpdateFired: events.some(e => e.kind === 'creds.update'),
		credsMe: events.find(e => e.kind === 'creds.update')?.me ?? null,
		isNewLoginFired: events.some(e => e.kind === 'conn' && e.isNewLogin === true),
		framesSent: sent.length,
		socketClosed: events.some(e => e.kind === 'conn' && e.connection === 'close'),
		credsMeInMemory: sock.authState.creds.me?.id ?? null
	}
	try { sock.end(undefined) } catch {}
	await sleep(50)
	return result
}

test('HB-479 (control): pair-success with a working transport emits creds.update + isNewLogin and leaves the socket open', async () => {
	const r = await runPairSuccess(false)
	assert.equal(r.credsUpdateFired, true, 'creds.update must fire once the reply succeeds')
	assert.equal(r.credsMe, PAIRED_ME, 'emitted creds must carry the paired identity')
	assert.equal(r.isNewLoginFired, true, 'connection.update { isNewLogin: true } must fire')
	assert.ok(r.framesSent >= 1, `expected the pair-device-sign reply to go out, got ${r.framesSent} frames`)
	assert.equal(r.socketClosed, false, 'a healthy pair-success must not close the socket')
	assert.equal(r.credsMeInMemory, PAIRED_ME, 'paired me must be in creds after a successful reply')
})

test('HB-479: pair-success with a failing reply emits nothing and leaves no paired identity in creds', async () => {
	const r = await runPairSuccess(true)
	assert.equal(r.socketClosed, true, 'expected the socket to close after the failed reply')
	assert.equal(r.credsUpdateFired, false, 'creds.update must NOT fire when the reply fails')
	assert.equal(r.isNewLoginFired, false, 'connection.update { isNewLogin } must NOT fire when the reply fails')
	assert.equal(r.credsMeInMemory, null, 'paired me must NOT be in creds when the reply fails')
	assert.equal(r.framesSent, 1, `only the failed reply attempt should go out, got ${r.framesSent} frames`)
})

// --- HB-253 addendum: empty-object content branches ---

test('HB-253 addendum: { location: {} } throws Boom 400', async () => {
	await assert.rejects(lib.generateWAMessageContent({ location: {} }, genOpts()), isBoom400)
})

test('HB-253 addendum: location with no usable content throws Boom 400 (bare isLive flag, NaN coordinate)', async () => {
	await assert.rejects(lib.generateWAMessageContent({ location: { isLive: true } }, genOpts()), isBoom400)
	await assert.rejects(lib.generateWAMessageContent({ location: { degreesLatitude: NaN } }, genOpts()), isBoom400)
})

test('HB-253 addendum: { react: {} } throws Boom 400, and so do a missing key and a missing text', async () => {
	await assert.rejects(lib.generateWAMessageContent({ react: {} }, genOpts()), isBoom400)
	await assert.rejects(
		lib.generateWAMessageContent({ react: { key: { remoteJid: '1@s.whatsapp.net', id: 'M1' } } }, genOpts()),
		isBoom400
	)
	await assert.rejects(lib.generateWAMessageContent({ react: { text: '👍' } }, genOpts()), isBoom400)
	await assert.rejects(lib.generateWAMessageContent({ react: { key: {}, text: '👍' } }, genOpts()), isBoom400)
})

test('HB-253 addendum: { listReply: {} } throws Boom 400, and so does a title with no selected row', async () => {
	await assert.rejects(lib.generateWAMessageContent({ listReply: {} }, genOpts()), isBoom400)
	await assert.rejects(lib.generateWAMessageContent({ listReply: { title: 'Pick' } }, genOpts()), isBoom400)
})

test('HB-253 addendum: { aiRich: {} } and { aiRich: { submessages: [] } } throw Boom 400', async () => {
	await assert.rejects(lib.generateWAMessageContent({ aiRich: {} }, genOpts()), isBoom400)
	await assert.rejects(lib.generateWAMessageContent({ aiRich: { submessages: [] } }, genOpts()), isBoom400)
})

test('HB-253 addendum: { groupInvite: {} } throws Boom 400, and so do a missing jid and a missing inviteCode', async () => {
	await assert.rejects(lib.generateWAMessageContent({ groupInvite: {} }, genOpts()), isBoom400)
	await assert.rejects(lib.generateWAMessageContent({ groupInvite: { inviteCode: 'AbC123' } }, genOpts()), isBoom400)
	await assert.rejects(lib.generateWAMessageContent({ groupInvite: { jid: '123@g.us' } }, genOpts()), isBoom400)
})

test('HB-253 addendum: { buttonReply: {} } throws Boom 400 for both plain and template types', async () => {
	await assert.rejects(lib.generateWAMessageContent({ buttonReply: {}, type: 'plain' }, genOpts()), isBoom400)
	await assert.rejects(lib.generateWAMessageContent({ buttonReply: {}, type: 'template' }, genOpts()), isBoom400)
	await assert.rejects(
		lib.generateWAMessageContent({ buttonReply: { displayText: 'Yes', index: 0 }, type: 'plain' }, genOpts()),
		isBoom400
	)
})

test('HB-253 addendum (control): { album: {} } still throws Boom 400', async () => {
	await assert.rejects(lib.generateWAMessageContent({ album: {} }, genOpts()), isBoom400)
})

test('HB-253 addendum (control): valid branches still build', async () => {
	const mLoc = await lib.generateWAMessageContent(
		{ location: { degreesLatitude: -6.2, degreesLongitude: 106.8, name: 'Jakarta' } },
		genOpts()
	)
	assert.equal(mLoc.locationMessage?.degreesLatitude, -6.2)
	assert.equal(mLoc.locationMessage?.degreesLongitude, 106.8)
	const mLocName = await lib.generateWAMessageContent({ location: { name: 'Jakarta' } }, genOpts())
	assert.equal(mLocName.locationMessage?.name, 'Jakarta')

	const mReact = await lib.generateWAMessageContent(
		{ react: { key: { remoteJid: '1@s.whatsapp.net', id: 'M1' }, text: '👍' } },
		genOpts()
	)
	assert.equal(mReact.reactionMessage?.text, '👍')
	assert.equal(mReact.reactionMessage?.key?.id, 'M1')
	// Empty text is the reaction-removal flow (e2e send-receive test)
	// and must keep working.
	const mUnreact = await lib.generateWAMessageContent(
		{ react: { key: { remoteJid: '1@s.whatsapp.net', id: 'M1' }, text: '' } },
		genOpts()
	)
	assert.equal(mUnreact.reactionMessage?.text, '')

	const mList = await lib.generateWAMessageContent(
		{ listReply: { title: 'Pick', singleSelectReply: { selectedRowId: 'row-1' } } },
		genOpts()
	)
	assert.equal(mList.listResponseMessage?.singleSelectReply?.selectedRowId, 'row-1')

	const mRich = await lib.generateWAMessageContent(
		{ aiRich: { submessages: [{ type: 'text', text: 'hello' }] } },
		genOpts()
	)
	assert.equal(mRich.richResponseMessage?.submessages?.length, 1)
	assert.equal(mRich.richResponseMessage?.submessages?.[0]?.messageText, 'hello')

	const mInvite = await lib.generateWAMessageContent(
		{ groupInvite: { inviteCode: 'AbC123', inviteExpiration: 9999999999, text: 'join', jid: '123@g.us', subject: 'G' } },
		genOpts()
	)
	assert.equal(mInvite.groupInviteMessage?.inviteCode, 'AbC123')
	assert.equal(mInvite.groupInviteMessage?.groupJid, '123@g.us')

	const mBtnPlain = await lib.generateWAMessageContent(
		{ buttonReply: { id: 'btn-1', displayText: 'Yes', index: 0 }, type: 'plain' },
		genOpts()
	)
	assert.equal(mBtnPlain.buttonsResponseMessage?.selectedButtonId, 'btn-1')
	const mBtnTemplate = await lib.generateWAMessageContent(
		{ buttonReply: { id: 'btn-2', displayText: 'No', index: 1 }, type: 'template' },
		genOpts()
	)
	assert.equal(mBtnTemplate.templateButtonReplyMessage?.selectedId, 'btn-2')

	const mText = await lib.generateWAMessageContent({ text: 'hi' }, genOpts())
	assert.ok(mText.extendedTextMessage, 'text control must still build')
})

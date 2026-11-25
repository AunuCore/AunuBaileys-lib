// HB-95 addendum facet 1 (2.7.0): an app-state sync response carrying
// a collection that was never requested must be skipped — it must not
// throw inside decodePatches (undefined initial state) nor inside the
// per-collection catch (states[name].version), and it must not abort
// the rest of the resync round. Fails without the fix:
// resyncAppState rejects with a raw TypeError.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeOfflineSocket, fakeOpenTransport, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { decodeBinaryNode } from '../lib/WABinary/index.js'
import { waproto } from '../WAProto/index.js'

WebSocketClient.prototype.connect = () => {}

const decodeFrame = async data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) {
		off = 4
	}

	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	return decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
}

test('HB-95 facet 1: resyncAppState survives an unrequested collection in the sync response', async () => {
	const sock = await makeOfflineSocket({ fireInitQueries: false })
	fakeOpenTransport(sock)
	const origSend = sock.ws.socket.send.bind(sock.ws.socket)
	sock.ws.socket.send = (data, cb) => {
		origSend(data, cb)
		decodeFrame(data)
			.then(node => {
				if (node?.tag !== 'iq' || !node.attrs?.id || node.attrs.xmlns !== 'w:sync:app:state') {
					return
				}

				const patchBytes = Buffer.from(waproto.SyncdPatch.encode({ version: { version: 1 } }).finish())
				sock.ws.emit(`TAG:${node.attrs.id}`, {
					tag: 'iq',
					attrs: { type: 'result', id: node.attrs.id },
					content: [
						{
							tag: 'sync',
							attrs: {},
							content: [
								{
									tag: 'collection',
									attrs: { name: 'rogue_collection', version: '0' },
									content: [{ tag: 'patches', attrs: {}, content: [{ tag: 'patch', attrs: {}, content: patchBytes }] }]
								},
								{ tag: 'collection', attrs: { name: 'regular_low', version: '0' }, content: [] }
							]
						}
					]
				})
			})
			.catch(() => {})
	}
	try {
		await sock.resyncAppState(['regular_low'], false)
	} finally {
		endQuietly(sock)
	}
})

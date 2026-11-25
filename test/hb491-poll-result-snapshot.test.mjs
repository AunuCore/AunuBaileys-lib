// AunuBaileys 2.7.0 — HB-491 regression: the pollResult builder
// branch was lost in the 2.x line, so sendMessage({ pollResult })
// fell through to prepareWAMessageMedia and threw 'Invalid media
// type'. These tests FAIL without the restored branch (both forms
// throw) and pass with it: a plain poll builds
// pollResultSnapshotMessage (proto field 88), a quiz (pollType 1)
// builds pollResultSnapshotMessageV3 (proto field 115).
import { test } from 'node:test'
import assert from 'node:assert'
import { generateWAMessageContent } from '../lib/Utils/messages.js'
import { waproto as proto } from '../WAProto/index.js'

const opts = {
	logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this } },
	userJid: '6281234567@s.whatsapp.net',
	upload: async () => {
		throw new Error('no upload expected for pollResult content')
	}
}

test('pollResult: plain poll builds pollResultSnapshotMessage (field 88) on the wire', async () => {
	const m = await generateWAMessageContent(
		{
			pollResult: {
				name: 'Makan apa?',
				pollVotes: [
					{ optionName: 'Nasi', optionVoteCount: 3 },
					{ optionName: 'Mie', optionVoteCount: 1 }
				]
			}
		},
		opts
	)
	assert.equal(m.pollResultSnapshotMessage?.name, 'Makan apa?')
	assert.equal(m.pollResultSnapshotMessageV3, undefined)

	const decoded = proto.Message.decode(proto.Message.encode(m).finish())
	assert.equal(decoded.pollResultSnapshotMessage?.name, 'Makan apa?')
	assert.equal(decoded.pollResultSnapshotMessageV3, undefined)
	assert.equal(decoded.pollResultSnapshotMessage.pollVotes.length, 2)
	assert.equal(decoded.pollResultSnapshotMessage.pollVotes[0].optionName, 'Nasi')
	assert.equal(Number(decoded.pollResultSnapshotMessage.pollVotes[0].optionVoteCount), 3)
	assert.equal(Number(decoded.pollResultSnapshotMessage.pollVotes[1].optionVoteCount), 1)
})

test('pollResult: quiz (pollType 1) builds pollResultSnapshotMessageV3 (field 115) on the wire', async () => {
	const m = await generateWAMessageContent(
		{
			pollResult: {
				pollType: 1,
				name: 'Kuis?',
				pollVotes: [{ optionName: 'A', optionVoteCount: 5 }]
			}
		},
		opts
	)
	assert.equal(m.pollResultSnapshotMessageV3?.name, 'Kuis?')
	assert.equal(m.pollResultSnapshotMessage, undefined)

	const decoded = proto.Message.decode(proto.Message.encode(m).finish())
	assert.equal(decoded.pollResultSnapshotMessage, undefined)
	assert.equal(decoded.pollResultSnapshotMessageV3?.name, 'Kuis?')
	assert.equal(Number(decoded.pollResultSnapshotMessageV3.pollVotes[0].optionVoteCount), 5)
	assert.equal(decoded.pollResultSnapshotMessageV3.pollType, proto.Message.PollType.QUIZ)
})

test('pollResult: malformed snapshots are rejected with Boom 400, not Invalid media type', async () => {
	await assert.rejects(
		generateWAMessageContent({ pollResult: { pollVotes: [] } }, opts),
		err => err?.output?.statusCode === 400 && /pollResult\.name/.test(err.message)
	)
	await assert.rejects(
		generateWAMessageContent({ pollResult: { name: 'X', pollVotes: 'nope' } }, opts),
		err => err?.output?.statusCode === 400 && /pollVotes must be an array/.test(err.message)
	)
	await assert.rejects(
		generateWAMessageContent(
			{ pollResult: { name: 'X', pollVotes: [{ optionName: 'A', optionVoteCount: Number.NaN }] } },
			opts
		),
		err => err?.output?.statusCode === 400 && /optionVoteCount/.test(err.message)
	)
})

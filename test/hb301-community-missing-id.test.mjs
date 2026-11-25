// HB-301 addendum, id-missing facet (2.7.0): extractCommunityMetadata
// must throw a descriptive Boom when the <community> node carries no
// id — mirroring extractGroupMetadata. Fails without the fix: it
// returned metadata with the bogus id '@g.us' (jidEncode('', 'g.us')).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractCommunityMetadata } from '../lib/Socket/communities.js'
import { extractGroupMetadata } from '../lib/Socket/groups.js'

const communityResult = attrs => ({
	tag: 'iq',
	attrs: { type: 'result' },
	content: [{ tag: 'community', attrs, content: [] }]
})

test('HB-301 id-missing: extractCommunityMetadata throws Boom on a missing community id', () => {
	assert.throws(() => extractCommunityMetadata(communityResult({ subject: 'No Id Community' })), /missing community id/)
})

test('HB-301 id-missing: extractCommunityMetadata still parses a community with an id', () => {
	const meta = extractCommunityMetadata(communityResult({ id: '120363000000000009', subject: 'Has Id' }))
	assert.equal(meta.id, '120363000000000009@g.us')
	assert.equal(meta.subject, 'Has Id')
})

test('HB-301 id-missing (control): extractGroupMetadata throws on a missing group id', () => {
	assert.throws(
		() =>
			extractGroupMetadata({
				tag: 'iq',
				attrs: { type: 'result' },
				content: [{ tag: 'group', attrs: { subject: 'No Id Group' }, content: [] }]
			}),
		/missing group id/
	)
})

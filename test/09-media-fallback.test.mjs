// (i) music-metadata absence: getAudioDuration must resolve
// `undefined` (never throw) when the optional peer is missing.
// Deterministic even on hosts where the peer IS installed: a child
// process registers a module hook that makes 'music-metadata'
// unresolvable, then imports the built messages-media module.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, lib } from './helpers.mjs'

test('(i) getAudioDuration returns undefined (no crash) when music-metadata cannot be loaded', async () => {
	// In this tree the peer is not installed at all, so the direct
	// call already exercises the fallback.
	const duration = await lib.getAudioDuration(Buffer.from('not real audio'))
	assert.equal(duration, undefined)
})

test('(i) subprocess with music-metadata blocked at the resolver: duration is undefined, exit 0', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aunu-p8-mm-'))
	const hook = path.join(dir, 'block-mm.mjs')
	fs.writeFileSync(hook, `
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(\`
export async function resolve(specifier, context, next) {
  if (specifier === 'music-metadata') throw new Error('blocked for P8 test')
  return next(specifier, context)
}\`), import.meta.url)
`)
	const child = path.join(dir, 'child.mjs')
	fs.writeFileSync(child, `
const { getAudioDuration } = await import(${JSON.stringify(path.join(ROOT, 'lib/Utils/messages-media.js'))})
const d = await getAudioDuration(Buffer.from('not real audio'))
if (d !== undefined) { console.error('expected undefined, got', d); process.exit(2) }
console.log('duration-undefined-ok')
`)
	const out = execFileSync(process.execPath, ['--import', hook, child], { encoding: 'utf8', timeout: 30_000 })
	assert.match(out, /duration-undefined-ok/)
})

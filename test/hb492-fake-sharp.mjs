// HB-492 regression-test fake for the `sharp` package. Only the
// HB-492 test loads it (via hb492-fake-sharp-hook.mjs, which
// redirects the bare `sharp` specifier here). It mimics the slice of
// the sharp API the sticker-pack path uses — `.webp().toBuffer()`
// for conversions and `.resize().jpeg().toBuffer()` for the pack
// thumbnail — counts concurrent toBuffer() calls, holds each one
// ~30 ms so an unbounded fan-out shows up as a high peak, and
// returns a deterministic per-input buffer so the test can derive
// the expected sticker fileName from the input bytes.
const state = (globalThis.__hb492FakeSharp ??= { active: 0, peak: 0, calls: 0 })

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const fakeSharp = input => {
	const chain = {
		webp: () => chain,
		resize: () => chain,
		jpeg: () => chain,
		toBuffer: async () => {
			state.calls++
			state.active++
			state.peak = Math.max(state.peak, state.active)
			try {
				await delay(30)
				return Buffer.concat([Buffer.from('FAKE-WEBP:'), Buffer.from(input)])
			} finally {
				state.active--
			}
		}
	}
	return chain
}

export default fakeSharp

// Test-only ESM resolve hook for the HB-492 regression test: redirect
// the bare `sharp` specifier to the fake backend in
// ./hb492-fake-sharp.mjs, so the test can count concurrent
// conversions without decoding real images. It touches nothing else.
const FAKE_URL = new URL('./hb492-fake-sharp.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
	if (specifier === 'sharp') {
		return { url: FAKE_URL, shortCircuit: true }
	}

	return nextResolve(specifier, context)
}

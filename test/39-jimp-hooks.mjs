// Module-customisation hooks for the HB-468 tests in
// test/39-batch-260-leftovers.test.mjs: they make the tree look like a
// jimp-only host to src/Utils/messages-media.ts — sharp and
// @napi-rs/image fail to load, jimp resolves to the stub next to this
// file. Scoped to imports FROM lib/Utils/messages-media.js only; every
// other specifier resolves normally.
export async function resolve(specifier, context, nextResolve) {
	if (context.parentURL?.endsWith('/lib/Utils/messages-media.js')) {
		if (specifier === 'sharp' || specifier === '@napi-rs/image') {
			return { url: new URL('./39-jimp-throw.mjs', import.meta.url).href, shortCircuit: true }
		}

		if (specifier === 'jimp') {
			return { url: new URL('./39-jimp-stub.mjs', import.meta.url).href, shortCircuit: true }
		}
	}

	return nextResolve(specifier, context)
}

// Minimal jimp 1.6.0 stand-in for the HB-468 tests: Jimp is a class
// (typeof 'function' — exactly the property the fixed guard checks),
// with the read/resize/crop/getBuffer surface extractImageThumb and
// generateProfilePicture use. The bytes are a fixed minimal JPEG;
// dimensions are fixed 64x48.
const JPEG = Buffer.from([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
	0x00, 0x00, 0xff, 0xd9
])

export class Jimp {
	static async read(_bufferOrFilePath) {
		return new Jimp()
	}

	constructor() {
		this.width = 64
		this.height = 48
	}

	resize(_opts) {
		return this
	}

	crop(_opts) {
		return this
	}

	async getBuffer(_mime, _opts) {
		return JPEG
	}
}

export const ResizeStrategy = { BILINEAR: 'bilinear' }

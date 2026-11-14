import { Boom } from '@hapi/boom'
import { spawn } from 'child_process'
import * as Crypto from 'crypto'
import { once } from 'events'
import { createReadStream, createWriteStream, promises as fs, WriteStream } from 'fs'
import type { Agent } from 'https'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { URL } from 'url'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_ORIGIN, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP, type MediaType } from '../Defaults'
import type {
	BaileysEventMap,
	DownloadableMessage,
	MediaConnInfo,
	MediaDecryptionKeyInfo,
	MessageType,
	SocketConfig,
	WAGenericMediaMessage,
	WAMediaUpload,
	WAMediaUploadFunction,
	WAMessageContent,
	WAMessageKey
} from '../Types'
import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildBuffer, jidNormalizedUser } from '../WABinary'
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './crypto'
import { generateMessageIDV2 } from './generics'
import type { ILogger } from './logger'
import { readImageDimensions } from './safe-fetch'

const getTmpFilesDirectory = () => tmpdir()

// AunuBaileys (P2e port from v6): exported for the sticker-pack builder in
// messages.ts, and the @napi-rs/image backend is probed like in v6 — a host
// with only @napi-rs/image (no sharp/jimp) must still be able to convert
// sticker/cover images (the HB-164 gap in the pack path).
export const getImageProcessingLibrary = async () => {
	const [jimp, sharp, image] = await Promise.all([
		//@ts-ignore — optional peer: may be absent at build time
		import('jimp').catch(() => {}),
		//@ts-ignore
		import('sharp').catch(() => {}),
		//@ts-ignore
		import('@napi-rs/image').catch(() => {})
	])

	if (sharp) {
		return { sharp }
	}

	if (image) {
		return { image }
	}

	if (jimp) {
		return { jimp }
	}

	throw new Boom('No image processing library available')
}

// AunuBaileys (HB-277, P4): pixel/decompression-bomb guard, reusing
// the 1.0.85 link-preview defence (readImageDimensions + the same
// 40 MP cap) at every OTHER decode site. The byte caps at these
// sites (1 MB sticker / 5 MB cover / 16 MB profile picture) say
// nothing about pixels: a solid 281 KB PNG can declare 17000x17000
// (289 MP). sharp refuses that on its own (268 MP internal limit),
// but the @napi-rs/image backend has NO limit and decodes the full
// raster (measured +276 MB RSS for one image; four in parallel —
// the sticker-pack Promise.all pattern — OOM-killed the process),
// and jimp decodes the full raster too. Read the header dimensions
// BEFORE any backend sees the bytes; formats the header reader
// does not know keep the old behaviour (decode decides).
export const MAX_IMAGE_PIXELS = 40_000_000

export const assertImageWithinPixelLimit = (buffer: Buffer, context: string) => {
	const dims = readImageDimensions(buffer)
	if (dims && dims.width * dims.height > MAX_IMAGE_PIXELS) {
		throw new Boom(
			`${context}: image dimensions ${dims.width}x${dims.height} exceed the ${MAX_IMAGE_PIXELS} pixel limit`,
			{ statusCode: 400 }
		)
	}
}

export const hkdfInfoKey = (type: MediaType) => {
	const hkdfInfo = MEDIA_HKDF_KEY_MAPPING[type]
	return `WhatsApp ${hkdfInfo} Keys`
}

export const getRawMediaUploadData = async (media: WAMediaUpload, mediaType: MediaType, logger?: ILogger) => {
	const { stream } = await getStream(media)
	logger?.debug('got stream for raw upload')

	const hasher = Crypto.createHash('sha256')
	const filePath = join(tmpdir(), mediaType + generateMessageIDV2())
	const fileWriteStream = createWriteStream(filePath)

	// AunuBaileys (HB-273, P4): the write stream only had an 'error'
	// listener while a once('drain')/once('finish') await was pending.
	// An open/write failure (tmpdir gone, ENOSPC) that fired while the
	// loop was awaiting the next INPUT chunk had no listener at all —
	// an uncaught 'error' event that killed the process, bypassing
	// this try/catch entirely. Keep a persistent listener, and race
	// every drain-wait against the captured error: an error that
	// fired BEFORE the wait started would otherwise leave
	// once('drain') pending forever.
	let writeError: Error | undefined
	let rejectWriteError: (err: Error) => void = () => {}
	const writeErrorPromise = new Promise<never>((_resolve, reject) => {
		rejectWriteError = reject
	})
	writeErrorPromise.catch(() => {})
	fileWriteStream.on('error', err => {
		if (!writeError) {
			writeError = err
			rejectWriteError(err)
		}
	})

	let fileLength = 0
	try {
		for await (const data of stream) {
			fileLength += data.length
			hasher.update(data)
			if (!fileWriteStream.write(data)) {
				await Promise.race([once(fileWriteStream, 'drain'), writeErrorPromise])
			}
		}

		if (writeError) {
			throw writeError
		}

		fileWriteStream.end()
		await once(fileWriteStream, 'finish')
		stream.destroy()
		const fileSha256 = hasher.digest()
		logger?.debug('hashed data for raw upload')
		return {
			filePath: filePath,
			fileSha256,
			fileLength
		}
	} catch (error) {
		fileWriteStream.destroy()
		stream.destroy()
		try {
			await fs.unlink(filePath)
		} catch {
			//
		}

		throw error
	}
}

/** generates all the keys required to encrypt/decrypt & sign a media message */
export async function getMediaKeys(
	buffer: Uint8Array | string | null | undefined,
	mediaType: MediaType
): Promise<MediaDecryptionKeyInfo> {
	if (!buffer) {
		throw new Boom('Cannot derive from empty media key')
	}

	if (typeof buffer === 'string') {
		buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64')
	}

	// expand using HKDF to 112 bytes, also pass in the relevant app info
	const expandedMediaKey = hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) })
	return {
		iv: expandedMediaKey.slice(0, 16),
		cipherKey: expandedMediaKey.slice(16, 48),
		macKey: expandedMediaKey.slice(48, 80)
	}
}

/** Extracts video thumb using FFMPEG */
// AunuBaileys (1.0.85, HB-128, re-applied P3b): ffmpeg used to run
// through a shell string with NO timeout and NO kill — a wedged
// ffmpeg hung generateThumbnail, and with it the Promise.all inside
// prepareWAMessageMedia, so the video send never settled; stderr
// also accumulated without bound. Spawn with an argument array (no
// shell interpolation of path/time/size), SIGKILL after the
// timeout, and keep only the first 64 KiB of stderr (plenty for the
// error message).
const FFMPEG_THUMB_TIMEOUT_MS = 30000
const FFMPEG_STDERR_CAP_BYTES = 64 * 1024
const extractVideoThumb = async (
	path: string,
	destPath: string,
	time: string,
	size: { width: number; height: number }
) =>
	new Promise<void>((resolve, reject) => {
		const ffmpeg = spawn(
			'ffmpeg',
			['-ss', String(time), '-i', path, '-y', '-vf', `scale=${size.width}:-1`, '-vframes', '1', '-f', 'image2', destPath],
			{ stdio: ['ignore', 'ignore', 'pipe'] }
		)

		const stderrChunks: Buffer[] = []
		let stderrBytes = 0
		ffmpeg.stderr.on('data', (chunk: Buffer) => {
			if (stderrBytes >= FFMPEG_STDERR_CAP_BYTES) {
				return
			}

			const keep = chunk.subarray(0, FFMPEG_STDERR_CAP_BYTES - stderrBytes)
			stderrChunks.push(keep)
			stderrBytes += keep.length
		})

		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			ffmpeg.kill('SIGKILL')
		}, FFMPEG_THUMB_TIMEOUT_MS)
		timer.unref?.()

		ffmpeg.on('error', err => {
			clearTimeout(timer)
			reject(err)
		})
		ffmpeg.on('close', code => {
			clearTimeout(timer)
			if (code === 0) {
				resolve()
			} else if (timedOut) {
				reject(new Error(`ffmpeg timed out after ${FFMPEG_THUMB_TIMEOUT_MS}ms while extracting a video thumbnail`))
			} else {
				reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(stderrChunks).toString('utf8').trim()}`))
			}
		})
	})

export const extractImageThumb = async (bufferOrFilePath: Readable | Buffer | string, width = 32) => {
	// TODO: Move entirely to sharp, removing jimp as it supports readable streams
	// This will have positive speed and performance impacts as well as minimizing RAM usage.
	if (bufferOrFilePath instanceof Readable) {
		bufferOrFilePath = await toBuffer(bufferOrFilePath)
	}

	// AunuBaileys (HB-277, P4): pixel-bomb guard BEFORE any backend
	// decodes — a file-path input is read into memory so its header
	// can be checked (the napi/jimp branches read it fully anyway,
	// and sharp accepts a Buffer identically).
	if (typeof bufferOrFilePath === 'string') {
		bufferOrFilePath = await fs.readFile(bufferOrFilePath)
	}

	assertImageWithinPixelLimit(bufferOrFilePath, 'extractImageThumb')

	const lib = await getImageProcessingLibrary()
	if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
		const img = lib.sharp.default(bufferOrFilePath)
		const dimensions = await img.metadata()

		const buffer = await img.resize(width).jpeg({ quality: 50 }).toBuffer()
		return {
			buffer,
			original: {
				width: dimensions.width,
				height: dimensions.height
			}
		}
	} else if ('image' in lib && (lib as any).image?.Transformer) {
		// AunuBaileys (P2e port from v6): @napi-rs/image backend — the
		// loader now returns it ahead of jimp (v6 order), so this branch
		// must exist or napi-only hosts regress to the throw below.
		if (!Buffer.isBuffer(bufferOrFilePath)) {
			bufferOrFilePath = await fs.readFile(bufferOrFilePath as string)
		}

		const img = new (lib as any).image.Transformer(bufferOrFilePath)
		const dimensions = await img.metadata()
		const buffer = await img.resize(width, undefined, 0).jpeg(50)
		return {
			buffer,
			original: {
				width: dimensions.width,
				height: dimensions.height
			}
		}
	} else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'object') {
		const jimp = await (lib.jimp.Jimp as any).read(bufferOrFilePath)
		const dimensions = {
			width: jimp.width,
			height: jimp.height
		}
		const buffer = await jimp
			.resize({ w: width, mode: lib.jimp.ResizeStrategy.BILINEAR })
			.getBuffer('image/jpeg', { quality: 50 })
		return {
			buffer,
			original: dimensions
		}
	} else {
		throw new Boom('No image processing library available')
	}
}

export const encodeBase64EncodedStringForUpload = (b64: string) =>
	encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/\=+$/, ''))

export const generateProfilePicture = async (
	mediaUpload: WAMediaUpload,
	dimensions?: { width: number; height: number }
) => {
	let buffer: Buffer

	const { width: w = 640, height: h = 640 } = dimensions || {}

	if (Buffer.isBuffer(mediaUpload)) {
		buffer = mediaUpload
	} else {
		// Use getStream to handle all WAMediaUpload types (Buffer, Stream, URL)
		// AunuBaileys (1.0.85, HB-219, re-applied P3b): a remote URL used to be
		// buffered with NO size cap and NO timeout — a huge or never-ending
		// response was accumulated in full before the image decode finally
		// rejected it, and a stalled server hung updateProfilePicture forever.
		// Bound both (16 MiB matches the product-image cap).
		const { stream } = await getStream(mediaUpload, { signal: AbortSignal.timeout(30_000) })
		// Convert the resulting stream to a buffer, with a hard cap
		buffer = await toBufferWithLimit(stream, MAX_PROFILE_PICTURE_SOURCE_BYTES)
	}

	// AunuBaileys (HB-277, P4): the 16 MiB cap above bounds BYTES,
	// not pixels — check the header dimensions before the resize
	// decode below (the @napi-rs/image and jimp backends would
	// decode a 289 MP raster in full).
	assertImageWithinPixelLimit(buffer, 'generateProfilePicture')

	const lib = await getImageProcessingLibrary()
	let img: Promise<Buffer>
	if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
		img = lib.sharp
			.default(buffer)
			.resize(w, h)
			.jpeg({
				quality: 50
			})
			.toBuffer()
	} else if ('image' in lib && (lib as any).image?.Transformer) {
		// AunuBaileys (P2e port from v6): @napi-rs/image backend, same
		// loader-order reasoning as extractImageThumb above.
		img = new (lib as any).image.Transformer(buffer).resize(w, h, 0).jpeg(50)
	} else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'function') {
		const jimp = await (lib.jimp.Jimp as any).read(buffer)
		const min = Math.min(jimp.width, jimp.height)
		const cropped = jimp.crop({ x: 0, y: 0, w: min, h: min })

		img = cropped.resize({ w, h, mode: lib.jimp.ResizeStrategy.BILINEAR }).getBuffer('image/jpeg', { quality: 50 })
	} else {
		throw new Boom('No image processing library available')
	}

	return {
		img: await img
	}
}

/** gets the SHA256 of the given media message */
export const mediaMessageSHA256B64 = (message: WAMessageContent) => {
	const media = Object.values(message)[0] as WAGenericMediaMessage
	return media?.fileSha256 && Buffer.from(media.fileSha256).toString('base64')
}

// AunuBaileys (P9, 2.0.0): `music-metadata` is an OPTIONAL peer
// dependency, not a runtime dependency. Only the duration reader
// below uses it, and only the `format.duration` field is read — so
// the type is declared locally instead of imported, and the package
// is loaded dynamically: when it is absent the duration is simply
// left unset (the caller in messages.ts already treats every
// extra-info failure as non-fatal), never an uncaught error.
type AudioMetadataLike = {
	format: {
		duration?: number
	}
}

export async function getAudioDuration(buffer: Buffer | string | Readable) {
	let musicMetadata: {
		parseBuffer: (buffer: Buffer, mimeType?: string, options?: object) => Promise<AudioMetadataLike>
		parseFile: (filePath: string, options?: object) => Promise<AudioMetadataLike>
		parseStream: (stream: Readable, mimeType?: string, options?: object) => Promise<AudioMetadataLike>
	}
	try {
		//@ts-ignore — optional peer: may be absent at build time
		musicMetadata = (await import('music-metadata')) as typeof musicMetadata
	} catch {
		return undefined
	}

	let metadata: AudioMetadataLike
	const options = {
		duration: true
	}
	if (Buffer.isBuffer(buffer)) {
		metadata = await musicMetadata.parseBuffer(buffer, undefined, options)
	} else if (typeof buffer === 'string') {
		metadata = await musicMetadata.parseFile(buffer, options)
	} else {
		metadata = await musicMetadata.parseStream(buffer, undefined, options)
	}

	return metadata.format.duration
}

/**
  referenced from and modifying https://github.com/wppconnect-team/wa-js/blob/main/src/chat/functions/prepareAudioWaveform.ts
 */
export async function getAudioWaveform(buffer: Buffer | string | Readable, logger?: ILogger) {
	try {
		// @ts-ignore
		const { default: decoder } = await import('audio-decode')
		let audioData: Buffer
		if (Buffer.isBuffer(buffer)) {
			audioData = buffer
		} else if (typeof buffer === 'string') {
			const rStream = createReadStream(buffer)
			audioData = await toBuffer(rStream)
		} else {
			audioData = await toBuffer(buffer)
		}

		const audioBuffer = await decoder(audioData)

		const rawData = audioBuffer.getChannelData(0) // We only need to work with one channel of data
		const samples = 64 // Number of samples we want to have in our final data set
		const blockSize = Math.floor(rawData.length / samples) // the number of samples in each subdivision
		const filteredData: number[] = []
		for (let i = 0; i < samples; i++) {
			const blockStart = blockSize * i // the location of the first sample in the block
			let sum = 0
			for (let j = 0; j < blockSize; j++) {
				sum = sum + Math.abs(rawData[blockStart + j]) // find the sum of all the samples in the block
			}

			filteredData.push(sum / blockSize) // divide the sum by the block size to get the average
		}

		// This guarantees that the largest data point will be set to 1, and the rest of the data will scale proportionally.
		const multiplier = Math.pow(Math.max(...filteredData), -1)
		const normalizedData = filteredData.map(n => n * multiplier)

		// Generate waveform like WhatsApp
		const waveform = new Uint8Array(normalizedData.map(n => Math.floor(100 * n)))

		return waveform
	} catch (e) {
		logger?.debug('Failed to generate waveform: ' + e)
	}
}

export const toReadable = (buffer: Buffer) => {
	const readable = new Readable({ read: () => {} })
	readable.push(buffer)
	readable.push(null)
	return readable
}

export const toBuffer = async (stream: Readable) => {
	const chunks: Buffer[] = []
	for await (const chunk of stream) {
		chunks.push(chunk)
	}

	stream.destroy()
	return Buffer.concat(chunks)
}

// AunuBaileys (1.0.85, HB-219, re-applied P3b): bounds for the remote fetch in
// generateProfilePicture (16 MiB matches the product-image cap).
const MAX_PROFILE_PICTURE_SOURCE_BYTES = 16 * 1024 * 1024

export const toBufferWithLimit = async (stream: Readable, maxBytes: number) => {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of stream) {
		size += chunk.length
		if (size > maxBytes) {
			stream.destroy()
			throw new Boom(`content length exceeded ${maxBytes} bytes`, { statusCode: 413 })
		}

		chunks.push(chunk)
	}

	stream.destroy()
	return Buffer.concat(chunks)
}

export const getStream = async (item: WAMediaUpload, opts?: RequestInit & { maxContentLength?: number }) => {
	if (Buffer.isBuffer(item)) {
		return { stream: toReadable(item), type: 'buffer' } as const
	}

	// AunuBaileys (1.0.85, HB-208, re-applied P3b): unusable media used to
	// explode here as raw TypeErrors — 'stream' in undefined/null for a
	// missing media value, a toString deref for an object with no usable
	// url, a createReadStream type error for a numeric url. Reject all of
	// them with a clear Boom 400 instead.
	if (!item || typeof item !== 'object') {
		throw new Boom('Invalid media: expected a Buffer, a stream, or an object with a url', { statusCode: 400 })
	}

	if ('stream' in item) {
		return { stream: item.stream, type: 'readable' } as const
	}

	if (typeof item.url !== 'string' && !(item.url instanceof URL)) {
		throw new Boom('Invalid media: expected a Buffer, a stream, or an object with a url', { statusCode: 400 })
	}

	const urlStr = item.url.toString()

	if (urlStr.startsWith('data:')) {
		const buffer = Buffer.from(urlStr.split(',')[1]!, 'base64')
		return { stream: toReadable(buffer), type: 'buffer' } as const
	}

	if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
		return { stream: await getHttpStream(item.url, opts), type: 'remote' } as const
	}

	return { stream: createReadStream(item.url), type: 'file' } as const
}

/** generates a thumbnail for a given media, if required */
export async function generateThumbnail(
	file: string,
	mediaType: 'video' | 'image',
	options: {
		logger?: ILogger
	}
) {
	let thumbnail: string | undefined
	let originalImageDimensions: { width: number; height: number } | undefined
	if (mediaType === 'image') {
		const { buffer, original } = await extractImageThumb(file)
		thumbnail = buffer.toString('base64')
		if (original.width && original.height) {
			originalImageDimensions = {
				width: original.width,
				height: original.height
			}
		}
	} else if (mediaType === 'video') {
		const imgFilename = join(getTmpFilesDirectory(), generateMessageIDV2() + '.jpg')
		try {
			await extractVideoThumb(file, imgFilename, '00:00:00', { width: 32, height: 32 })
			const buff = await fs.readFile(imgFilename)
			thumbnail = buff.toString('base64')

			await fs.unlink(imgFilename)
		} catch (err) {
			options.logger?.debug('could not generate video thumb: ' + err)
		}
	}

	return {
		thumbnail,
		originalImageDimensions
	}
}

export const getHttpStream = async (url: string | URL, options: RequestInit & { isStream?: true } = {}) => {
	const response = await fetch(url.toString(), {
		dispatcher: options.dispatcher,
		method: 'GET',
		headers: options.headers as HeadersInit,
		signal: options.signal
	})
	if (!response.ok) {
		throw new Boom(`Failed to fetch stream from ${url}`, { statusCode: response.status, data: { url } })
	}

	// @ts-ignore Node18+ Readable.fromWeb exists
	return response.body instanceof Readable ? response.body : Readable.fromWeb(response.body as any)
}

type EncryptedStreamOptions = {
	saveOriginalFileIfRequired?: boolean
	logger?: ILogger
	opts?: RequestInit
	/** AunuBaileys (P2e port from v6): caller-supplied media key (32 bytes) — the sticker-pack thumbnail is encrypted under the pack's own key */
	mediaKey?: Buffer | Uint8Array
}

export const encryptedStream = async (
	media: WAMediaUpload,
	mediaType: MediaType,
	{ logger, saveOriginalFileIfRequired, opts, mediaKey: providedMediaKey }: EncryptedStreamOptions = {}
) => {
	const { stream, type } = await getStream(media, opts)

	logger?.debug('fetched media stream')

	// AunuBaileys (P2e port from v6): a caller-supplied 32-byte mediaKey used
	// to be silently dropped and replaced with a random one — the
	// sticker-pack thumbnail was then encrypted under an unrecorded key.
	const mediaKey = providedMediaKey?.length === 32 ? Buffer.from(providedMediaKey) : Crypto.randomBytes(32)
	const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType)

	const encFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2() + '-enc')
	const encFileWriteStream = createWriteStream(encFilePath)

	let originalFileStream: WriteStream | undefined
	let originalFilePath: string | undefined

	if (saveOriginalFileIfRequired) {
		originalFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2() + '-original')
		originalFileStream = createWriteStream(originalFilePath)
	}

	// AunuBaileys (HB-273, P4): persistent 'error' listeners on BOTH
	// write streams — see getRawMediaUploadData above. During the
	// chunk loop below, the only 'error' coverage used to be the
	// transient once('drain') awaits; an open/write failure in
	// between (ENOSPC, tmpdir removed) escaped as an uncaught 'error'
	// event and crashed the process. Capture the first error, race
	// every drain-wait against it, and throw it into the catch after
	// the loop.
	let writeError: Error | undefined
	let rejectWriteError: (err: Error) => void = () => {}
	const writeErrorPromise = new Promise<never>((_resolve, reject) => {
		rejectWriteError = reject
	})
	writeErrorPromise.catch(() => {})
	const captureWriteError = (err: Error) => {
		if (!writeError) {
			writeError = err
			rejectWriteError(err)
		}
	}

	encFileWriteStream.on('error', captureWriteError)
	originalFileStream?.on('error', captureWriteError)

	let fileLength = 0
	const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
	const hmac = Crypto.createHmac('sha256', macKey!).update(iv)
	const sha256Plain = Crypto.createHash('sha256')
	const sha256Enc = Crypto.createHash('sha256')

	const onChunk = async (buff: Buffer) => {
		sha256Enc.update(buff)
		hmac.update(buff)
		// Handle backpressure: if write returns false, wait for drain
		if (!encFileWriteStream.write(buff)) {
			await Promise.race([once(encFileWriteStream, 'drain'), writeErrorPromise])
		}
	}

	try {
		for await (const data of stream) {
			// AunuBaileys (1.0.72, HB-88, re-applied P3b): the cap
			// check used to run AFTER the increment while still
			// adding data.length — the current chunk was counted
			// twice, so the effective cap was one chunk below the
			// configured one and legitimate media just under the
			// cap was rejected. Check first, like
			// getRawMediaUploadData does.
			if (
				type === 'remote' &&
				(opts as any)?.maxContentLength &&
				fileLength + data.length > (opts as any).maxContentLength
			) {
				throw new Boom(`content length exceeded when encrypting "${type}"`, {
					data: { media, type }
				})
			}

			fileLength += data.length

			if (originalFileStream) {
				if (!originalFileStream.write(data)) {
					await Promise.race([once(originalFileStream, 'drain'), writeErrorPromise])
				}
			}

			sha256Plain.update(data)
			await onChunk(aes.update(data))
		}

		// HB-273: a write failure captured during the loop aborts the
		// encrypt here, before the finish-wait below.
		if (writeError) {
			throw writeError
		}

		await onChunk(aes.final())

		const mac = hmac.digest().slice(0, 10)
		sha256Enc.update(mac)

		const fileSha256 = sha256Plain.digest()
		const fileEncSha256 = sha256Enc.digest()

		encFileWriteStream.write(mac)

		// HB-273: an already-failed stream never emits 'finish' — do
		// not wait on it.
		if (writeError) {
			throw writeError
		}

		const encFinishPromise = once(encFileWriteStream, 'finish')
		const originalFinishPromise = originalFileStream ? once(originalFileStream, 'finish') : Promise.resolve()

		encFileWriteStream.end()
		originalFileStream?.end?.()
		stream.destroy()

		// Wait for write streams to fully flush to disk
		// This helps reduce memory pressure by allowing OS to release buffers
		await encFinishPromise
		await originalFinishPromise

		logger?.debug('encrypted data successfully')

		return {
			mediaKey,
			originalFilePath,
			encFilePath,
			mac,
			fileEncSha256,
			fileSha256,
			fileLength
		}
	} catch (error) {
		// destroy all streams with error
		encFileWriteStream.destroy()
		originalFileStream?.destroy?.()
		aes.destroy()
		hmac.destroy()
		sha256Plain.destroy()
		sha256Enc.destroy()
		stream.destroy()

		try {
			await fs.unlink(encFilePath)
			if (originalFilePath) {
				await fs.unlink(originalFilePath)
			}
		} catch (err) {
			logger?.error({ err }, 'failed deleting tmp files')
		}

		throw error
	}
}

export const DEF_MEDIA_HOST = 'mmg.whatsapp.net'

const AES_CHUNK_SIZE = 16

const toSmallestChunkSize = (num: number) => {
	return Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE
}

export type MediaDownloadOptions = {
	startByte?: number
	endByte?: number
	options?: RequestInit
	/** Optional media host override; falls back to DEF_MEDIA_HOST when not provided. */
	host?: string
}

export const getUrlFromDirectPath = (directPath: string, host: string = DEF_MEDIA_HOST) =>
	`https://${host}${directPath}`

// Some media messages (stickers, voice notes, images) carry a `url` on `a.whatsapp.net`,
// which doesn't resolve. Their `directPath` is valid, so it must go to the default host.
const PLACEHOLDER_MEDIA_HOST = 'a.whatsapp.net'

// AunuBaileys (HB-114, re-applied P3): the media-host allowlist.
const WA_MEDIA_HOST_SUFFIXES = ['.whatsapp.net', '.fbcdn.net']
const isWAMediaHost = (hostname?: string): boolean =>
	!!hostname &&
	hostname !== PLACEHOLDER_MEDIA_HOST &&
	(hostname === 'whatsapp.net' || hostname === 'fbcdn.net' || WA_MEDIA_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix)))

const extractHost = (url: string | null | undefined): string | undefined => {
	if (!url) return undefined
	try {
		const host = new URL(url).host
		return host === PLACEHOLDER_MEDIA_HOST ? undefined : host
	} catch {
		return undefined
	}
}

export const downloadContentFromMessage = async (
	{ mediaKey, directPath, url }: DownloadableMessage,
	type: MediaType,
	opts: MediaDownloadOptions = {}
) => {
	// AunuBaileys (1.0.76, HB-114, re-applied P3): WhatsApp media is
	// only ever served from WhatsApp/Facebook CDN hosts. Upstream v7
	// already rebuilds the path from directPath and excludes the
	// a.whatsapp.net placeholder host \u2014 but it still honours ANY
	// host parsed from the sender-supplied `url` as the fallback, and
	// uses `url` verbatim when there is no directPath: a sender could
	// make the host GET an arbitrary https host (SSRF). Allowlist the
	// host: a non-WA host is never fetched \u2014 with a directPath we
	// fall back to the canonical media host (the path is globally
	// valid there); without one the download is refused.
	const rawHost = opts.host ?? extractHost(url)
	const fallbackHost = rawHost && isWAMediaHost(rawHost) ? rawHost : DEF_MEDIA_HOST
	let downloadUrl: string | undefined
	if (directPath) {
		downloadUrl = getUrlFromDirectPath(directPath, fallbackHost)
	} else if (url) {
		let urlHost: string | undefined
		try {
			urlHost = new URL(url).hostname
		} catch {}

		if (!isWAMediaHost(urlHost)) {
			throw new Boom('Refusing to download media from a non-WhatsApp host (SSRF guard)', { statusCode: 400 })
		}

		downloadUrl = url
	}

	if (!downloadUrl) {
		throw new Boom('No valid media URL or directPath present in message', { statusCode: 400 })
	}

	const keys = await getMediaKeys(mediaKey, type)

	return downloadEncryptedContent(downloadUrl, keys, opts)
}

/**
 * Decrypts and downloads an AES256-CBC encrypted file given the keys.
 * Assumes the SHA256 of the plaintext is appended to the end of the ciphertext
 * */
export const downloadEncryptedContent = async (
	downloadUrl: string,
	{ cipherKey, iv, macKey }: MediaDecryptionKeyInfo,
	{ startByte, endByte, options }: MediaDownloadOptions = {}
) => {
	let bytesFetched = 0
	let startChunk = 0
	let firstBlockIsIV = false
	// if a start byte is specified -- then we need to fetch the previous chunk as that will form the IV
	if (startByte) {
		const chunk = toSmallestChunkSize(startByte || 0)
		if (chunk) {
			startChunk = chunk - AES_CHUNK_SIZE
			bytesFetched = chunk

			firstBlockIsIV = true
		}
	}

	const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined

	const headersInit = options?.headers ? options.headers : undefined
	const headers: Record<string, string> = {
		...(headersInit
			? Array.isArray(headersInit)
				? Object.fromEntries(headersInit)
				: (headersInit as Record<string, string>)
			: {}),
		Origin: DEFAULT_ORIGIN
	}
	if (startChunk || endChunk) {
		headers.Range = `bytes=${startChunk}-`
		if (endChunk) {
			headers.Range += endChunk
		}
	}

	// download the message
	const fetched = await getHttpStream(downloadUrl, {
		...(options || {}),
		headers
	})

	let remainingBytes = Buffer.from([])

	let aes: Crypto.Decipher

	// AunuBaileys (1.0.76, HB-115, re-applied P3): the media MAC used
	// to be verified ONLY on the encrypt/upload path \u2014 a full
	// download was decrypted and handed to the consumer with no
	// integrity check at all. For FULL downloads (no byte range) with
	// a macKey available, verify it streaming: HMAC every ciphertext
	// byte except a held-back final 10, compare in final() with
	// timingSafeEqual. Ranged downloads fetch a slice that excludes
	// the MAC \u2014 they skip verification, exactly as in v6.
	const verifyMac = !!macKey && !startByte && !endByte
	const macHmac = verifyMac ? Crypto.createHmac('sha256', macKey!).update(iv) : null
	let macTail = Buffer.alloc(0)
	const feedMac = (chunk: Buffer) => {
		if (!macHmac) {
			return
		}

		const joined = macTail.length ? Buffer.concat([macTail, chunk]) : chunk
		if (joined.length > 10) {
			macHmac.update(joined.subarray(0, joined.length - 10))
			macTail = Buffer.from(joined.subarray(joined.length - 10))
		} else {
			macTail = Buffer.from(joined)
		}
	}

	const pushBytes = (bytes: Buffer, push: (bytes: Buffer) => void) => {
		if (startByte || endByte) {
			const start = bytesFetched >= startByte! ? undefined : Math.max(startByte! - bytesFetched, 0)
			// AunuBaileys (1.0.74, HB-96, re-applied P3b): with a
			// startByte but NO endByte, `endByte - bytesFetched` was
			// NaN and every chunk sliced to zero bytes (a silent
			// empty download). No endByte means "to the end of the
			// stream": end stays undefined. (When endByte IS set, an
			// end past this chunk clamps inside slice() exactly
			// like undefined did.)
			const end = endByte == null ? undefined : Math.max(endByte - bytesFetched, 0)

			push(bytes.slice(start, end))

			bytesFetched += bytes.length
		} else {
			push(bytes)
		}
	}

	const output = new Transform({
		transform(chunk, _, callback) {
			feedMac(chunk as Buffer)
			let data = remainingBytes.length ? Buffer.concat([remainingBytes, chunk]) : chunk

			const decryptLength = toSmallestChunkSize(data.length)
			remainingBytes = data.slice(decryptLength)
			data = data.slice(0, decryptLength)

			if (!aes) {
				// AunuBaileys (1.0.85, HB-114/HB-158, re-applied P3b):
				// on the ranged path the IV is carved out of the first
				// 16 bytes of the body — when the first chunk(s) total
				// less than that, there is nothing to build a decipher
				// from yet. createDecipheriv used to sit OUTSIDE the
				// try below and threw a bare "Invalid initialization
				// vector" TypeError for exactly that download. Wait for
				// more bytes instead (a <16-byte slice means
				// decryptLength was 0, so everything is still in
				// remainingBytes), and keep the construction inside a
				// try so any failure surfaces as a proper stream error.
				if (firstBlockIsIV && data.length < AES_CHUNK_SIZE) {
					callback()
					return
				}

				try {
					let ivValue = iv
					if (firstBlockIsIV) {
						ivValue = data.slice(0, AES_CHUNK_SIZE)
						data = data.slice(AES_CHUNK_SIZE)
					}

					aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue)
					// if an end byte that is not EOF is specified
					// stop auto padding (PKCS7) -- otherwise throws an error for decryption
					if (endByte) {
						aes.setAutoPadding(false)
					}
				} catch (error: any) {
					callback(error)
					return
				}
			}

			try {
				pushBytes(aes.update(data), b => this.push(b))
				callback()
			} catch (error: any) {
				callback(error)
			}
		},
		final(callback) {
			try {
				pushBytes(aes.final(), b => this.push(b))
			} catch (error: any) {
				callback(error)
				return
			}

			// AunuBaileys (HB-115, re-applied P3): reject tampered or
			// truncated media \u2014 the trailing 10 bytes must equal the
			// truncated HMAC over (iv + ciphertext).
			if (macHmac) {
				const expectedMac = macHmac.digest().subarray(0, 10)
				if (macTail.length !== 10 || !Crypto.timingSafeEqual(Buffer.from(macTail), expectedMac)) {
					callback(
						new Boom(
							'Downloaded media failed HMAC integrity verification \u2014 the file was tampered with or truncated in transit; refusing it',
							{ statusCode: 400 }
						)
					)
					return
				}
			}

			callback()
		}
	})
	return fetched.pipe(output, { end: true })
}

export function extensionForMediaMessage(message: WAMessageContent) {
	const getExtension = (mimetype: string) => mimetype.split(';')[0]?.split('/')[1]
	const type = Object.keys(message)[0] as Exclude<MessageType, 'toJSON'>
	let extension: string
	if (type === 'locationMessage' || type === 'liveLocationMessage' || type === 'productMessage') {
		extension = '.jpeg'
	} else {
		const messageContent = message[type] as WAGenericMediaMessage
		extension = getExtension(messageContent.mimetype!)!
	}

	return extension
}

const isNodeRuntime = (): boolean => {
	return (
		typeof process !== 'undefined' &&
		process.versions?.node !== null &&
		typeof process.versions.bun === 'undefined' &&
		typeof (globalThis as any).Deno === 'undefined'
	)
}

type MediaUploadResult = {
	url?: string
	direct_path?: string
	meta_hmac?: string
	ts?: number
	fbid?: number
}

export type UploadParams = {
	url: string
	filePath: string
	headers: Record<string, string>
	timeoutMs?: number
	agent?: Agent
}

export const uploadWithNodeHttp = async (
	{ url, filePath, headers, timeoutMs, agent }: UploadParams,
	redirectCount = 0
): Promise<MediaUploadResult | undefined> => {
	if (redirectCount > 5) {
		throw new Error('Too many redirects')
	}

	const parsedUrl = new URL(url)
	const httpModule = parsedUrl.protocol === 'https:' ? await import('https') : await import('http')

	// Get file size for Content-Length header (required for Node.js streaming)
	const fileStats = await fs.stat(filePath)
	const fileSize = fileStats.size

	return new Promise((resolve, reject) => {
		const req = httpModule.request(
			{
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
				path: parsedUrl.pathname + parsedUrl.search,
				method: 'POST',
				headers: {
					...headers,
					'Content-Length': fileSize
				},
				agent,
				timeout: timeoutMs
			},
			res => {
				// Handle redirects (3xx)
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume() // Consume response to free resources
					const newUrl = new URL(res.headers.location, url).toString()
					resolve(
						uploadWithNodeHttp(
							{
								url: newUrl,
								filePath,
								headers,
								timeoutMs,
								agent
							},
							redirectCount + 1
						)
					)
					return
				}

				let body = ''
				res.on('data', chunk => (body += chunk))
				res.on('end', () => {
					try {
						resolve(JSON.parse(body))
					} catch {
						resolve(undefined)
					}
				})
			}
		)

		req.on('error', reject)
		req.on('timeout', () => {
			req.destroy()
			reject(new Error('Upload timeout'))
		})

		const stream = createReadStream(filePath)
		stream.pipe(req)
		stream.on('error', err => {
			req.destroy()
			reject(err)
		})
	})
}

const uploadWithFetch = async ({
	url,
	filePath,
	headers,
	timeoutMs,
	agent
}: UploadParams): Promise<MediaUploadResult | undefined> => {
	// Convert Node.js Readable to Web ReadableStream
	const nodeStream = createReadStream(filePath)
	const webStream = Readable.toWeb(nodeStream) as ReadableStream
	// Native fetch only accepts Undici-style dispatchers, not generic https Agents.
	const dispatcher = typeof (agent as { dispatch?: unknown } | undefined)?.dispatch === 'function' ? agent : undefined

	const response = await fetch(url, {
		...(dispatcher ? { dispatcher } : {}),
		method: 'POST',
		body: webStream,
		headers,
		duplex: 'half',
		signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
	})

	try {
		return (await response.json()) as MediaUploadResult
	} catch {
		return undefined
	}
}

/**
 * Uploads media to WhatsApp servers.
 *
 * ## Why we have two upload implementations:
 *
 * Node.js's native `fetch` (powered by undici) has a known bug where it buffers
 * the entire request body in memory before sending, even when using streams.
 * This causes memory issues with large files (e.g., 1GB file = 1GB+ memory usage).
 * See: https://github.com/nodejs/undici/issues/4058
 *
 * Other runtimes (Bun, Deno, browsers) correctly stream the request body without
 * buffering, so we can use the web-standard Fetch API there.
 *
 * ## Future considerations:
 * Once the undici bug is fixed, we can simplify this to use only the Fetch API
 * across all runtimes. Monitor the GitHub issue for updates.
 */
const uploadMedia = async (params: UploadParams, logger?: ILogger): Promise<MediaUploadResult | undefined> => {
	if (isNodeRuntime()) {
		logger?.debug('Using Node.js https module for upload (avoids undici buffering bug)')
		return uploadWithNodeHttp(params)
	} else {
		logger?.debug('Using web-standard Fetch API for upload')
		return uploadWithFetch(params)
	}
}

// AunuBaileys (1.0.85, HB-127, re-applied P3b): default ceiling for
// one media-upload POST.
const MEDIA_UPLOAD_DEFAULT_TIMEOUT_MS = 120000

export const getWAUploadToServer = (
	{ customUploadHosts, fetchAgent, logger, options }: SocketConfig,
	refreshMediaConn: (force: boolean) => Promise<MediaConnInfo>
): WAMediaUploadFunction => {
	return async (filePath, { mediaType, fileEncSha256B64, timeoutMs }) => {
		// AunuBaileys (1.0.85, HB-127, re-applied P3b): timeoutMs used to
		// be a pure pass-through of the host's mediaUploadTimeoutMs,
		// with no default anywhere — an upload host that black-holes
		// the connection (accepts TCP, never speaks) left the POST, and
		// with it prepareWAMessageMedia -> sendMessage, pending
		// FOREVER. Sanitise at the boundary: a finite positive value
		// is honored, anything else gets the default.
		const effectiveTimeoutMs =
			typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
				? timeoutMs
				: MEDIA_UPLOAD_DEFAULT_TIMEOUT_MS

		// send a query JSON to obtain the url & auth token to upload our media
		let uploadInfo = await refreshMediaConn(false)

		let urls: { mediaUrl: string; directPath: string; meta_hmac?: string; ts?: number; fbid?: number } | undefined
		const hosts = [...customUploadHosts, ...uploadInfo.hosts]

		fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64)

		// Prepare common headers
		const customHeaders = (() => {
			const hdrs = options?.headers
			if (!hdrs) return {}
			return Array.isArray(hdrs) ? Object.fromEntries(hdrs) : (hdrs as Record<string, string>)
		})()

		const headers = {
			...customHeaders,
			'Content-Type': 'application/octet-stream',
			Origin: DEFAULT_ORIGIN
		}

		for (const { hostname } of hosts) {
			logger.debug(`uploading to "${hostname}"`)

			const auth = encodeURIComponent(uploadInfo.auth)
			const url = `https://${hostname}${MEDIA_PATH_MAP[mediaType]}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`

			let result: MediaUploadResult | undefined
			try {
				result = await uploadMedia(
					{
						url,
						filePath,
						headers,
						timeoutMs: effectiveTimeoutMs,
						agent: fetchAgent
					},
					logger
				)

				if (result?.url || result?.direct_path) {
					urls = {
						mediaUrl: result.url!,
						directPath: result.direct_path!,
						meta_hmac: result.meta_hmac,
						fbid: result.fbid,
						ts: result.ts
					}
					break
				} else {
					uploadInfo = await refreshMediaConn(true)
					throw new Error(`upload failed, reason: ${JSON.stringify(result)}`)
				}
			} catch (error: any) {
				const isLast = hostname === hosts[uploadInfo.hosts.length - 1]?.hostname
				logger.warn(
					{ trace: error?.stack, uploadResult: result },
					`Error in uploading to ${hostname} ${isLast ? '' : ', retrying...'}`
				)
			}
		}

		if (!urls) {
			throw new Boom('Media upload failed on all hosts', { statusCode: 500 })
		}

		return urls
	}
}

const getMediaRetryKey = (mediaKey: Buffer | Uint8Array) => {
	return hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' })
}

/**
 * Generate a binary node that will request the phone to re-upload the media & return the newly uploaded URL
 */
export const encryptMediaRetryRequest = (key: WAMessageKey, mediaKey: Buffer | Uint8Array, meId: string) => {
	const recp: proto.IServerErrorReceipt = { stanzaId: key.id }
	const recpBuffer = proto.ServerErrorReceipt.encode(recp).finish()

	const iv = Crypto.randomBytes(12)
	const retryKey = getMediaRetryKey(mediaKey)
	const ciphertext = aesEncryptGCM(recpBuffer, retryKey, iv, Buffer.from(key.id!))

	const req: BinaryNode = {
		tag: 'receipt',
		attrs: {
			id: key.id!,
			to: jidNormalizedUser(meId),
			type: 'server-error'
		},
		content: [
			// this encrypt node is actually pretty useless
			// the media is returned even without this node
			// keeping it here to maintain parity with WA Web
			{
				tag: 'encrypt',
				attrs: {},
				content: [
					{ tag: 'enc_p', attrs: {}, content: ciphertext },
					{ tag: 'enc_iv', attrs: {}, content: iv }
				]
			},
			{
				tag: 'rmr',
				attrs: {
					jid: key.remoteJid!,
					from_me: (!!key.fromMe).toString(),
					// @ts-ignore
					participant: key.participant || undefined
				}
			}
		]
	}

	return req
}

export const decodeMediaRetryNode = (node: BinaryNode) => {
	const rmrNode = getBinaryNodeChild(node, 'rmr')!

	const event: BaileysEventMap['messages.media-update'][number] = {
		key: {
			id: node.attrs.id,
			remoteJid: rmrNode.attrs.jid,
			fromMe: rmrNode.attrs.from_me === 'true',
			participant: rmrNode.attrs.participant
		}
	}

	const errorNode = getBinaryNodeChild(node, 'error')
	if (errorNode) {
		const errorCode = +errorNode.attrs.code!
		event.error = new Boom(`Failed to re-upload media (${errorCode})`, {
			data: errorNode.attrs,
			statusCode: getStatusCodeForMediaRetry(errorCode)
		})
	} else {
		const encryptedInfoNode = getBinaryNodeChild(node, 'encrypt')
		const ciphertext = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_p')
		const iv = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_iv')
		if (ciphertext && iv) {
			event.media = { ciphertext, iv }
		} else {
			event.error = new Boom('Failed to re-upload media (missing ciphertext)', { statusCode: 404 })
		}
	}

	return event
}

export const decryptMediaRetryData = (
	{ ciphertext, iv }: { ciphertext: Uint8Array; iv: Uint8Array },
	mediaKey: Uint8Array,
	msgId: string
) => {
	const retryKey = getMediaRetryKey(mediaKey)
	const plaintext = aesDecryptGCM(ciphertext, retryKey, iv, Buffer.from(msgId))
	return proto.MediaRetryNotification.decode(plaintext)
}

export const getStatusCodeForMediaRetry = (code: number) =>
	MEDIA_RETRY_STATUS_MAP[code as proto.MediaRetryNotification.ResultType]

const MEDIA_RETRY_STATUS_MAP = {
	[proto.MediaRetryNotification.ResultType.SUCCESS]: 200,
	[proto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
	[proto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
	[proto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418
} as const

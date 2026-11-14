import type { WAMediaUploadFunction, WAUrlInfo } from '../Types'
import type { ILogger } from './logger'
import { prepareWAMessageMedia } from './messages'
import { extractImageThumb } from './messages-media'
import { readImageDimensions, safeHttpGet } from './safe-fetch'

const THUMBNAIL_WIDTH_PX = 192

// AunuBaileys (1.0.85, HB-205/HB-252 family, re-applied P3): everything
// in this module is fetched on behalf of a REMOTE PAGE \u2014 the URL
// comes from message text and the og:image from the fetched page
// itself \u2014 so all of it goes through the SSRF-safe fetch
// (src/Utils/safe-fetch.ts): non-public addresses are refused at
// connect time, and every response is size- and time-bounded.
// link-preview-js is used for HTML parsing ONLY
// (getPreviewFromContent); it performs no network access, so the
// protections do not depend on the installed link-preview-js version.
// This also closes HB-205: the HTML body used to be read in full with
// no cap and no overall timeout.
const MAX_HTML_BYTES = 1024 * 1024 // og: tags live in <head>; the rest is cut off
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024
const MAX_THUMBNAIL_PIXELS = 40_000_000 // refuse decompression bombs before the image library sees them
const MAX_PREVIEW_TIMEOUT_MS = 30_000
const HTMLISH = /^(text\/html|application\/xhtml\+xml|text\/xml|application\/xml)\b/i

export type URLGenerationOptions = {
	thumbnailWidth: number
	fetchOpts: {
		/** Timeout in ms */
		timeout: number
		proxyUrl?: string
		headers?: HeadersInit
		allowPrivateNetworks?: boolean
		isBlockedAddress?: (address: string) => boolean
		lookup?: unknown
	}
	uploadImage?: WAMediaUploadFunction
	logger?: ILogger
}

/** Only these keys of the caller's fetchOpts are honoured now. */
const transportOpts = (fetchOpts: URLGenerationOptions['fetchOpts'] = { timeout: 3000 }) => ({
	timeout:
		typeof fetchOpts.timeout === 'number' && Number.isFinite(fetchOpts.timeout) && fetchOpts.timeout > 0
			? Math.min(fetchOpts.timeout, MAX_PREVIEW_TIMEOUT_MS)
			: 3000,
	headers: fetchOpts.headers as Record<string, string> | undefined,
	allowPrivateNetworks: fetchOpts.allowPrivateNetworks === true,
	isBlocked: typeof fetchOpts.isBlockedAddress === 'function' ? fetchOpts.isBlockedAddress : undefined,
	lookup: typeof fetchOpts.lookup === 'function' ? (fetchOpts.lookup as never) : undefined
})

const decodeBody = (body: Buffer, contentType?: string) => {
	const charset = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1]
	try {
		return new TextDecoder(charset || 'utf-8').decode(body)
	} catch {
		return new TextDecoder('utf-8').decode(body)
	}
}

/** Fetches an og:image through the safe fetch, with byte + pixel bounds. */
const fetchThumbnailBuffer = async (imageUrl: string, fetchOpts?: URLGenerationOptions['fetchOpts']) => {
	const res = await safeHttpGet(imageUrl, {
		...transportOpts(fetchOpts),
		maxBytes: MAX_THUMBNAIL_BYTES,
		onLimit: 'throw'
	})
	const dims = readImageDimensions(res.body)
	if (dims && dims.width * dims.height > MAX_THUMBNAIL_PIXELS) {
		throw new Error(`thumbnail dimensions ${dims.width}x${dims.height} exceed the safety limit`)
	}

	return res.body
}

/** Fetches an image and generates a thumbnail for it */
const getCompressedJpegThumbnail = async (url: string, { thumbnailWidth, fetchOpts }: URLGenerationOptions) => {
	// AunuBaileys (1.0.72, HB-89; 1.0.85): the download is capped by
	// the safe fetch (5 MiB, throw) before the bytes reach the image
	// library, and pixel bombs are refused up front.
	const buffer = await fetchThumbnailBuffer(url, fetchOpts)
	const result = await extractImageThumb(buffer, thumbnailWidth)
	return result
}

/**
 * Given a piece of text, checks for any URL present, generates link preview for the same and returns it
 * Return undefined if the fetch failed or no URL was found
 * @param text first matched URL in text
 * @returns the URL info required to generate link preview
 */
export const getUrlInfo = async (
	text: string,
	opts: URLGenerationOptions = {
		thumbnailWidth: THUMBNAIL_WIDTH_PX,
		fetchOpts: { timeout: 3000 }
	}
): Promise<WAUrlInfo | undefined> => {
	try {
		const { getPreviewFromContent } = await import('link-preview-js')
		let previewLink = text
		if (!text.startsWith('https://') && !text.startsWith('http://')) {
			previewLink = 'https://' + previewLink
		}

		const res = await safeHttpGet(previewLink, {
			...transportOpts(opts.fetchOpts),
			maxBytes: MAX_HTML_BYTES,
			onLimit: 'truncate',
			shouldReadBody: (_status: number, headers: Record<string, string>) =>
				!headers['content-type'] || HTMLISH.test(headers['content-type'])
		})
		const contentType = res.headers['content-type']
		const info: any = await getPreviewFromContent({
			url: res.url,
			data: decodeBody(res.body, contentType),
			headers: contentType ? { 'content-type': contentType } : {}
		} as never)
		if (info && 'title' in info && info.title) {
			const [image] = info.images

			const urlInfo: WAUrlInfo = {
				'canonical-url': info.url,
				'matched-text': text,
				title: info.title,
				description: info.description,
				originalThumbnailUrl: image
			}

			if (opts.uploadImage && image) {
				// AunuBaileys (1.0.85): the high-quality thumbnail is
				// fetched through the safe fetch as a Buffer instead of
				// handing the page-supplied URL to the generic media
				// pipeline. The `&& image` guard also closes HB-150: a
				// page without an og:image used to explode here with a
				// raw TypeError and lose the whole preview.
				const thumb = await fetchThumbnailBuffer(image, opts.fetchOpts)
				const { imageMessage } = await prepareWAMessageMedia(
					{ image: thumb },
					{
						upload: opts.uploadImage,
						mediaTypeOverride: 'thumbnail-link',
						options: opts.fetchOpts
					}
				)
				urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : undefined
				urlInfo.highQualityThumbnail = imageMessage || undefined
			} else {
				try {
					urlInfo.jpegThumbnail = image ? (await getCompressedJpegThumbnail(image, opts)).buffer : undefined
				} catch (error: any) {
					opts.logger?.debug({ err: error.stack, url: previewLink }, 'error in generating thumbnail')
				}
			}

			return urlInfo
		}
	} catch (error: any) {
		if (!error.message.includes('receive a valid')) {
			throw error
		}
	}
}

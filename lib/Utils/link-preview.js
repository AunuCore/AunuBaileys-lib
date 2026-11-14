import { prepareWAMessageMedia } from './messages.js';
import { extractImageThumb } from './messages-media.js';
import { readImageDimensions, safeHttpGet } from './safe-fetch.js';
const THUMBNAIL_WIDTH_PX = 192;
// AunuBaileys (1.0.85): everything in this module is fetched on behalf
// of a REMOTE PAGE — the URL comes from message text and the og:image
// from the fetched page itself — so all of it now goes through the
// SSRF-safe fetch (lib/Utils/safe-fetch.js): non-public addresses are
// refused at connect time (peer-supplied URLs used to be able to make
// the host GET loopback / RFC1918 / cloud-metadata addresses), and
// every response is size- and time-bounded. link-preview-js is used
// for HTML parsing ONLY (getPreviewFromContent); it no longer
// performs any network access, so the protections do not depend on
// the installed link-preview-js version. This also closes HB-205:
// the HTML body used to be read in full with no cap and no overall
// timeout (the library's abort timer covered only time-to-headers).
const MAX_HTML_BYTES = 1024 * 1024; // og: tags live in <head>; the rest is cut off
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
const MAX_THUMBNAIL_PIXELS = 40000000; // refuse decompression bombs before the image library sees them
const MAX_PREVIEW_TIMEOUT_MS = 30000;
const HTMLISH = /^(text\/html|application\/xhtml\+xml|text\/xml|application\/xml)\b/i;
/** Only these keys of the caller's fetchOpts are honoured now. */
const transportOpts = (fetchOpts = {}) => ({
    // Sanitised at the boundary: a finite positive timeout is honored
    // (clamped to a sane preview ceiling), anything else gets the
    // historical 3000 ms default.
    timeout: typeof fetchOpts.timeout === 'number' && Number.isFinite(fetchOpts.timeout) && fetchOpts.timeout > 0
        ? Math.min(fetchOpts.timeout, MAX_PREVIEW_TIMEOUT_MS)
        : 3000,
    headers: fetchOpts.headers,
    // Explicit, host-controlled hooks only — never derived from
    // message content: an opt-in for deployments that really want
    // previews of intranet links, and resolver/policy overrides.
    allowPrivateNetworks: fetchOpts.allowPrivateNetworks === true,
    isBlocked: typeof fetchOpts.isBlockedAddress === 'function' ? fetchOpts.isBlockedAddress : undefined,
    lookup: typeof fetchOpts.lookup === 'function' ? fetchOpts.lookup : undefined
});
const decodeBody = (body, contentType) => {
    const charset = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
    try {
        return new TextDecoder(charset || 'utf-8').decode(body);
    }
    catch {
        return new TextDecoder('utf-8').decode(body);
    }
};
/** Fetches an og:image through the safe fetch, with byte + pixel bounds. */
const fetchThumbnailBuffer = async (imageUrl, fetchOpts) => {
    const res = await safeHttpGet(imageUrl, {
        ...transportOpts(fetchOpts),
        maxBytes: MAX_THUMBNAIL_BYTES,
        onLimit: 'throw'
    });
    const dims = readImageDimensions(res.body);
    if (dims && dims.width * dims.height > MAX_THUMBNAIL_PIXELS) {
        throw new Error(`thumbnail dimensions ${dims.width}x${dims.height} exceed the safety limit`);
    }
    return res.body;
};
/** Fetches an image and generates a thumbnail for it */
const getCompressedJpegThumbnail = async (url, { thumbnailWidth, fetchOpts }) => {
    // AunuBaileys (1.0.72): an og:image only ever becomes a small
    // JPEG — cap the source download instead of buffering a hostile
    // endless stream in full (HB-89). (1.0.85): the cap is now
    // enforced by the safe fetch (5 MiB, throw) before the bytes
    // reach the image library, and pixel bombs are refused up front.
    const buffer = await fetchThumbnailBuffer(url, fetchOpts);
    const result = await extractImageThumb(buffer, thumbnailWidth);
    return result;
};
/**
 * Given a piece of text, checks for any URL present, generates link preview for the same and returns it
 * Return undefined if the fetch failed or no URL was found
 * @param text first matched URL in text
 * @returns the URL info required to generate link preview
 */
export const getUrlInfo = async (text, opts = {
    thumbnailWidth: THUMBNAIL_WIDTH_PX,
    fetchOpts: { timeout: 3000 }
}) => {
    try {
        const { getPreviewFromContent } = await import('link-preview-js');
        let previewLink = text;
        if (!text.startsWith('https://') && !text.startsWith('http://')) {
            previewLink = 'https://' + previewLink;
        }
        const res = await safeHttpGet(previewLink, {
            ...transportOpts(opts.fetchOpts),
            maxBytes: MAX_HTML_BYTES,
            onLimit: 'truncate',
            shouldReadBody: (_status, headers) => !headers['content-type'] || HTMLISH.test(headers['content-type'])
        });
        const contentType = res.headers['content-type'];
        const info = await getPreviewFromContent({
            url: res.url,
            data: decodeBody(res.body, contentType),
            headers: contentType ? { 'content-type': contentType } : {}
        });
        if (info && 'title' in info && info.title) {
            const [image] = info.images;
            const urlInfo = {
                'canonical-url': info.url,
                'matched-text': text,
                title: info.title,
                description: info.description,
                originalThumbnailUrl: image
            };
            if (opts.uploadImage && image) {
                // AunuBaileys (1.0.85): the high-quality thumbnail is
                // fetched through the safe fetch as a Buffer instead
                // of handing the page-supplied URL to the generic
                // media pipeline. The `&& image` guard also closes
                // HB-150: a page without an og:image used to explode
                // here with a raw TypeError and lose the whole
                // preview.
                const thumb = await fetchThumbnailBuffer(image, opts.fetchOpts);
                const { imageMessage } = await prepareWAMessageMedia({ image: thumb }, {
                    upload: opts.uploadImage,
                    mediaTypeOverride: 'thumbnail-link',
                    options: opts.fetchOpts
                });
                urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : undefined;
                urlInfo.highQualityThumbnail = imageMessage || undefined;
            }
            else {
                try {
                    urlInfo.jpegThumbnail = image ? (await getCompressedJpegThumbnail(image, opts)).buffer : undefined;
                }
                catch (error) {
                    opts.logger?.debug({ err: error.stack, url: previewLink }, 'error in generating thumbnail');
                }
            }
            return urlInfo;
        }
    }
    catch (error) {
        if (!error.message.includes('receive a valid')) {
            throw error;
        }
    }
};
//# sourceMappingURL=link-preview.js.map

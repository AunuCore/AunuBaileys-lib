import { Boom } from '@hapi/boom';
import { createHash } from 'crypto';
import { once } from 'events';
import { createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString } from '../WABinary/index.js';
import { generateMessageIDV2 } from './generics.js';
import { asMediaBufferChunk, getStream, getUrlFromDirectPath, sanitizeMediaTimeoutMs } from './messages-media.js';
export const parseCatalogNode = (node) => {
    const catalogNode = getBinaryNodeChild(node, 'product_catalog');
    const products = getBinaryNodeChildren(catalogNode, 'product').map(parseProductNode);
    const paging = getBinaryNodeChild(catalogNode, 'paging');
    return {
        products,
        nextPageCursor: paging ? getBinaryNodeChildString(paging, 'after') : undefined
    };
};
export const parseCollectionsNode = (node) => {
    const collectionsNode = getBinaryNodeChild(node, 'collections');
    const collections = getBinaryNodeChildren(collectionsNode, 'collection').map(collectionNode => {
        const id = getBinaryNodeChildString(collectionNode, 'id');
        const name = getBinaryNodeChildString(collectionNode, 'name');
        const products = getBinaryNodeChildren(collectionNode, 'product').map(parseProductNode);
        return {
            id,
            name,
            products,
            status: parseStatusInfo(collectionNode)
        };
    });
    return {
        collections
    };
};
export const parseOrderDetailsNode = (node) => {
    // AunuBaileys (2.7.0, HB-435 facet 1): getOrderDetails passes
    // the query() result straight here — on an IQ timeout that
    // result is undefined, and the parser used to fabricate
    // { price: { total: NaN, currency: undefined }, products: [] }
    // out of the missing node instead of failing.
    if (!node) {
        throw new Boom('Order details request timed out or returned no response', { statusCode: 408 });
    }
    const orderNode = getBinaryNodeChild(node, 'order');
    const products = getBinaryNodeChildren(orderNode, 'product').map(productNode => {
        const imageNode = getBinaryNodeChild(productNode, 'image');
        return {
            id: getBinaryNodeChildString(productNode, 'id'),
            name: getBinaryNodeChildString(productNode, 'name'),
            imageUrl: getBinaryNodeChildString(imageNode, 'url'),
            price: +getBinaryNodeChildString(productNode, 'price'),
            currency: getBinaryNodeChildString(productNode, 'currency'),
            quantity: +getBinaryNodeChildString(productNode, 'quantity')
        };
    });
    const priceNode = getBinaryNodeChild(orderNode, 'price');
    const orderDetails = {
        price: {
            total: +getBinaryNodeChildString(priceNode, 'total'),
            currency: getBinaryNodeChildString(priceNode, 'currency')
        },
        products
    };
    return orderDetails;
};
// AunuBaileys (2.7.0, HB-208 toProductNode facet): the string
// fields below were guarded only with typeof !== 'undefined', so
// a number/object value reached Buffer.from(...) and threw a raw
// TypeError with no statusCode. Each field now rejects
// non-strings with Boom 400. price is deliberately excluded —
// its .toString() legitimately accepts numbers.
export const toProductNode = (productId, product) => {
    const attrs = {};
    const content = [];
    if (typeof productId !== 'undefined') {
        if (typeof productId !== 'string') {
            throw new Boom('Invalid product: id must be a string', { statusCode: 400 });
        }
        content.push({
            tag: 'id',
            attrs: {},
            content: Buffer.from(productId)
        });
    }
    if (typeof product.name !== 'undefined') {
        if (typeof product.name !== 'string') {
            throw new Boom('Invalid product: name must be a string', { statusCode: 400 });
        }
        content.push({
            tag: 'name',
            attrs: {},
            content: Buffer.from(product.name)
        });
    }
    if (typeof product.description !== 'undefined') {
        if (typeof product.description !== 'string') {
            throw new Boom('Invalid product: description must be a string', { statusCode: 400 });
        }
        content.push({
            tag: 'description',
            attrs: {},
            content: Buffer.from(product.description)
        });
    }
    if (typeof product.retailerId !== 'undefined') {
        if (typeof product.retailerId !== 'string') {
            throw new Boom('Invalid product: retailerId must be a string', { statusCode: 400 });
        }
        content.push({
            tag: 'retailer_id',
            attrs: {},
            content: Buffer.from(product.retailerId)
        });
    }
    // AunuBaileys (2.0.5, HB-330): images is optional in a product
    // update (e.g. a price-only update carries none) — the unguarded
    // .length threw a raw TypeError. Restores the v6 HB-73 guard lost
    // in the v7 rebase.
    if (product.images?.length) {
        content.push({
            tag: 'media',
            attrs: {},
            content: product.images.map(img => {
                // AunuBaileys (2.6.0, HB-208 addendum situs ke-3):
                // the `'url' in img` check below threw a raw
                // TypeError for a plain-string/null/undefined image
                // before the intended Boom 400 could run. Validate
                // the shape first.
                if (!img || typeof img !== 'object' || !('url' in img)) {
                    throw new Boom('Expected img for product to already be uploaded', { statusCode: 400 });
                }
                // AunuBaileys (2.7.0, HB-208 site-3 facet 2): a
                // present-but-null/undefined url passed the
                // container guard above and then threw a raw
                // TypeError on img.url.toString() below.
                if (img.url == null) {
                    throw new Boom('Expected img for product to already be uploaded', { statusCode: 400 });
                }
                return {
                    tag: 'image',
                    attrs: {},
                    content: [
                        {
                            tag: 'url',
                            attrs: {},
                            content: Buffer.from(img.url.toString())
                        }
                    ]
                };
            })
        });
    }
    // AunuBaileys (2.8.0, HB-208 addendum): the guard only excluded
    // undefined — a null price (JSON-minded host) died on .toString()
    // with a raw TypeError. Treat null like undefined, here and for
    // isHidden below.
    if (typeof product.price !== 'undefined' && product.price !== null) {
        content.push({
            tag: 'price',
            attrs: {},
            content: Buffer.from(product.price.toString())
        });
    }
    if (typeof product.currency !== 'undefined') {
        if (typeof product.currency !== 'string') {
            throw new Boom('Invalid product: currency must be a string', { statusCode: 400 });
        }
        content.push({
            tag: 'currency',
            attrs: {},
            content: Buffer.from(product.currency)
        });
    }
    if ('originCountryCode' in product) {
        if (typeof product.originCountryCode === 'undefined') {
            attrs['compliance_category'] = 'COUNTRY_ORIGIN_EXEMPT';
        }
        else {
            if (typeof product.originCountryCode !== 'string') {
                throw new Boom('Invalid product: originCountryCode must be a string', { statusCode: 400 });
            }
            content.push({
                tag: 'compliance_info',
                attrs: {},
                content: [
                    {
                        tag: 'country_code_origin',
                        attrs: {},
                        content: Buffer.from(product.originCountryCode)
                    }
                ]
            });
        }
    }
    if (typeof product.isHidden !== 'undefined' && product.isHidden !== null) {
        attrs['is_hidden'] = product.isHidden.toString();
    }
    const node = {
        tag: 'product',
        attrs,
        content
    };
    return node;
};
export const parseProductNode = (productNode) => {
    // AunuBaileys (2.1.0, HB-304, donor v6 1.0.70): an IQ without a <product> child used to throw a raw TypeError here.
    if (!productNode?.attrs) {
        throw new Boom('Product node is missing from the response', { statusCode: 400 });
    }
    const isHidden = productNode.attrs.is_hidden === 'true';
    const id = getBinaryNodeChildString(productNode, 'id');
    const mediaNode = getBinaryNodeChild(productNode, 'media');
    const statusInfoNode = getBinaryNodeChild(productNode, 'status_info');
    const product = {
        id,
        imageUrls: parseImageUrls(mediaNode),
        reviewStatus: {
            whatsapp: getBinaryNodeChildString(statusInfoNode, 'status')
        },
        availability: 'in stock',
        name: getBinaryNodeChildString(productNode, 'name'),
        retailerId: getBinaryNodeChildString(productNode, 'retailer_id'),
        url: getBinaryNodeChildString(productNode, 'url'),
        description: getBinaryNodeChildString(productNode, 'description'),
        price: +getBinaryNodeChildString(productNode, 'price'),
        currency: getBinaryNodeChildString(productNode, 'currency'),
        isHidden
    };
    return product;
};
/**
 * Uploads images not already uploaded to WA's servers
 */
export async function uploadingNecessaryImagesOfProduct(product, waUploadToServer, timeoutMs = 30000) {
    product = {
        ...product,
        images: product.images
            ? await uploadingNecessaryImages(product.images, waUploadToServer, timeoutMs)
            : product.images
    };
    return product;
}
// AunuBaileys (1.0.72, HB-87, re-applied P3b): bound for a single
// product-catalog image download in uploadingNecessaryImages.
// Catalog images are a few MB at most; 16MB is generous headroom,
// not a target.
const MAX_PRODUCT_IMAGE_BYTES = 16 * 1024 * 1024;
/**
 * Uploads images not already uploaded to WA's servers
 */
export const uploadingNecessaryImages = async (images, waUploadToServer, timeoutMs = 30000) => {
    const results = await Promise.all(images.map(async (img) => {
        // AunuBaileys (2.6.0, HB-208 addendum situs ke-3): a
        // plain-string/null/undefined image threw a raw TypeError
        // on the `'url' in img` check below, before getStream's
        // own Boom 400 could run. Reject the shape here, with
        // the same Boom 400; Buffers, streams and {url} objects
        // all pass through unchanged.
        if (!img || typeof img !== 'object') {
            throw new Boom('Invalid product image: expected an uploaded media object or a media source', { statusCode: 400 });
        }
        if ('url' in img) {
            // AunuBaileys (2.7.0, HB-208 site-3 facet 2): a
            // present-but-null/undefined url passed the
            // container guard above and then threw a raw
            // TypeError on toString().
            if (img.url == null) {
                throw new Boom('Expected img for product to already be uploaded', { statusCode: 400 });
            }
            const url = img.url.toString();
            // AunuBaileys (2.7.0, HB-488): the "already
            // uploaded" check used to substring-match
            // '.whatsapp.net' over the WHOLE url — a URL
            // carrying that substring in its path or query
            // was returned verbatim as a product image
            // without ever being uploaded. Match the
            // hostname against the WA media hosts instead.
            let hostname;
            try {
                hostname = new URL(url).hostname;
            }
            catch {
                hostname = undefined;
            }
            if (hostname && (hostname === 'whatsapp.net' || hostname.endsWith('.whatsapp.net'))) {
                return { url };
            }
        }
        // AunuBaileys (2.2.0, HB-344): timeoutMs only reached
        // the upload half — the download streamed unbounded, so
        // a trickling catalog image hung productCreate /
        // productUpdate forever. Bound the download with the
        // same budget.
        // AunuBaileys (2.3.0, HB-392 addendum): the budget is
        // sanitised — a raw NaN/negative threw a synchronous
        // RangeError and 0 aborted every healthy image fetch.
        const { stream } = await getStream(img, {
            maxContentLength: MAX_PRODUCT_IMAGE_BYTES,
            signal: AbortSignal.timeout(sanitizeMediaTimeoutMs(timeoutMs, 30000))
        });
        const hasher = createHash('sha256');
        const filePath = join(tmpdir(), 'img' + generateMessageIDV2());
        const encFileWriteStream = createWriteStream(filePath);
        // AunuBaileys (2.1.0, addendum HB-273, third site): same root as
        // the two messages-media.ts sites fixed in P4 - this write stream
        // had no persistent 'error' listener, so an open/write failure
        // (bad tmpdir, disk full) that fired while the loop awaited the
        // next input chunk escaped as an uncaught 'error' event and
        // crashed the host process. Capture the first error, race every
        // drain/finish wait against it, and throw it into the loop.
        let writeError;
        let rejectWriteError = () => { };
        const writeErrorPromise = new Promise((_resolve, reject) => {
            rejectWriteError = reject;
        });
        writeErrorPromise.catch(() => { });
        encFileWriteStream.on('error', err => {
            if (!writeError) {
                writeError = err;
                rejectWriteError(err);
            }
        });
        // AunuBaileys (1.0.72, HB-85/86/87, re-applied P3b):
        // three fixes in this block. The uploader used to read
        // the tmp file BEFORE the write stream was ended/
        // flushed (0-byte or truncated uploads whose sha did
        // not match the file), a failed upload leaked the tmp
        // file (no try/finally), and a remote image URL was
        // streamed with no size bound at all. Now: count bytes
        // against a cap while writing (with drain), end +
        // await finish before uploading, and always unlink in
        // a finally.
        try {
            let bytes = 0;
            for await (const rawBlock of stream) {
                // AunuBaileys (2.7.0, HB-208 site-5): this
                // loop used the chunk as-is — string chunks
                // were counted per CHARACTER, not per byte
                // (10M '€' chars = 30 MB on disk counted as
                // 10M, evading the 16 MiB cap), and a
                // non-Buffer chunk threw a raw TypeError
                // from hasher.update. Normalise exactly
                // like the site-4 media fix.
                const block = asMediaBufferChunk(rawBlock);
                bytes += block.length;
                if (bytes > MAX_PRODUCT_IMAGE_BYTES) {
                    throw new Boom(`product image exceeds the ${MAX_PRODUCT_IMAGE_BYTES} byte limit`, {
                        statusCode: 413
                    });
                }
                hasher.update(block);
                if (!encFileWriteStream.write(block)) {
                    await Promise.race([once(encFileWriteStream, 'drain'), writeErrorPromise]);
                }
            }
            // HB-273: a write failure captured during the loop aborts the
            // upload here, before the finish-wait below.
            if (writeError) {
                throw writeError;
            }
            encFileWriteStream.end();
            await Promise.race([once(encFileWriteStream, 'finish'), writeErrorPromise]);
            const sha = hasher.digest('base64');
            const { directPath } = await waUploadToServer(filePath, {
                mediaType: 'product-catalog-image',
                fileEncSha256B64: sha,
                timeoutMs
            });
            // AunuBaileys (2.6.0, HB-427 addendum facet 2): an
            // upload host that answers url-only (no directPath)
            // used to reach getUrlFromDirectPath(undefined) and
            // throw a raw TypeError. Fail with a Boom 400 at the
            // choke point instead — the product image cannot be
            // addressed without a path.
            if (!directPath) {
                throw new Boom('Media upload host returned no directPath', { statusCode: 400 });
            }
            return { url: getUrlFromDirectPath(directPath) };
        }
        finally {
            encFileWriteStream.destroy();
            await fs.unlink(filePath).catch(() => { });
        }
    }));
    return results;
};
const parseImageUrls = (mediaNode) => {
    const imgNode = getBinaryNodeChild(mediaNode, 'image');
    return {
        requested: getBinaryNodeChildString(imgNode, 'request_image_url'),
        original: getBinaryNodeChildString(imgNode, 'original_image_url')
    };
};
const parseStatusInfo = (mediaNode) => {
    const node = getBinaryNodeChild(mediaNode, 'status_info');
    return {
        status: getBinaryNodeChildString(node, 'status'),
        canAppeal: getBinaryNodeChildString(node, 'can_appeal') === 'true'
    };
};
//# sourceMappingURL=business.js.map
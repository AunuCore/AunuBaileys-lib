// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
/**
 * AunuBaileys (1.0.71): universal view-once — one wrapper for ANY message
 * content (text, media, buttons, lists, carousel, product, location,
 * contact, rich responses), not just the media path.
 *
 * Flag values (`viewOnce` on the content — a boolean keeps the old
 * behaviour, a string/object selects the variant):
 *   true | 'v1' | 1       -> viewOnceMessage (default)
 *   'v2' | 2              -> viewOnceMessageV2
 *   'force' | 'v2-force'  -> as above, but also wraps types WhatsApp does
 *                           not officially show as view-once (sticker /
 *                           poll / album)
 *   { version: 1|2, force } -> object form
 */
export const AUNU_VIEW_ONCE_KEYS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
/** Control / protocol messages must never be wrapped, even with force. */
const NEVER_WRAP = new Set([
    'protocolMessage',
    'reactionMessage',
    'encReactionMessage',
    'pollUpdateMessage',
    'encEventResponseMessage',
    'keepInChatMessage',
    'pinInChatMessage',
    'buttonsResponseMessage',
    'listResponseMessage',
    'interactiveResponseMessage',
    'templateButtonReplyMessage',
    'senderKeyDistributionMessage',
    'editedMessage',
    'ephemeralMessage',
    'groupStatusMessage',
    'groupStatusMessageV2',
    'associatedChildMessage',
    'documentWithCaptionMessage'
]);
/** WhatsApp does not render these as view-once unless forced. */
const FORCE_ONLY = new Set([
    'albumMessage',
    'stickerMessage',
    'stickerPackMessage',
    'pollCreationMessage',
    'pollCreationMessageV2',
    'pollCreationMessageV3',
    'pollCreationMessageV5',
    'pollCreationMessageV6',
    'requestPhoneNumberMessage'
]);
/** Interactive types need a messageContextInfo inside the wrapper to render. */
const NEEDS_CONTEXT = new Set([
    'interactiveMessage',
    'buttonsMessage',
    'listMessage',
    'templateMessage',
    'productMessage',
    'eventMessage',
    'richResponseMessage'
]);
/** Media types also carry the viewOnce flag on the inner message itself. */
const MEDIA_INNER_FLAG = new Set(['imageMessage', 'videoMessage', 'audioMessage']);
/** The first content key of a proto-shaped message object, if any. */
export const aunuViewOnceInnerType = content => {
    if (!content || typeof content !== 'object') {
        return undefined;
    }
    return Object.keys(content).find(key => (key === 'conversation' || key.endsWith('Message')) &&
        key !== 'senderKeyDistributionMessage' &&
        content[key] != null);
};
/** Normalises any flag form to `{ key, force }`, or null when no wrapping. */
export const parseAunuViewOnce = flag => {
    if (!flag) {
        return null;
    }
    if (flag === true || flag === 'v1' || flag === 1) {
        return { key: 'viewOnceMessage', force: false };
    }
    if (flag === 'v2' || flag === 2) {
        return { key: 'viewOnceMessageV2', force: false };
    }
    if (flag === 'force') {
        return { key: 'viewOnceMessage', force: true };
    }
    if (flag === 'v2-force') {
        return { key: 'viewOnceMessageV2', force: true };
    }
    if (typeof flag === 'object') {
        return {
            key: Number(flag.version) === 2 || flag.version === 'v2' ? 'viewOnceMessageV2' : 'viewOnceMessage',
            force: !!flag.force
        };
    }
    return { key: 'viewOnceMessage', force: false };
};
export const isAunuViewOnceContent = content => !!content && AUNU_VIEW_ONCE_KEYS.some(key => !!content[key]);
/** Returns the inner content of a view-once wrapper, or the content itself. */
export const unwrapAunuViewOnce = content => {
    if (!content) {
        return content;
    }
    for (const key of AUNU_VIEW_ONCE_KEYS) {
        if (content[key]?.message) {
            return content[key].message;
        }
    }
    return content;
};
/**
 * Wraps proto-shaped message content in view-once. Idempotent; control
 * messages are never wrapped; sticker/poll/album only with force.
 */
export const wrapAunuViewOnce = (content, flag = true) => {
    const parsed = parseAunuViewOnce(flag);
    if (!parsed || !content || typeof content !== 'object') {
        return content;
    }
    if (isAunuViewOnceContent(content)) {
        return content;
    }
    const type = aunuViewOnceInnerType(content);
    if (!type || NEVER_WRAP.has(type)) {
        return content;
    }
    if (FORCE_ONLY.has(type) && !parsed.force) {
        return content;
    }
    const inner = { ...content };
    if (MEDIA_INNER_FLAG.has(type) && inner[type] && typeof inner[type] === 'object') {
        inner[type] = { ...inner[type], viewOnce: true };
    }
    if (NEEDS_CONTEXT.has(type) && !inner.messageContextInfo) {
        inner.messageContextInfo = { deviceListMetadata: {}, deviceListMetadataVersion: 2 };
    }
    return { [parsed.key]: { message: inner } };
};
/** Whether this content would actually be wrapped with this flag (diagnostics / tests). */
export const canWrapAunuViewOnce = (content, flag = true) => {
    const parsed = parseAunuViewOnce(flag);
    if (!parsed) {
        return false;
    }
    const type = aunuViewOnceInnerType(unwrapAunuViewOnce(content));
    if (!type || NEVER_WRAP.has(type)) {
        return false;
    }
    return parsed.force || !FORCE_ONLY.has(type);
};
/** The real content type + node behind a (possibly view-once-wrapped) message. */
export const getAunuViewOnceTarget = content => {
    const inner = unwrapAunuViewOnce(content);
    const type = aunuViewOnceInnerType(inner) ?? Object.keys(inner || {})[0];
    return { inner, type, node: type ? inner?.[type] : undefined };
};
//# sourceMappingURL=aunu-view-once.js.map
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
export declare const AUNU_VIEW_ONCE_KEYS: string[];
/** The first content key of a proto-shaped message object, if any. */
export declare const aunuViewOnceInnerType: (content: any) => string | undefined;
/** Normalises any flag form to `{ key, force }`, or null when no wrapping. */
export declare const parseAunuViewOnce: (flag: any) => {
    key: string;
    force: boolean;
} | null;
export declare const isAunuViewOnceContent: (content: any) => boolean;
/** Returns the inner content of a view-once wrapper, or the content itself. */
export declare const unwrapAunuViewOnce: (content: any) => any;
/**
 * Wraps proto-shaped message content in view-once. Idempotent; control
 * messages are never wrapped; sticker/poll/album only with force.
 */
export declare const wrapAunuViewOnce: (content: any, flag?: boolean) => any;
/** Whether this content would actually be wrapped with this flag (diagnostics / tests). */
export declare const canWrapAunuViewOnce: (content: any, flag?: boolean) => boolean;
/** The real content type + node behind a (possibly view-once-wrapped) message. */
export declare const getAunuViewOnceTarget: (content: any) => {
    inner: any;
    type: string | undefined;
    node: any;
};
//# sourceMappingURL=aunu-view-once.d.ts.map
/**
 * Encode a short string as an invisible zero-width sequence. Returns an
 * empty string for an empty payload.
 */
/**
 * EXPERIMENTAL (AunuBaileys-only): a small embedded PNG of the WhatsApp
 * "deleted account" avatar — a grey silhouette on light grey, drawn
 * programmatically (96x96, 375 bytes). Used by `aunuSideText` for the
 * deleted-profile side picture; exported so bots can reuse the look.
 */
export declare const DELETED_PROFILE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABPklEQVR4nO3aTWpCQRCFUVfvTHB1mSSLcZiAoETr56oHvgVUH3ryut7h6/tHNzqsTxAeIECAAAEKDhAgQIAABQcIECBAgIIDBAgQIEB/Op7O6zNkAR1P59t9LtBdmgSmHaB/0ewyLQA9rLNiNA30pM680ShQic6wEaAYoEKdSSNAGUDlOmNGgAABAvTuQE06M0ZuECBAgAAB8i0GKMxobGZASUDepCeMhqe1F4sEeoBpa0i7+Xiga6/1GaKB0gIECBAgQMEBAgQIEKDgAAEC9FlAnjt+IfLfW201koBKaOaZ/GG2CtRKM8PUCDSm02rUBTSs02fUArSi02RUD7So02FUDLSuU25UCbTu0mFUBrQu0mQEaARo3aLPCBCgdaB1hVYjQIAAAXploPXzdxu5QYAAAQL03kDJRs8fDdCdLjutlqODlBNDAAAAAElFTkSuQmCC";
export declare const getDeletedProfileImage: () => Buffer<ArrayBuffer>;
/**
 * EXPERIMENTAL: build the `externalAdReply` object behind `aunuSideText` —
 * a preview block with the picture at the side, the title where a name
 * sits, and the body text under the title. URLs are strictly
 * caller-supplied; nothing is ever substituted.
 */
export declare const buildSideTextAdReply: ({ title, body, thumbnail, url }?: {}) => {
    title: any;
    body: any;
    mediaType: number;
    renderLargerThumbnail: boolean;
    showAdAttribution: boolean;
};
/**
 * EXPERIMENTAL (1.0.55): parse a vanish duration into seconds. Accepts a
 * number (seconds) or a string with an s/m/h/d suffix ('30s', '5m',
 * '2h', '7d'); a bare numeric string means seconds. Throws on anything
 * else and on non-positive values.
 */
export declare const parseVanishDuration: (duration: any) => number;
/**
 * EXPERIMENTAL (1.0.56): build a plausible voice-note waveform — a
 * deterministic pseudo-random amplitude series (bytes), used by
 * `aunuFakeVN` so a short clip can carry a full, busy-looking wave.
 */
export declare const buildFakeWaveform: (samples?: number, seed?: number) => Buffer<ArrayBuffer>;
export declare const encodeWatermark: (payload: any) => string;
/** Append an invisible watermark carrying `payload` to `text`. */
export declare const appendWatermark: (text: any, payload: any) => string;
/**
 * Read back the payload hidden in `text` by encodeWatermark/appendWatermark.
 * Returns null when there is no well-formed watermark.
 */
export declare const extractWatermark: (text: any) => string | null;
/** Remove every watermark span from `text`, leaving the visible text intact. */
export declare const stripWatermark: (text: any) => any;
/**
 * How long a human would plausibly spend typing `text`, in milliseconds —
 * used by the experimental humanised send. Roughly `chars / cps`, clamped
 * to [minMs, maxMs], with up to ±20% jitter unless disabled.
 */
export declare const computeTypingDuration: (text: any, options?: {}) => number;
//# sourceMappingURL=aunu-experimental.d.ts.map
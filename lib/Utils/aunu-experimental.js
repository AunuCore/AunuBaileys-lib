// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
/**
 * AunuBaileys EXPERIMENTAL utilities — features that exist only in
 * AunuBaileys. Everything in this module is experimental: semantics may
 * change in any release. See lib/Socket/aunu-experimental.js for the
 * socket-level API built on top of these helpers.
 */
// Zero-width alphabet for the invisible text watermark. A payload is stored
// as UTF-8 bytes, each byte as 8 bits (MSB first), wrapped in markers so it
// can be found and removed again without touching visible text.
const WM_BIT0 = '\u200B'; // ZERO WIDTH SPACE (bit 0)
const WM_BIT1 = '\u200C'; // ZERO WIDTH NON-JOINER (bit 1)
const WM_START = '\u200D'; // ZERO WIDTH JOINER (span start)
const WM_END = '\u2060'; // WORD JOINER (span end)
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
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
export const DELETED_PROFILE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABPklEQVR4nO3aTWpCQRCFUVfvTHB1mSSLcZiAoETr56oHvgVUH3ryut7h6/tHNzqsTxAeIECAAAEKDhAgQIAABQcIECBAgIIDBAgQIEB/Op7O6zNkAR1P59t9LtBdmgSmHaB/0ewyLQA9rLNiNA30pM680ShQic6wEaAYoEKdSSNAGUDlOmNGgAABAvTuQE06M0ZuECBAgAAB8i0GKMxobGZASUDepCeMhqe1F4sEeoBpa0i7+Xiga6/1GaKB0gIECBAgQMEBAgQIEKDgAAEC9FlAnjt+IfLfW201koBKaOaZ/GG2CtRKM8PUCDSm02rUBTSs02fUArSi02RUD7So02FUDLSuU25UCbTu0mFUBrQu0mQEaARo3aLPCBCgdaB1hVYjQIAAAXploPXzdxu5QYAAAQL03kDJRs8fDdCdLjutlqODlBNDAAAAAElFTkSuQmCC';
export const getDeletedProfileImage = () => Buffer.from(DELETED_PROFILE_PNG_BASE64, 'base64');
/**
 * EXPERIMENTAL: build the `externalAdReply` object behind `aunuSideText` —
 * a preview block with the picture at the side, the title where a name
 * sits, and the body text under the title. URLs are strictly
 * caller-supplied; nothing is ever substituted.
 */
export const buildSideTextAdReply = ({ title, body, thumbnail, url } = {}) => {
    const ad = {
        title: title ?? '',
        body: body ?? '',
        mediaType: thumbnail ? 1 : 0,
        renderLargerThumbnail: false,
        showAdAttribution: false
    };
    if (thumbnail)
        ad.thumbnail = thumbnail;
    if (url) {
        ad.mediaUrl = url;
        ad.sourceUrl = url;
    }
    return ad;
};
/**
 * EXPERIMENTAL (1.0.55): parse a vanish duration into seconds. Accepts a
 * number (seconds) or a string with an s/m/h/d suffix ('30s', '5m',
 * '2h', '7d'); a bare numeric string means seconds. Throws on anything
 * else and on non-positive values.
 */
export const parseVanishDuration = duration => {
    if (typeof duration === 'number') {
        if (!Number.isFinite(duration) || duration < 1)
            throw new Error('aunuVanish: duration must be at least 1 second');
        return Math.floor(duration);
    }
    const match = /^\s*(\d+)\s*(s|m|h|d)?\s*$/i.exec(String(duration));
    if (!match)
        throw new Error(`aunuVanish: cannot parse duration ${JSON.stringify(duration)} (use seconds or '30s'/'5m'/'2h'/'7d')`);
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[(match[2] || 's').toLowerCase()];
    const seconds = parseInt(match[1], 10) * mult;
    if (seconds < 1)
        throw new Error('aunuVanish: duration must be at least 1 second');
    return seconds;
};
/**
 * EXPERIMENTAL (1.0.56): build a plausible voice-note waveform — a
 * deterministic pseudo-random amplitude series (bytes), used by
 * `aunuFakeVN` so a short clip can carry a full, busy-looking wave.
 */
export const buildFakeWaveform = (samples = 72, seed = 42) => {
    const out = Buffer.alloc(Math.max(8, samples | 0));
    let state = seed >>> 0 || 1;
    for (let i = 0; i < out.length; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        const wave = 0.55 + 0.45 * Math.sin(i / 3.1);
        out[i] = Math.max(8, Math.min(250, Math.round(((state % 100) / 100) * 255 * wave)));
    }
    return out;
};
export const encodeWatermark = payload => {
    if (!payload) {
        return '';
    }
    const bytes = textEncoder.encode(String(payload));
    let bits = '';
    for (const byte of bytes) {
        bits += byte.toString(2).padStart(8, '0');
    }
    return WM_START + [...bits].map(b => (b === '1' ? WM_BIT1 : WM_BIT0)).join('') + WM_END;
};
/** Append an invisible watermark carrying `payload` to `text`. */
export const appendWatermark = (text, payload) => String(text ?? '') + encodeWatermark(payload);
/**
 * Read back the payload hidden in `text` by encodeWatermark/appendWatermark.
 * Returns null when there is no well-formed watermark.
 */
export const extractWatermark = text => {
    if (typeof text !== 'string') {
        return null;
    }
    const start = text.indexOf(WM_START);
    if (start < 0) {
        return null;
    }
    const end = text.indexOf(WM_END, start + 1);
    if (end < 0) {
        return null;
    }
    let bits = '';
    for (const ch of text.slice(start + 1, end)) {
        if (ch === WM_BIT0) {
            bits += '0';
        }
        else if (ch === WM_BIT1) {
            bits += '1';
        }
        else {
            return null;
        }
    }
    if (bits.length === 0 || bits.length % 8 !== 0) {
        return null;
    }
    const bytes = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }
    try {
        return textDecoder.decode(bytes);
    }
    catch {
        return null;
    }
};
/** Remove every watermark span from `text`, leaving the visible text intact. */
export const stripWatermark = text => {
    if (typeof text !== 'string') {
        return text;
    }
    return text.replace(/\u200D[\u200B\u200C]*\u2060/g, '');
};
/**
 * How long a human would plausibly spend typing `text`, in milliseconds —
 * used by the experimental humanised send. Roughly `chars / cps`, clamped
 * to [minMs, maxMs], with up to ±20% jitter unless disabled.
 */
export const computeTypingDuration = (text, options = {}) => {
    const cps = options.cps && options.cps > 0 ? options.cps : 5;
    const minMs = options.minMs ?? 700;
    const maxMs = options.maxMs ?? 8000;
    const base = Math.round(((typeof text === 'string' ? text.length : 0) / cps) * 1000);
    const clamped = Math.min(maxMs, Math.max(minMs, base));
    if (options.jitter === false) {
        return clamped;
    }
    const jittered = Math.round(clamped * (0.8 + Math.random() * 0.4));
    return Math.min(maxMs, Math.max(minMs, jittered));
};
//# sourceMappingURL=aunu-experimental.js.map
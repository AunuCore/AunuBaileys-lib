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
export const encodeWatermark = (payload) => {
    if (!payload) {
        return '';
    }
    const bytes = textEncoder.encode(String(payload));
    let bits = '';
    for (const byte of bytes) {
        bits += byte.toString(2).padStart(8, '0');
    }
    return WM_START + [...bits].map((b) => (b === '1' ? WM_BIT1 : WM_BIT0)).join('') + WM_END;
};
/** Append an invisible watermark carrying `payload` to `text`. */
export const appendWatermark = (text, payload) => String(text ?? '') + encodeWatermark(payload);
/**
 * Read back the payload hidden in `text` by encodeWatermark/appendWatermark.
 * Returns null when there is no well-formed watermark.
 */
export const extractWatermark = (text) => {
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
export const stripWatermark = (text) => {
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

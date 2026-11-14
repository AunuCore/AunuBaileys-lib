// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
/**
 * AunuBaileys (1.0.71): VoIP E2E rekey payload decoding — pure util.
 *
 * A rekey payload (proto.E2eRekeyPayload) carries the fresh media keys
 * for a VoIP call: one entry per media kind (audio / video / appdata).
 * Decoding is pure; what the host does with the keys (re-encrypting
 * call media) is outside this module.
 */
import { proto } from '../../WAProto/index.js';
const AUNU_REKEY_TYPE_NAMES = {
    [proto.RekeyKeyType.REKEY_KEY_AUDIO]: 'REKEY_KEY_AUDIO',
    [proto.RekeyKeyType.REKEY_KEY_VIDEO]: 'REKEY_KEY_VIDEO',
    [proto.RekeyKeyType.REKEY_KEY_APPDATA]: 'REKEY_KEY_APPDATA'
};
/**
 * Decode an E2E VoIP rekey payload buffer into a structured object.
 * @param {Buffer|Uint8Array} buffer raw bytes of proto.E2eRekeyPayload
 * @returns {{ keys: Array<{ type: string|number, key: Buffer }> }}
 */
export const decodeAunuE2eRekeyPayload = buffer => {
    if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
        throw new TypeError('decodeAunuE2eRekeyPayload: buffer must be Buffer or Uint8Array');
    }
    const decoded = proto.E2eRekeyPayload.decode(buffer);
    return {
        keys: (decoded.keys || []).map(entry => ({
            type: AUNU_REKEY_TYPE_NAMES[entry.type] ?? entry.type,
            key: entry.key ? Buffer.from(entry.key) : Buffer.alloc(0)
        }))
    };
};
//# sourceMappingURL=aunu-voip-rekey.js.map
// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
/**
 * AunuBaileys (1.0.71): group-history decoding — pure util, no socket.
 *
 * WhatsApp can ship a group's recent history as one protobuf blob
 * (proto.GroupHistory, or the GroupHistoryWithMessageBytes variant whose
 * entries carry raw messageBytes instead of decoded WebMessageInfo).
 * The blob is usually zlib-compressed. This module decodes it and, for
 * the WithMessageBytes variant, expands each entry's messageBytes into
 * a WebMessageInfo. It is deliberately NOT wired into the receive path:
 * no stanza in our tree produces such a blob yet, so there is no safe
 * trigger to hook it to — call it from host code that obtains a blob.
 */
import { inflateSync } from 'zlib';
import { proto } from '../../WAProto/index.js';
/**
 * Decode a GroupHistory protobuf blob.
 * @param {Buffer|Uint8Array} buffer raw bytes, optionally zlib-compressed
 * @param {object} [options]
 * @param {boolean} [options.inflate=true] try zlib.inflateSync first,
 *   falling back to the raw bytes when the blob is not compressed
 * @param {boolean} [options.withMessageBytes=false] decode the
 *   GroupHistoryWithMessageBytes variant, expanding each entry's
 *   messageBytes into a WebMessageInfo
 * @returns {proto.GroupHistory|{messages, commentMessages,
 *   outOfWindowPinnedMessages, uncountedAssociatedMessageLists}}
 */
export const decodeAunuGroupHistory = (buffer, options = {}) => {
    const { inflate = true, withMessageBytes = false } = options;
    if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
        throw new TypeError('decodeAunuGroupHistory: buffer must be Buffer or Uint8Array');
    }
    let data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (inflate) {
        try {
            data = inflateSync(data);
        }
        catch {
            // Not zlib-compressed — use the raw bytes.
        }
    }
    if (withMessageBytes) {
        const decoded = proto.GroupHistoryWithMessageBytes.decode(data);
        const expand = list => (list || []).map(entry => entry?.messageBytes ? proto.WebMessageInfo.decode(entry.messageBytes) : { key: entry?.key });
        return {
            messages: expand(decoded.messages),
            commentMessages: expand(decoded.commentMessages),
            outOfWindowPinnedMessages: expand(decoded.outOfWindowPinnedMessages),
            uncountedAssociatedMessageLists: (decoded.uncountedAssociatedMessageLists || []).map(l => ({
                parentMessage: l.parentMessage,
                messages: expand(l.messages)
            }))
        };
    }
    return proto.GroupHistory.decode(data);
};
/**
 * Normalize a decoded GroupHistory (either shape) into stable buckets.
 * @param {object} groupHistory a decoded proto.GroupHistory, or the
 *   withMessageBytes shape returned by decodeAunuGroupHistory
 */
export const processAunuGroupHistory = groupHistory => {
    const gh = groupHistory || {};
    return {
        messages: gh.messages || [],
        commentMessages: gh.commentMessages || [],
        outOfWindowPinnedMessages: gh.outOfWindowPinnedMessages || [],
        uncountedAssociatedMessageLists: gh.uncountedAssociatedMessageLists || []
    };
};
//# sourceMappingURL=aunu-group-history.js.map
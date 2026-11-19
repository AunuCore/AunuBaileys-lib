import { waproto } from '../../WAProto/index.js';
/**
 * Decode a GroupHistory protobuf blob.
 * @param {Buffer|Uint8Array} buffer raw bytes, optionally zlib-compressed
 * @param {object} [options]
 * @param {boolean} [options.inflate=true] try zlib.inflateSync first,
 *   falling back to the raw bytes when the blob is not compressed
 * @param {boolean} [options.withMessageBytes=false] decode the
 *   GroupHistoryWithMessageBytes variant, expanding each entry's
 *   messageBytes into a WebMessageInfo
 * @returns {waproto.GroupHistory|{messages, commentMessages,
 *   outOfWindowPinnedMessages, uncountedAssociatedMessageLists}}
 */
export declare const decodeAunuGroupHistory: (buffer: any, options?: {}) => waproto.GroupHistory | {
    messages: any;
    commentMessages: any;
    outOfWindowPinnedMessages: any;
    uncountedAssociatedMessageLists: {
        parentMessage: waproto.IMessageKey | null | undefined;
        messages: any;
    }[];
};
/**
 * Normalize a decoded GroupHistory (either shape) into stable buckets.
 * @param {object} groupHistory a decoded waproto.GroupHistory, or the
 *   withMessageBytes shape returned by decodeAunuGroupHistory
 */
export declare const processAunuGroupHistory: (groupHistory: any) => {
    messages: any;
    commentMessages: any;
    outOfWindowPinnedMessages: any;
    uncountedAssociatedMessageLists: any;
};
//# sourceMappingURL=aunu-group-history.d.ts.map
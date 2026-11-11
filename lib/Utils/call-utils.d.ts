import type { BinaryNode } from '../WABinary/index.js';
export declare const newCallId: () => string;
export declare const createCallKey: () => Uint8Array;
export declare const buildCallOfferContent: (isVideo?: boolean) => BinaryNode[];
export declare const buildCallControlStanza: (opts: {
    from: string;
    to: string;
    action: 'accept' | 'terminate' | 'reject';
    callId: string;
    callCreator: string;
    reason?: string;
}) => BinaryNode;
export declare const buildGroupCallStanza: (opts: {
    id: string;
    to: string;
    callId: string;
    callCreator: string;
    offerContent: BinaryNode[];
}) => BinaryNode;
export declare const buildGroupCallCancelStanza: (opts: {
    from: string;
    to: string;
    callId: string;
    callCreator: string;
}) => BinaryNode;

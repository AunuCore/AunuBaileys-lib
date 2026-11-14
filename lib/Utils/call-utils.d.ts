import type { BinaryNode } from '../WABinary/index.js';
/** ID panggilan baru: 32 karakter hex huruf besar. */
export declare const newCallId: () => string;
/** Kunci media panggilan baru (32 byte) untuk amplop destination terenkripsi. */
export declare const createCallKey: () => Uint8Array;
/**
 * Isi node <offer> untuk panggilan 1:1 maupun grup: codec audio opus
 * (16 kHz + 8 kHz), video vp8 opsional, net, capability, dan encopt.
 * Node destination/device-identity ditambahkan pemanggil setelah sesi siap.
 */
export declare const buildCallOfferContent: (isVideo?: boolean) => BinaryNode[];
/** Stanza <call> berisi satu node kontrol (accept / terminate / reject). */
export declare const buildCallControlStanza: ({ from, to, action, callId, callCreator, reason }: {
    from: string;
    to: string;
    action: "accept" | "terminate" | "reject";
    callId: string;
    callCreator: string;
    reason?: string;
}) => BinaryNode;
/** Stanza <call><offer type="group" group-jid=..> untuk memulai panggilan grup. */
export declare const buildGroupCallStanza: ({ id, to, callId, callCreator, offerContent }: {
    id: string;
    to: string;
    callId: string;
    callCreator: string;
    offerContent: BinaryNode[];
}) => BinaryNode;
/** Stanza <call><terminate> untuk membatalkan/mengakhiri panggilan grup. */
export declare const buildGroupCallCancelStanza: ({ from, to, callId, callCreator }: {
    from: string;
    to: string;
    callId: string;
    callCreator: string;
}) => BinaryNode;
//# sourceMappingURL=call-utils.d.ts.map
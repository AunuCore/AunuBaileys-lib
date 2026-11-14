// AunuBaileys P2c port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; the types are the ones v6 shipped in
// call-utils.d.ts.
import { randomBytes } from 'crypto';
// AunuBaileys: pembangun stanza panggilan (VOIP) — fungsi murni, tanpa state
// socket, supaya bentuk wire-nya bisa diuji langsung. Bentuk stanza mengikuti
// protokol panggilan WhatsApp (node <call> dengan anak offer/accept/reject/
// terminate), implementasi orisinal AunuBaileys.
/** ID panggilan baru: 32 karakter hex huruf besar. */
export const newCallId = () => randomBytes(16).toString('hex').toUpperCase();
/** Kunci media panggilan baru (32 byte) untuk amplop destination terenkripsi. */
export const createCallKey = () => new Uint8Array(randomBytes(32));
/**
 * Isi node <offer> untuk panggilan 1:1 maupun grup: codec audio opus
 * (16 kHz + 8 kHz), video vp8 opsional, net, capability, dan encopt.
 * Node destination/device-identity ditambahkan pemanggil setelah sesi siap.
 */
export const buildCallOfferContent = (isVideo = false) => {
    const content = [
        { tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined },
        { tag: 'audio', attrs: { enc: 'opus', rate: '8000' }, content: undefined }
    ];
    if (isVideo) {
        content.push({
            tag: 'video',
            attrs: {
                enc: 'vp8',
                dec: 'vp8',
                orientation: '0',
                screen_width: '1920',
                screen_height: '1080',
                device_orientation: '0'
            },
            content: undefined
        });
    }
    content.push({ tag: 'net', attrs: { medium: '3' }, content: undefined });
    content.push({ tag: 'capability', attrs: { ver: '1' }, content: new Uint8Array([1, 4, 255, 131, 207, 4]) });
    content.push({ tag: 'encopt', attrs: { keygen: '2' }, content: undefined });
    return content;
};
/** Stanza <call> berisi satu node kontrol (accept / terminate / reject). */
export const buildCallControlStanza = ({ from, to, action, callId, callCreator, reason }) => ({
    tag: 'call',
    attrs: { from, to },
    content: [
        {
            tag: action,
            attrs: {
                'call-id': callId,
                'call-creator': callCreator,
                ...(reason ? { reason } : {}),
                count: '0'
            },
            content: undefined
        }
    ]
});
/** Stanza <call><offer type="group" group-jid=..> untuk memulai panggilan grup. */
export const buildGroupCallStanza = ({ id, to, callId, callCreator, offerContent }) => ({
    tag: 'call',
    attrs: { id, to },
    content: [
        {
            tag: 'offer',
            attrs: {
                'call-id': callId,
                'call-creator': callCreator,
                type: 'group',
                'group-jid': to
            },
            content: offerContent
        }
    ]
});
/** Stanza <call><terminate> untuk membatalkan/mengakhiri panggilan grup. */
export const buildGroupCallCancelStanza = ({ from, to, callId, callCreator }) => buildCallControlStanza({
    from,
    to,
    action: 'terminate',
    callId,
    callCreator,
    reason: 'user-terminated'
});
//# sourceMappingURL=call-utils.js.map
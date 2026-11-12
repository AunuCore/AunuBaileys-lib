import { proto } from '../../WAProto/index.js';
import { aesDecryptGCM, hkdf } from './crypto.js';
import { unpadRandomMax16 } from './generics.js';

// AunuBaileys (1.0.71): Meta AI (<enc type="msmsg">) decryption, ported
// from @violetix/baileys lib/Utils/meta-ai-msmsg.js. One adaptation: our
// hkdf() (lib/Utils/crypto.js) is the async WebCrypto derivation, so both
// HKDF steps are awaited — the donor's hkdf is sync (whatsapp-rust-bridge).
// The parameters themselves (info strings, AAD layout, 32-byte keys) are
// verbatim from the donor.
// UNCERTAINTY (1.0.71): these parameters are verified only against the
// donor file — no live msmsg stanza has been decrypted with this code
// yet. Decryption is therefore best-effort: a failure is logged by the
// caller and the message stays a CIPHERTEXT stub; it never crashes the
// socket. Our hkdf() TextEncoder-encodes the info string as UTF-8 while
// the donor passes latin1 bytes; every byte in the info (message id,
// target JID, bot JID) is ASCII in practice, so the two agree.
const BOT_MESSAGE_INFO = 'Bot Message';
const KEY_LENGTH = 32;
const toBuffer = (value) => {
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    return Buffer.from(value);
};
// Strips the device suffix from LID JIDs: "user:device@lid" → "user@lid".
// jidEncode includes ":0" even for device=0, so normalize both meId and meLid.
const normalizeLidJid = (jid) => {
    if (!jid || !jid.endsWith('@lid') || !jid.includes(':')) {
        return jid;
    }
    return `${jid.split(':')[0]}@lid`;
};
// Ordered msgId candidates: botEditTargetId when editing, stanzaId for the normal
// full response, metaTargetId as a fallback.
const selectMsgIdCandidates = (messageKey) => {
    const seen = new Set();
    const result = [];
    for (const id of [messageKey?.botEditTargetId, messageKey?.stanzaId, messageKey?.metaTargetId]) {
        const s = id ? String(id) : '';
        if (s && !seen.has(s)) {
            seen.add(s);
            result.push(s);
        }
    }
    return result;
};
// Ordered target_sender_user_jid candidates — the non-AD user JID, so no device suffix.
const selectTargetJidCandidates = (messageKey) => {
    const seen = new Set();
    const result = [];
    for (const jid of [normalizeLidJid(messageKey?.meId), normalizeLidJid(messageKey?.meLid)]) {
        const s = jid ? String(jid) : '';
        if (s && !seen.has(s)) {
            seen.add(s);
            result.push(s);
        }
    }
    return result;
};
export const decodeDecryptedMsmsgMessage = (decrypted) => {
    const buf = toBuffer(decrypted);
    try {
        const unpadded = Buffer.from(unpadRandomMax16(buf));
        const decoded = proto.Message.decode(unpadded);
        const hasContent = Object.keys(decoded).some(k => k !== 'messageContextInfo' && decoded[k] != null);
        if (hasContent) {
            return decoded;
        }
    }
    catch {
        // not padded — fall through and decode the raw buffer
    }
    return proto.Message.decode(buf);
};
/**
 * Decrypts <enc type="msmsg"> bot messages.
 *
 * Two-pass HKDF:
 *   k1    = HKDF(messageSecret, salt=∅, info="Bot Message",                     32)
 *   k2    = HKDF(k1,            salt=∅, info=msgID||target_sender_jid||bot_jid, 32)
 *   AAD   = msgID || 0x00 || bot_user_jid
 *   plain = AES-256-GCM.Decrypt(k2, encIv, encPayload, AAD)
 *
 * k1 depends only on the secret, so it is derived once and reused across candidates.
 * The AAD always uses bot_user_jid, never target_sender_jid.
 */
export const decryptMsmsgBotMessage = async (messageSecret, messageKey, msMsg) => {
    if (!messageSecret || (messageSecret instanceof Uint8Array && !messageSecret.byteLength)) {
        throw new Error('Missing required messageSecret for msmsg decryption');
    }
    if (!messageKey?.participant) {
        throw new Error('Missing required participant for msmsg decryption');
    }
    if (!messageKey?.meId) {
        throw new Error('Missing required meId for msmsg decryption');
    }
    if (!msMsg?.encIv) {
        throw new Error('Missing required encIv for msmsg decryption');
    }
    if (!msMsg?.encPayload) {
        throw new Error('Missing required encPayload for msmsg decryption');
    }
    const msgIdCandidates = selectMsgIdCandidates(messageKey);
    if (!msgIdCandidates.length) {
        throw new Error('Missing required target message id for msmsg decryption');
    }
    const targetJidCandidates = selectTargetJidCandidates(messageKey);
    if (!targetJidCandidates.length) {
        throw new Error('Missing required target JID for msmsg decryption');
    }
    const botJidBuf = Buffer.from(String(messageKey.participant));
    const payload = toBuffer(msMsg.encPayload);
    const iv = toBuffer(msMsg.encIv);
    // AunuBaileys (1.0.71): awaited — our hkdf() is async (see header).
    const baseKey = await hkdf(toBuffer(messageSecret), KEY_LENGTH, { info: BOT_MESSAGE_INFO });
    let lastError;
    for (const msgId of msgIdCandidates) {
        // msg_id is always the ASCII bytes of the id
        const idBuf = Buffer.from(msgId);
        for (const targetJid of targetJidCandidates) {
            const info = Buffer.concat([idBuf, Buffer.from(targetJid), botJidBuf]);
            const key = await hkdf(baseKey, KEY_LENGTH, { info: info.toString('latin1') });
            const aad = Buffer.concat([idBuf, Buffer.from([0x00]), botJidBuf]);
            try {
                return Buffer.from(aesDecryptGCM(payload, key, iv, aad));
            }
            catch (e) {
                lastError = e;
            }
        }
    }
    const err = new Error('msmsg decryption failed: all key derivation candidates exhausted');
    err.cause = lastError;
    throw err;
};

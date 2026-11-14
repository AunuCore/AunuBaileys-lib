import { proto } from '../../WAProto/index.js';
export declare const decodeDecryptedMsmsgMessage: (decrypted: any) => proto.Message;
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
export declare const decryptMsmsgBotMessage: (messageSecret: any, messageKey: any, msMsg: any) => Promise<Buffer<ArrayBuffer>>;
//# sourceMappingURL=meta-ai-msmsg.d.ts.map
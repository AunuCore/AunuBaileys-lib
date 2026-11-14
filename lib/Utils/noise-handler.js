import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { NOISE_MODE, WA_CERT_DETAILS } from '../Defaults/index.js';
import { decodeBinaryNode } from '../WABinary/index.js';
import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, keyMaterialToBuffer, sha256 } from './crypto.js';
const generateIV = (counter) => {
    const iv = new ArrayBuffer(12);
    new DataView(iv).setUint32(8, counter);
    return new Uint8Array(iv);
};
// AunuBaileys (1.0.73, HB-91): a frame length of 0 is never valid,
// and a frame above this cap can never legitimately arrive — the
// 24-bit length field tops out at ~16 MiB, and real WhatsApp frames
// (history-sync chunks included) are far smaller. Without a cap, a
// corrupt header either wedges the stream forever (size 0: the header
// is never consumed, so every later call re-reads it) or buffers
// without bound waiting for megabytes that never arrive. Fail loudly
// instead: the throw is marked frame-fatal (1.0.77, HB-185) and the
// caller ends the socket, so the host reconnects at once.
const MAX_NOISE_FRAME_SIZE = 10 * 1024 * 1024;
export const makeNoiseHandler = ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }) => {
    logger = logger.child({ class: 'ns' });
    const authenticate = (data) => {
        if (!isFinished) {
            hash = sha256(Buffer.concat([hash, data]));
        }
    };
    const encrypt = (plaintext) => {
        const result = aesEncryptGCM(plaintext, encKey, generateIV(writeCounter), hash);
        writeCounter += 1;
        authenticate(result);
        return result;
    };
    const decrypt = (ciphertext) => {
        // before the handshake is finished, we use the same counter
        // after handshake, the counters are different
        const iv = generateIV(isFinished ? readCounter : writeCounter);
        const result = aesDecryptGCM(ciphertext, decKey, iv, hash);
        if (isFinished) {
            readCounter += 1;
        }
        else {
            writeCounter += 1;
        }
        authenticate(ciphertext);
        return result;
    };
    const localHKDF = async (data) => {
        const key = await hkdf(Buffer.from(data), 64, { salt, info: '' });
        return [key.slice(0, 32), key.slice(32)];
    };
    const mixIntoKey = async (data) => {
        const [write, read] = await localHKDF(data);
        salt = write;
        encKey = read;
        decKey = read;
        readCounter = 0;
        writeCounter = 0;
    };
    const finishInit = async () => {
        const [write, read] = await localHKDF(new Uint8Array(0));
        encKey = write;
        decKey = read;
        hash = Buffer.from([]);
        readCounter = 0;
        writeCounter = 0;
        isFinished = true;
    };
    const data = Buffer.from(NOISE_MODE);
    let hash = data.byteLength === 32 ? data : sha256(data);
    let salt = hash;
    let encKey = hash;
    let decKey = hash;
    let readCounter = 0;
    let writeCounter = 0;
    let isFinished = false;
    let sentIntro = false;
    let inBytes = Buffer.alloc(0);
    authenticate(NOISE_HEADER);
    authenticate(publicKey);
    return {
        encrypt,
        decrypt,
        authenticate,
        mixIntoKey,
        finishInit,
        processHandshake: async ({ serverHello }, noiseKey) => {
            // AunuBaileys (1.0.74): HB-102 — a partial creds restore can
            // reach the handshake with noiseKey missing; dereferencing
            // it below threw a bare TypeError BEFORE the descriptive
            // HB-80 guard in generateRegistrationNode could run, and
            // the host reconnect-looped on it at every boot. Fail
            // descriptively, in the HB-80 style.
            if (!noiseKey?.public || !noiseKey?.private) {
                throw new Error('AunuBaileys: creds.noiseKey is missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again');
            }
            // AunuBaileys (1.0.79, addendum HB-102): the truthiness
            // check above lets a WRONG-TYPED noiseKey through — a
            // number/object died as a bare TypeError inside
            // aesEncryptGCM, and a base64 string was silently
            // encrypted as UTF-8 bytes, so the server received a
            // garbage public key and the handshake failed remotely
            // with no local diagnosis. Normalise with
            // keyMaterialToBuffer (the HB-157 house rule) and
            // require real 32-byte keys.
            const noisePublic = keyMaterialToBuffer(noiseKey.public);
            const noisePrivate = keyMaterialToBuffer(noiseKey.private);
            if (!Buffer.isBuffer(noisePublic) || noisePublic.length !== 32 || !Buffer.isBuffer(noisePrivate) || noisePrivate.length !== 32) {
                throw new Error('AunuBaileys: creds.noiseKey is malformed (public/private must be 32-byte keys) — the auth state is incomplete or corrupt; restore a full backup or pair again');
            }
            // AunuBaileys (1.0.79, HB-238): the first handshake frame
            // is plaintext, so an intercepting middlebox (ISP
            // intercept page, broken proxy) can deliver a decoded
            // handshake with NO serverHello at all — the derefs
            // below then threw a bare TypeError and the host
            // reconnect-looped on it. Fail descriptively, in the
            // HB-80/HB-102 style.
            if (!serverHello || typeof serverHello !== 'object' || !(serverHello.ephemeral instanceof Uint8Array) || !(serverHello.static instanceof Uint8Array) || !(serverHello.payload instanceof Uint8Array)) {
                throw new Error('AunuBaileys: the server handshake is malformed — serverHello or its encrypted parts are missing (the connection may have been intercepted); reconnecting will retry');
            }
            authenticate(serverHello.ephemeral);
            await mixIntoKey(Curve.sharedKey(privateKey, serverHello.ephemeral));
            const decStaticContent = decrypt(serverHello.static);
            await mixIntoKey(Curve.sharedKey(privateKey, decStaticContent));
            const certDecoded = decrypt(serverHello.payload);
            const { intermediate: certIntermediate } = proto.CertChain.decode(certDecoded);
            const { issuerSerial } = proto.CertChain.NoiseCertificate.Details.decode(certIntermediate.details);
            if (issuerSerial !== WA_CERT_DETAILS.SERIAL) {
                throw new Boom('certification match failed', { statusCode: 400 });
            }
            const keyEnc = encrypt(noisePublic);
            await mixIntoKey(Curve.sharedKey(noisePrivate, serverHello.ephemeral));
            return keyEnc;
        },
        encodeFrame: (data) => {
            if (isFinished) {
                data = encrypt(data);
            }
            let header;
            if (routingInfo) {
                header = Buffer.alloc(7);
                header.write('ED', 0, 'utf8');
                header.writeUint8(0, 2);
                header.writeUint8(1, 3);
                header.writeUint8(routingInfo.byteLength >> 16, 4);
                header.writeUint16BE(routingInfo.byteLength & 65535, 5);
                header = Buffer.concat([header, routingInfo, NOISE_HEADER]);
            }
            else {
                header = Buffer.from(NOISE_HEADER);
            }
            const introSize = sentIntro ? 0 : header.length;
            const frame = Buffer.alloc(introSize + 3 + data.byteLength);
            if (!sentIntro) {
                frame.set(header);
                sentIntro = true;
            }
            frame.writeUInt8(data.byteLength >> 16, introSize);
            frame.writeUInt16BE(65535 & data.byteLength, introSize + 1);
            frame.set(data, introSize + 3);
            return frame;
        },
        decodeFrame: async (newData, onFrame) => {
            // the binary protocol uses its own framing mechanism
            // on top of the WS frames
            // so we get this data and separate out the frames
            const getBytesSize = () => {
                if (inBytes.length >= 3) {
                    return (inBytes.readUInt8() << 16) | inBytes.readUInt16BE(1);
                }
            };
            inBytes = Buffer.concat([inBytes, newData]);
            logger.trace(`recv ${newData.length} bytes, total recv ${inBytes.length} bytes`);
            let size = getBytesSize();
            while (typeof size !== 'undefined') {
                if (size === 0) {
                    // AunuBaileys (1.0.73, HB-91): consume the bogus
                    // header and keep parsing — leaving it in place
                    // wedges the stream permanently, since the next
                    // call reads the same zero header again.
                    logger.warn('skipping zero-length noise frame header');
                    inBytes = inBytes.slice(3);
                    size = getBytesSize();
                    continue;
                }
                if (size > MAX_NOISE_FRAME_SIZE) {
                    // AunuBaileys (1.0.73, HB-91): never wait for a
                    // frame that cannot exist. (1.0.77, HB-185): the
                    // throw alone did NOT end the socket — the caller
                    // only logged it, the header was never consumed,
                    // and the stream wedged until the keep-alive
                    // watchdog fired ~65s later. Marked frame-fatal:
                    // the caller now ends the connection on it.
                    const err = new Boom(`noise frame too large: ${size} bytes`, { statusCode: 400 });
                    err.isFrameFatal = true;
                    throw err;
                }
                if (inBytes.length < size + 3) {
                    break;
                }
                let frame = inBytes.slice(3, size + 3);
                inBytes = inBytes.slice(size + 3);
                let decoded = true;
                if (isFinished) {
                    let result;
                    try {
                        result = decrypt(frame);
                    }
                    catch (err) {
                        // AunuBaileys (1.0.77, HB-207): a GCM failure
                        // leaves readCounter behind the server's
                        // counter, so every later frame decrypts with
                        // the wrong IV and fails too — the stream can
                        // never resync. Frame-fatal: the caller ends
                        // the connection instead of losing every
                        // inbound message until the watchdog fires.
                        err.isFrameFatal = true;
                        throw err;
                    }
                    try {
                        frame = await decodeBinaryNode(result);
                    }
                    catch (err) {
                        // AunuBaileys (1.0.77): stanza-level corruption
                        // is NOT fatal — the frame was consumed and the
                        // counter advanced, so the stream is still in
                        // sync. Log and skip the frame instead of
                        // aborting the rest of the buffered frames.
                        logger.error({ err }, 'failed to decode a stanza; skipping the frame');
                        decoded = false;
                    }
                }
                if (decoded) {
                    logger.trace({ msg: frame?.attrs?.id }, 'recv frame');
                    onFrame(frame);
                }
                size = getBytesSize();
            }
        }
    };
};
//# sourceMappingURL=noise-handler.js.map
import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { NOISE_MODE, WA_CERT_DETAILS } from '../Defaults/index.js';
import { decodeBinaryNode } from '../WABinary/index.js';
import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, sha256 } from './crypto.js';
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
// instead: the socket ends (the caller routes the throw to
// onUnexpectedError) and the host reconnects.
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
            const keyEnc = encrypt(noiseKey.public);
            await mixIntoKey(Curve.sharedKey(noiseKey.private, serverHello.ephemeral));
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
                    // frame that cannot exist — throw so the socket
                    // ends instead of buffering without bound until
                    // the keep-alive watchdog kills the connection
                    // ~65s later.
                    throw new Boom(`noise frame too large: ${size} bytes`, { statusCode: 400 });
                }
                if (inBytes.length < size + 3) {
                    break;
                }
                let frame = inBytes.slice(3, size + 3);
                inBytes = inBytes.slice(size + 3);
                if (isFinished) {
                    const result = decrypt(frame);
                    frame = await decodeBinaryNode(result);
                }
                logger.trace({ msg: frame?.attrs?.id }, 'recv frame');
                onFrame(frame);
                size = getBytesSize();
            }
        }
    };
};
//# sourceMappingURL=noise-handler.js.map
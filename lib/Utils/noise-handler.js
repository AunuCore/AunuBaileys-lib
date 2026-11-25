import { Boom } from '@hapi/boom';
import { waproto } from '../../WAProto/index.js';
import { NOISE_MODE, WA_CERT_DETAILS } from '../Defaults/index.js';
import { decodeBinaryNode } from '../WABinary/index.js';
import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, keyMaterialToBuffer, sha256 } from './crypto.js';
// AunuBaileys (1.0.73, HB-91, re-applied P3b): a frame length of 0
// is never valid, and a frame above this cap can never legitimately
// arrive — the 24-bit length field tops out at ~16 MiB, and real
// WhatsApp frames (history-sync chunks included) are far smaller.
// Without a cap, a corrupt header either wedges the stream forever
// (size 0) or buffers without bound waiting for megabytes that
// never arrive. Fail loudly instead.
const MAX_NOISE_FRAME_SIZE = 10 * 1024 * 1024;
const IV_LENGTH = 12;
const EMPTY_BUFFER = Buffer.alloc(0);
const generateIV = (counter) => {
    const iv = new ArrayBuffer(IV_LENGTH);
    new DataView(iv).setUint32(8, counter);
    return new Uint8Array(iv);
};
class TransportState {
    constructor(encKey, decKey) {
        this.encKey = encKey;
        this.decKey = decKey;
        this.readCounter = 0;
        this.writeCounter = 0;
        this.iv = new Uint8Array(IV_LENGTH);
    }
    encrypt(plaintext) {
        const c = this.writeCounter++;
        this.iv[8] = (c >>> 24) & 0xff;
        this.iv[9] = (c >>> 16) & 0xff;
        this.iv[10] = (c >>> 8) & 0xff;
        this.iv[11] = c & 0xff;
        return aesEncryptGCM(plaintext, this.encKey, this.iv, EMPTY_BUFFER);
    }
    decrypt(ciphertext) {
        const c = this.readCounter++;
        this.iv[8] = (c >>> 24) & 0xff;
        this.iv[9] = (c >>> 16) & 0xff;
        this.iv[10] = (c >>> 8) & 0xff;
        this.iv[11] = c & 0xff;
        return aesDecryptGCM(ciphertext, this.decKey, this.iv, EMPTY_BUFFER);
    }
}
export const makeNoiseHandler = ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }) => {
    logger = logger.child({ class: 'ns' });
    const data = Buffer.from(NOISE_MODE);
    let hash = data.byteLength === 32 ? data : sha256(data);
    let salt = hash;
    let encKey = hash;
    let decKey = hash;
    let counter = 0;
    let sentIntro = false;
    let inBytes = Buffer.alloc(0);
    let transport = null;
    let isWaitingForTransport = false;
    let pendingOnFrame = null;
    let introHeader;
    if (routingInfo) {
        introHeader = Buffer.alloc(7 + routingInfo.byteLength + NOISE_HEADER.length);
        introHeader.write('ED', 0, 'utf8');
        introHeader.writeUint8(0, 2);
        introHeader.writeUint8(1, 3);
        introHeader.writeUint8(routingInfo.byteLength >> 16, 4);
        introHeader.writeUint16BE(routingInfo.byteLength & 65535, 5);
        introHeader.set(routingInfo, 7);
        introHeader.set(NOISE_HEADER, 7 + routingInfo.byteLength);
    }
    else {
        introHeader = Buffer.from(NOISE_HEADER);
    }
    const authenticate = (data) => {
        if (!transport) {
            hash = sha256(Buffer.concat([hash, data]));
        }
    };
    const encrypt = (plaintext) => {
        if (transport) {
            return transport.encrypt(plaintext);
        }
        const result = aesEncryptGCM(plaintext, encKey, generateIV(counter++), hash);
        authenticate(result);
        return result;
    };
    const decrypt = (ciphertext) => {
        if (transport) {
            return transport.decrypt(ciphertext);
        }
        const result = aesDecryptGCM(ciphertext, decKey, generateIV(counter++), hash);
        authenticate(ciphertext);
        return result;
    };
    const localHKDF = (data) => {
        const key = hkdf(Buffer.from(data), 64, { salt, info: '' });
        return [key.subarray(0, 32), key.subarray(32)];
    };
    const mixIntoKey = (data) => {
        const [write, read] = localHKDF(data);
        salt = write;
        encKey = read;
        decKey = read;
        counter = 0;
    };
    const finishInit = async () => {
        isWaitingForTransport = true;
        const [write, read] = localHKDF(new Uint8Array(0));
        transport = new TransportState(write, read);
        isWaitingForTransport = false;
        logger.trace('Noise handler transitioned to Transport state');
        if (pendingOnFrame) {
            logger.trace({ length: inBytes.length }, 'Flushing buffered frames after transport ready');
            await processData(pendingOnFrame);
            pendingOnFrame = null;
        }
    };
    const processData = async (onFrame) => {
        let size;
        while (true) {
            if (inBytes.length < 3)
                return;
            size = (inBytes[0] << 16) | (inBytes[1] << 8) | inBytes[2];
            if (size === 0) {
                // AunuBaileys (1.0.73, HB-91, re-applied P3b): consume
                // the bogus header and keep parsing — leaving it in
                // place wedges the stream permanently, since the next
                // call reads the same zero header again.
                logger.warn('skipping zero-length noise frame header');
                inBytes = inBytes.subarray(3);
                continue;
            }
            if (size > MAX_NOISE_FRAME_SIZE) {
                // AunuBaileys (1.0.73, HB-91, re-applied P3b): never
                // wait for a frame that cannot exist.
                const err = new Boom(`noise frame too large: ${size} bytes`, { statusCode: 400 });
                err.isFrameFatal = true;
                throw err;
            }
            if (inBytes.length < size + 3)
                return;
            let frame = inBytes.subarray(3, size + 3);
            inBytes = inBytes.subarray(size + 3);
            if (transport) {
                const result = transport.decrypt(frame);
                frame = await decodeBinaryNode(result);
            }
            if (logger.level === 'trace') {
                logger.trace({ msg: frame?.attrs?.id }, 'recv frame');
            }
            onFrame(frame);
        }
    };
    authenticate(NOISE_HEADER);
    authenticate(publicKey);
    return {
        encrypt,
        decrypt,
        authenticate,
        mixIntoKey,
        finishInit,
        processHandshake: ({ serverHello }, noiseKey) => {
            // AunuBaileys (1.0.74, HB-102 + 1.0.79 addendum,
            // re-applied P3b): a partial creds restore can reach the
            // handshake with noiseKey missing or wrong-typed —
            // dereferencing it below threw a bare TypeError (or
            // silently encrypted a base64 string as UTF-8 bytes)
            // BEFORE the descriptive HB-80 guard in
            // generateRegistrationNode could run, and the host
            // reconnect-looped on it at every boot. Normalise with
            // keyMaterialToBuffer and require real 32-byte keys;
            // fail descriptively, in the HB-80 style.
            if (!noiseKey?.public || !noiseKey?.private) {
                throw new Error('AunuBaileys: creds.noiseKey is missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again');
            }
            const noisePublic = keyMaterialToBuffer(noiseKey.public);
            const noisePrivate = keyMaterialToBuffer(noiseKey.private);
            if (!Buffer.isBuffer(noisePublic) ||
                noisePublic.length !== 32 ||
                !Buffer.isBuffer(noisePrivate) ||
                noisePrivate.length !== 32) {
                throw new Error('AunuBaileys: creds.noiseKey is malformed (public/private must be 32-byte keys) — the auth state is incomplete or corrupt; restore a full backup or pair again');
            }
            // AunuBaileys (1.0.79, HB-238, re-applied P3b): the first handshake
            // frame is plaintext, so an intercepting middlebox (ISP intercept
            // page, broken proxy) can deliver a decoded handshake with NO
            // serverHello at all — the derefs below then threw a bare TypeError
            // and the host reconnect-looped on it. Fail descriptively, in the
            // HB-80/HB-102 style. The parts are protobuf bytes: plain Uint8Array,
            // NOT Buffer — a Buffer.isBuffer gate would refuse every legitimate
            // handshake.
            if (!serverHello ||
                typeof serverHello !== 'object' ||
                !(serverHello.ephemeral instanceof Uint8Array) ||
                !(serverHello.static instanceof Uint8Array) ||
                !(serverHello.payload instanceof Uint8Array)) {
                throw new Error('AunuBaileys: the server handshake is malformed — serverHello or its encrypted parts are missing (the connection may have been intercepted); reconnecting will retry');
            }
            // AunuBaileys (2.5.0, HB-238 addendum): the shape gate
            // above accepted ANY length — a 16-byte ephemeral died
            // later as Curve's bare 'Invalid public key' and a short
            // static as a raw GCM error, and the host reconnect-looped
            // on both. The parts have fixed sizes: a 32-byte
            // Curve25519 ephemeral and a 48-byte static (32-byte key
            // + 16-byte GCM tag). Fail descriptively here instead.
            if (serverHello.ephemeral.length !== 32) {
                throw new Error(`AunuBaileys: the server handshake is malformed — serverHello.ephemeral must be a 32-byte key, got ${serverHello.ephemeral.length} bytes (the connection may have been intercepted); reconnecting will retry`);
            }
            if (serverHello.static.length !== 48) {
                throw new Error(`AunuBaileys: the server handshake is malformed — serverHello.static must be 48 bytes (32-byte key + 16-byte GCM tag), got ${serverHello.static.length} bytes (the connection may have been intercepted); reconnecting will retry`);
            }
            authenticate(serverHello.ephemeral);
            mixIntoKey(Curve.sharedKey(privateKey, serverHello.ephemeral));
            // AunuBaileys (2.7.0, HB-238 addendum 2): the shape and
            // length guards above cannot catch a correctly-sized
            // part with a corrupt GCM tag, an empty payload, or a
            // payload that decrypts to non-protobuf bytes — those
            // died below as raw GCM/protobuf errors. In Noise XX a
            // middlebox that completes the handshake derives the
            // same session keys, so it CAN deliver all of these;
            // the certificate signature check only runs after
            // these decodes. Fail descriptively, in the HB-238 style.
            let decStaticContent;
            try {
                decStaticContent = decrypt(serverHello.static);
            }
            catch {
                throw new Error('AunuBaileys: the server handshake is malformed — serverHello.static could not be decrypted (the connection may have been intercepted); reconnecting will retry');
            }
            mixIntoKey(Curve.sharedKey(privateKey, decStaticContent));
            let certDecoded;
            try {
                if (!serverHello.payload.length) {
                    throw new Error('empty payload');
                }
                certDecoded = decrypt(serverHello.payload);
            }
            catch {
                throw new Error('AunuBaileys: the server handshake is malformed — serverHello.payload could not be decrypted (the connection may have been intercepted); reconnecting will retry');
            }
            let certChain;
            try {
                certChain = waproto.CertChain.decode(certDecoded);
            }
            catch {
                throw new Error('AunuBaileys: the server handshake is malformed — the decrypted certificate chain is not valid protobuf (the connection may have been intercepted); reconnecting will retry');
            }
            const { intermediate: certIntermediate, leaf } = certChain;
            // leaf
            if (!leaf?.details || !leaf?.signature) {
                throw new Boom('invalid noise leaf certificate', { statusCode: 400 });
            }
            if (!certIntermediate?.details || !certIntermediate?.signature) {
                throw new Boom('invalid noise intermediate certificate', { statusCode: 400 });
            }
            // AunuBaileys (2.7.0, HB-238 addendum 2): a well-formed
            // chain can still carry garbage intermediate details —
            // decode failure here was a raw RangeError.
            let details;
            try {
                details = waproto.CertChain.NoiseCertificate.Details.decode(certIntermediate.details);
            }
            catch {
                throw new Error('AunuBaileys: the server handshake is malformed — the intermediate certificate details are not valid protobuf (the connection may have been intercepted); reconnecting will retry');
            }
            const { issuerSerial } = details;
            const verify = Curve.verify(details.key, leaf.details, leaf.signature);
            const verifyIntermediate = Curve.verify(WA_CERT_DETAILS.PUBLIC_KEY, certIntermediate.details, certIntermediate.signature);
            if (!verify) {
                throw new Boom('noise certificate signature invalid', { statusCode: 400 });
            }
            if (!verifyIntermediate) {
                throw new Boom('noise intermediate certificate signature invalid', { statusCode: 400 });
            }
            if (issuerSerial !== WA_CERT_DETAILS.SERIAL) {
                throw new Boom('certification match failed', { statusCode: 400 });
            }
            const keyEnc = encrypt(noisePublic);
            mixIntoKey(Curve.sharedKey(noisePrivate, serverHello.ephemeral));
            return keyEnc;
        },
        encodeFrame: (data) => {
            if (transport) {
                data = transport.encrypt(data);
            }
            const dataLen = data.byteLength;
            // AunuBaileys (2.6.0, HB-463): the 24-bit length field
            // used to be written with masking, so a payload above
            // 16 MiB was silently truncated in the header (dataLen
            // mod 2^24) while the whole payload followed — the peer
            // then reads a short frame and parses the leftover
            // payload bytes as the next frame header: stream
            // desync, with no error at the send site. Refuse
            // oversize frames here, like the decode side refuses
            // them (HB-91).
            if (dataLen > 0xffffff) {
                throw new Boom(`noise frame too large: ${dataLen} bytes`, { statusCode: 400 });
            }
            const introSize = sentIntro ? 0 : introHeader.length;
            const frame = Buffer.allocUnsafe(introSize + 3 + dataLen);
            if (!sentIntro) {
                frame.set(introHeader);
                sentIntro = true;
            }
            frame[introSize] = (dataLen >>> 16) & 0xff;
            frame[introSize + 1] = (dataLen >>> 8) & 0xff;
            frame[introSize + 2] = dataLen & 0xff;
            frame.set(data, introSize + 3);
            return frame;
        },
        decodeFrame: async (newData, onFrame) => {
            if (isWaitingForTransport) {
                inBytes = Buffer.concat([inBytes, newData]);
                pendingOnFrame = onFrame;
                return;
            }
            if (inBytes.length === 0) {
                inBytes = Buffer.from(newData);
            }
            else {
                inBytes = Buffer.concat([inBytes, newData]);
            }
            await processData(onFrame);
        }
    };
};
//# sourceMappingURL=noise-handler.js.map
import { KEY_BUNDLE_TYPE } from '../Defaults/index.js';
import { assertNodeErrorFree, getBinaryNodeChild, getBinaryNodeChildBuffer, getBinaryNodeChildren, getBinaryNodeChildUInt, jidDecode, S_WHATSAPP_NET } from '../WABinary/index.js';
import { Curve, generateSignalPubKey, keyMaterialToBuffer } from './crypto.js';
import { encodeBigEndian } from './generics.js';
// AunuBaileys (1.0.74): HB-98 — key material is only ever a Buffer
// (or a string in a hand-edited creds file). Anything else is a
// wrong-typed corrupt value, not key material.
const isKeyMaterial = (value) => Buffer.isBuffer(value) || typeof value === 'string';
function chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}
export const createSignalIdentity = (wid, accountSignatureKey) => {
    return {
        identifier: { name: wid, deviceId: 0 },
        identifierKey: generateSignalPubKey(accountSignatureKey)
    };
};
export const getPreKeys = async ({ get }, min, limit) => {
    const idList = [];
    for (let id = min; id < limit; id++) {
        idList.push(id.toString());
    }
    return get('pre-key', idList);
};
export const generateOrGetPreKeys = (creds, range) => {
    // AunuBaileys (1.0.72): partial creds without the pre-key counters
    // used to produce NaN updates that were then STORED, breaking
    // pre-key upload permanently and silently (HB-84). Fail
    // descriptively, like loadSignedPreKey (HB-26/54).
    if (!Number.isFinite(creds.nextPreKeyId) || !Number.isFinite(creds.firstUnuploadedPreKeyId)) {
        throw new Error('AunuBaileys: creds.nextPreKeyId / creds.firstUnuploadedPreKeyId are missing — the auth state is incomplete or corrupt; restore a full backup or pair again');
    }
    const avaliable = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId;
    // AunuBaileys (1.0.80, HB-140 + HB-225): finite-but-INVERTED
    // counters (firstUnuploadedPreKeyId > nextPreKeyId — hand-edited
    // or partially restored creds) made `remaining` exceed `range`
    // by the size of the gap, so the loop below generated keys for
    // the GAP, not the request: gap 50k ≈ 5 s and +48 MB, gap 200k
    // ≈ 21 s and +238 MB, and a ~2^31 gap would freeze the process
    // outright — synchronously, inside the keys transaction, at
    // every login. Same class as HB-84 above (corrupt counters),
    // same answer: refuse descriptively. With consistent counters
    // `remaining` can never exceed `range` by construction.
    if (avaliable < 0) {
        throw new Error('AunuBaileys: creds pre-key counters are inverted (firstUnuploadedPreKeyId > nextPreKeyId) — the auth state is corrupt; restore a full backup or pair again');
    }
    const remaining = range - avaliable;
    const lastPreKeyId = creds.nextPreKeyId + remaining - 1;
    const newPreKeys = {};
    if (remaining > 0) {
        for (let i = creds.nextPreKeyId; i <= lastPreKeyId; i++) {
            newPreKeys[i] = Curve.generateKeyPair();
        }
    }
    return {
        newPreKeys,
        lastPreKeyId,
        preKeysRange: [creds.firstUnuploadedPreKeyId, range]
    };
};
export const xmppSignedPreKey = (key) => ({
    tag: 'skey',
    attrs: {},
    // AunuBaileys (1.0.78, HB-157): key material may be a base64 string
    // in a hand-edited creds file — the node writer would otherwise
    // publish the base64 TEXT as the key bytes.
    content: [
        { tag: 'id', attrs: {}, content: encodeBigEndian(key.keyId, 3) },
        { tag: 'value', attrs: {}, content: keyMaterialToBuffer(key.keyPair.public) },
        { tag: 'signature', attrs: {}, content: keyMaterialToBuffer(key.signature) }
    ]
});
export const xmppPreKey = (pair, id) => ({
    tag: 'key',
    attrs: {},
    content: [
        { tag: 'id', attrs: {}, content: encodeBigEndian(id, 3) },
        { tag: 'value', attrs: {}, content: keyMaterialToBuffer(pair.public) }
    ]
});
/** AunuBaileys: parse the E2E key bundle embedded in a retry receipt.
 * When a recipient device asks us to resend, its receipt often carries the
 * device's OWN current key bundle (<keys> + <registration>) — the device
 * itself stating "build your session to me from THIS". Upstream ignores it
 * and re-fetches a bundle from the server instead; consuming the receipt's
 * bundle skips that round trip and, more importantly, is authoritative for
 * the exact requesting device (server lookups by JID are fragile for LID
 * participants). Returns undefined when the receipt carries no bundle. */
export const parseRetryReceiptSession = (node) => {
    const keysNode = getBinaryNodeChild(node, 'keys');
    if (!keysNode) {
        return undefined;
    }
    const identity = getBinaryNodeChildBuffer(keysNode, 'identity');
    if (!identity) {
        return undefined;
    }
    const extractKey = (key) => {
        if (!key) {
            return undefined;
        }
        // AunuBaileys (1.0.70): a <key>/<skey> without a <value> child
        // used to throw inside generateSignalPubKey, silently cancelling
        // the whole resend. A key without a public value is unusable —
        // skip it instead.
        const value = getBinaryNodeChildBuffer(key, 'value');
        if (!value) {
            return undefined;
        }
        return {
            keyId: getBinaryNodeChildUInt(key, 'id', 3),
            publicKey: generateSignalPubKey(value),
            signature: getBinaryNodeChildBuffer(key, 'signature')
        };
    };
    return {
        registrationId: getBinaryNodeChildUInt(node, 'registration', 4),
        identityKey: generateSignalPubKey(identity),
        signedPreKey: extractKey(getBinaryNodeChild(keysNode, 'skey')),
        preKey: extractKey(getBinaryNodeChild(keysNode, 'key'))
    };
};
export const parseAndInjectE2ESessions = async (node, repository, logger) => {
    // AunuBaileys (1.0.72): a <key>/<skey> without a <value> child used
    // to throw inside generateSignalPubKey — the per-entry catch then
    // skipped the WHOLE device entry, although the signed pre-key alone
    // is enough to build a session. Mirror the receipt-path guard from
    // 1.0.70 (parseRetryReceiptSession): skip just that key (HB-67).
    const extractKey = (key) => {
        if (!key) {
            return undefined;
        }
        const value = getBinaryNodeChildBuffer(key, 'value');
        if (!value) {
            return undefined;
        }
        return {
            keyId: getBinaryNodeChildUInt(key, 'id', 3),
            publicKey: generateSignalPubKey(value),
            signature: getBinaryNodeChildBuffer(key, 'signature')
        };
    };
    const nodes = getBinaryNodeChildren(getBinaryNodeChild(node, 'list'), 'user');
    // AunuBaileys (1.0.68): the old loop threw on the FIRST bad <user>
    // node (error child / missing identity / missing jid), aborting
    // session injection for every other user in the response. Bad
    // entries are now skipped per node inside the chunk loop below.
    // Most of the work in repository.injectE2ESession is CPU intensive, not IO
    // So Promise.all doesn't really help here,
    // but blocks even loop if we're using it inside keys.transaction, and it makes it "sync" actually
    // This way we chunk it in smaller parts and between those parts we can yield to the event loop
    // It's rare case when you need to E2E sessions for so many users, but it's possible
    const chunkSize = 100;
    const chunks = chunk(nodes, chunkSize);
    for (const nodesChunk of chunks) {
        await Promise.all(nodesChunk.map(async (node) => {
            try {
                assertNodeErrorFree(node);
                const signedKey = getBinaryNodeChild(node, 'skey');
                const key = getBinaryNodeChild(node, 'key');
                const identity = getBinaryNodeChildBuffer(node, 'identity');
                const jid = node.attrs?.jid;
                if (!jid || !identity) {
                    throw new Error('key-bundle entry is missing jid or identity');
                }
                const registrationId = getBinaryNodeChildUInt(node, 'registration', 4);
                await repository.injectE2ESession({
                    jid,
                    session: {
                        registrationId: registrationId,
                        identityKey: generateSignalPubKey(identity),
                        signedPreKey: extractKey(signedKey),
                        preKey: extractKey(key)
                    }
                });
            }
            catch (err) {
                logger?.warn?.({ jid: node.attrs?.jid, err: err?.message }, 'aunu: skipping bad key-bundle entry; other sessions continue');
            }
        }));
    }
};
export const extractDeviceJids = (result, myJid, myLid, excludeZeroDevices) => {
    const { user: myUser, device: myDevice } = jidDecode(myJid) || {};
    // AunuBaileys (1.0.83, HB-258): our own devices exist under TWO
    // identities — the PN user and the LID user. Comparing only the
    // PN user left our own LID devices in the extracted list, so a
    // group send encrypted and delivered a copy to our own LID
    // device (self-delivery plus wasted encryption). Upstream v7
    // added the same myLid parameter; the comparison below decodes
    // it to its user first, so the current device is excluded
    // under BOTH identities while our other devices stay listed
    // (group sender-key distribution and the DM echo still need
    // them, exactly like the PN side).
    const myLidUser = myLid ? jidDecode(myLid)?.user : undefined;
    const extracted = [];
    for (const userResult of result) {
        const { devices, id } = userResult;
        const { user } = jidDecode(id) || {};
        if (!user) {
            continue;
        }
        const deviceList = devices?.deviceList;
        if (Array.isArray(deviceList)) {
            for (const { id: device, keyIndex } of deviceList) {
                if ((!excludeZeroDevices || device !== 0) && // if zero devices are not-excluded, or device is non zero
                    ((myUser !== user && myLidUser !== user) || myDevice !== device) && // either a different user (neither our PN nor our LID) or if me user, not this device
                    device !== 99 && // AunuBaileys: hosted / Cloud-API companion devices (:99) are not E2E targets — libsignal rejects them ("Unexpected non-hosted device JID with device 99"); skip them when building the device list
                    (device === 0 || !!keyIndex) // ensure that "key-index" is specified for "non-zero" devices, produces a bad req otherwise
                ) {
                    extracted.push({ user, device });
                }
            }
        }
    }
    return extracted;
};
/**
 * get the next N keys for upload or processing
 * @param count number of pre-keys to get or generate
 */
export const getNextPreKeys = async ({ creds, keys }, count) => {
    const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(creds, count);
    const update = {
        nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
        firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1)
    };
    await keys.set({ 'pre-key': newPreKeys });
    const storedPreKeys = await getPreKeys(keys, preKeysRange[0], preKeysRange[0] + preKeysRange[1]);
    // AunuBaileys (1.0.72): a stored pre-key entry with a wrong shape
    // ({} — valid JSON, no key material) used to be uploaded as an
    // EMPTY <value> (HB-83); the decrypt path has guarded this since
    // 1.0.71 (loadPreKey). Skip entries without a public key here too.
    // (1.0.74, HB-98: truthiness alone also let a wrong-TYPED public —
    // e.g. a number — through to the node encoder, which threw
    // "invalid children". Only Buffer/string material counts.)
    const preKeys = {};
    for (const [preKeyId, pair] of Object.entries(storedPreKeys)) {
        if (isKeyMaterial(pair?.public)) {
            preKeys[preKeyId] = pair;
        }
    }
    return { update, preKeys };
};
export const getNextPreKeysNode = async (state, count) => {
    const { creds } = state;
    // AunuBaileys (1.0.72): the identity fields are dereferenced bare
    // below — partial creds turned that into a bare TypeError and a
    // reconnect loop at every boot (HB-68). Fail descriptively, like
    // loadSignedPreKey (HB-26/54).
    if (!isKeyMaterial(creds.signedIdentityKey?.public) || !isKeyMaterial(creds.signedPreKey?.keyPair?.public) || !isKeyMaterial(creds.signedPreKey?.signature) || typeof creds.signedPreKey?.keyId === 'undefined') {
        throw new Error('AunuBaileys: creds.signedIdentityKey / creds.signedPreKey are missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again');
    }
    // AunuBaileys (1.0.79, addendum HB-80): same gap as
    // generateRegistrationNode — a missing registrationId silently
    // became registration 00000000 in the node below.
    if (!Number.isFinite(creds.registrationId)) {
        throw new Error('AunuBaileys: creds.registrationId is missing or invalid — the auth state is incomplete or corrupt; restore a full backup or pair again');
    }
    const { update, preKeys } = await getNextPreKeys(state, count);
    const node = {
        tag: 'iq',
        attrs: {
            xmlns: 'encrypt',
            type: 'set',
            to: S_WHATSAPP_NET
        },
        content: [
            { tag: 'registration', attrs: {}, content: encodeBigEndian(creds.registrationId) },
            { tag: 'type', attrs: {}, content: KEY_BUNDLE_TYPE },
            { tag: 'identity', attrs: {}, content: keyMaterialToBuffer(creds.signedIdentityKey.public) },
            { tag: 'list', attrs: {}, content: Object.keys(preKeys).map(k => xmppPreKey(preKeys[+k], +k)) },
            xmppSignedPreKey(creds.signedPreKey)
        ]
    };
    return { update, node };
};
//# sourceMappingURL=signal.js.map
import { KEY_BUNDLE_TYPE } from '../Defaults/index.js';
import { assertNodeErrorFree, getBinaryNodeChild, getBinaryNodeChildBuffer, getBinaryNodeChildren, getBinaryNodeChildUInt, getServerFromDomainType, jidDecode, S_WHATSAPP_NET, WAJIDDomains } from '../WABinary/index.js';
import { Curve, generateSignalPubKey, keyMaterialToBuffer } from './crypto.js';
import { encodeBigEndian } from './generics.js';
// AunuBaileys (1.0.74, HB-98): key material is only ever a Buffer
// (or a base64 string in a hand-edited creds file). Anything else is
// a wrong-typed corrupt value, not key material.
const isKeyMaterial = (value) => value instanceof Uint8Array || typeof value === 'string';
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
    // AunuBaileys (1.0.72, HB-84, re-applied P3b): partial creds without
    // the pre-key counters used to produce NaN updates that were then
    // STORED, breaking pre-key upload permanently and silently. Fail
    // descriptively, like loadSignedPreKey (HB-26).
    if (!Number.isFinite(creds.nextPreKeyId) || !Number.isFinite(creds.firstUnuploadedPreKeyId)) {
        throw new Error('AunuBaileys: creds.nextPreKeyId / creds.firstUnuploadedPreKeyId are missing — the auth state is incomplete or corrupt; restore a full backup or pair again');
    }
    const avaliable = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId;
    // AunuBaileys (1.0.80, HB-140 + HB-225, re-applied P3b with HB-84):
    // finite-but-INVERTED counters made `remaining` exceed `range` by
    // the size of the gap, so the loop below generated keys for the
    // GAP, not the request — a ~2^31 gap would freeze the process
    // synchronously, inside the keys transaction, at every login.
    if (avaliable < 0) {
        throw new Error('AunuBaileys: creds pre-key counters are inverted (firstUnuploadedPreKeyId > nextPreKeyId) — the auth state is corrupt; restore a full backup or pair again');
    }
    // AunuBaileys (2.7.0, HB-140 addendum facet 2): the POSITIVE
    // direction was unguarded — counters claiming an unuploaded
    // backlog larger than the whole request (nextPreKeyId >>
    // firstUnuploadedPreKeyId, e.g. next = 2^31-1 with first = 1)
    // made `remaining` negative, so the loop generated ZERO keys,
    // getNextPreKeys returned an empty map, and the update marched
    // firstUnuploadedPreKeyId past ids that were never uploaded —
    // an empty pre-key upload on every trigger, forever, with the
    // counters never converging. Fail descriptively, like the
    // inverted guard above. (avaliable === range stays legal: the
    // transient wiped-store form, which the next call heals.)
    if (avaliable > range) {
        throw new Error('AunuBaileys: creds pre-key counters claim an unuploaded backlog larger than the requested range (nextPreKeyId - firstUnuploadedPreKeyId > range) — the auth state is corrupt; restore a full backup or pair again');
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
    // AunuBaileys (1.0.78, HB-157, re-applied P3b): key material may
    // be a base64 string in a hand-edited creds file — the node writer
    // would otherwise publish the base64 TEXT as the key bytes.
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
const isValidUInt = (n) => typeof n === 'number' && Number.isInteger(n);
export const extractE2ESessionFromRetryReceipt = (receipt) => {
    const keysNode = getBinaryNodeChild(receipt, 'keys');
    if (!keysNode)
        return null;
    const typeBuf = getBinaryNodeChildBuffer(keysNode, 'type');
    if (!typeBuf || typeBuf.length !== 1 || typeBuf[0] !== KEY_BUNDLE_TYPE[0])
        return null;
    const identity = getBinaryNodeChildBuffer(keysNode, 'identity');
    const skey = getBinaryNodeChild(keysNode, 'skey');
    if (!identity || identity.length !== 32 || !skey)
        return null;
    const registrationId = getBinaryNodeChildUInt(receipt, 'registration', 4);
    if (!isValidUInt(registrationId))
        return null;
    const signedPubKey = getBinaryNodeChildBuffer(skey, 'value');
    const signedSig = getBinaryNodeChildBuffer(skey, 'signature');
    const signedKeyId = getBinaryNodeChildUInt(skey, 'id', 3);
    if (!signedPubKey || signedPubKey.length !== 32 || !signedSig || !isValidUInt(signedKeyId)) {
        return null;
    }
    const preKeyNode = getBinaryNodeChild(keysNode, 'key');
    let preKey;
    if (preKeyNode) {
        const preKeyPub = getBinaryNodeChildBuffer(preKeyNode, 'value');
        const preKeyId = getBinaryNodeChildUInt(preKeyNode, 'id', 3);
        if (!preKeyPub || preKeyPub.length !== 32 || !isValidUInt(preKeyId)) {
            return null;
        }
        preKey = { keyId: preKeyId, publicKey: generateSignalPubKey(preKeyPub) };
    }
    return {
        registrationId,
        identityKey: generateSignalPubKey(identity),
        signedPreKey: {
            keyId: signedKeyId,
            publicKey: generateSignalPubKey(signedPubKey),
            signature: signedSig
        },
        preKey
    };
};
export const parseAndInjectE2ESessions = async (node, repository, logger) => {
    // AunuBaileys (1.0.72, HB-67, re-applied P3b): a <key>/<skey>
    // without a <value> child used to throw inside
    // generateSignalPubKey — the per-entry catch then skipped the
    // WHOLE device entry, although the signed pre-key alone is enough
    // to build a session. Skip just that key. A non-finite keyId
    // (missing/short <id>) makes the key equally unusable — skip it
    // the same way (the finite check is shared with HB-263's site;
    // extractE2ESessionFromRetryReceipt above already validates the
    // same way via isValidUInt).
    const extractKey = (key) => {
        if (!key) {
            return undefined;
        }
        const value = getBinaryNodeChildBuffer(key, 'value');
        // AunuBaileys (2.4.0, HB-367 addendum): a <value> that is
        // not exactly 32 bytes is not key material — the sibling
        // extractE2ESessionFromRetryReceipt rejects the same
        // lengths, but this path used to pass a 31-byte value
        // through generateSignalPubKey and inject a phantom
        // session that looked healthy locally (validateSession
        // passed) yet failed at the peer with a Bad MAC. Treat a
        // wrong-length value like a missing one.
        if (!value || value.length !== 32) {
            return undefined;
        }
        const keyId = getBinaryNodeChildUInt(key, 'id', 3);
        if (!isValidUInt(keyId)) {
            return undefined;
        }
        return {
            keyId,
            publicKey: generateSignalPubKey(value),
            signature: getBinaryNodeChildBuffer(key, 'signature')
        };
    };
    const nodes = getBinaryNodeChildren(getBinaryNodeChild(node, 'list'), 'user');
    // Most of the work in repository.injectE2ESession is CPU intensive, not IO
    // So Promise.all doesn't really help here,
    // but blocks even loop if we're using it inside keys.transaction, and it makes it "sync" actually
    // This way we chunk it in smaller parts and between those parts we can yield to the event loop
    // It's rare case when you need to E2E sessions for so many users, but it's possible
    const chunkSize = 100;
    const chunks = chunk(nodes, chunkSize);
    for (const nodesChunk of chunks) {
        // AunuBaileys (1.0.68, HB-1, re-applied P3b): the old loop threw
        // on the FIRST bad <user> node (error child / missing identity
        // / missing jid), aborting session injection for every other
        // user in the response. Bad entries are skipped per node; the
        // rest of the chunk still injects.
        await Promise.all(nodesChunk.map(async (node) => {
            try {
                assertNodeErrorFree(node);
                const signedKey = getBinaryNodeChild(node, 'skey');
                const key = getBinaryNodeChild(node, 'key');
                const identity = getBinaryNodeChildBuffer(node, 'identity');
                const jid = node.attrs.jid;
                // AunuBaileys (2.4.0, HB-367 addendum): the
                // identity key is key material too — a bundle
                // whose <identity> is not exactly 32 bytes
                // injects the same phantom session as a short
                // pre-key (see extractKey above); the retry-
                // receipt sibling rejects it the same way.
                if (!jid || !identity || identity.length !== 32) {
                    throw new Error('key-bundle entry is missing jid or identity, or its identity is not 32 bytes');
                }
                // A signed pre-key is what the session is built
                // on: a present-but-unusable <skey> (missing or
                // wrong-length <value>, bad <id>) must skip the
                // entry here instead of injecting a session
                // without one. An absent <key> stays optional —
                // libsignal accepts a session with no one-time
                // pre-key.
                const signedPreKey = extractKey(signedKey);
                if (!signedPreKey) {
                    throw new Error('key-bundle entry has no valid signed pre-key');
                }
                const registrationId = getBinaryNodeChildUInt(node, 'registration', 4);
                // AunuBaileys (2.2.0, HB-367 + addendum): an entry
                // without a valid <registration> (missing, short or
                // empty — the short forms parse to NaN) used to be
                // injected with registrationId undefined/NaN and
                // stored as a phantom session: present in the store
                // yet validateSession reported no open session, so
                // assertSessions refetched and re-injected on every
                // send. Skip the entry, like the retry-receipt
                // sibling above already does via isValidUInt.
                if (!isValidUInt(registrationId)) {
                    throw new Error('key-bundle entry is missing a valid registration id');
                }
                await repository.injectE2ESession({
                    jid,
                    session: {
                        registrationId: registrationId,
                        identityKey: generateSignalPubKey(identity),
                        signedPreKey,
                        preKey: extractKey(key)
                    }
                });
            }
            catch (err) {
                logger?.warn({ jid: node.attrs?.jid, err: err?.message }, 'aunu: skipping bad key-bundle entry; other sessions continue');
            }
        }));
    }
};
export const extractDeviceJids = (result, myJid, myLid, excludeZeroDevices) => {
    const { user: myUser, device: myDevice } = jidDecode(myJid) || {};
    // AunuBaileys (2.1.0, HB-332, donor v6 1.0.83 HB-258): our own devices exist under TWO identities — compare the LID user, not the raw myLid JID, or our own LID device is never excluded (wasted self-encryption/delivery in LID groups).
    const myLidUser = myLid ? jidDecode(myLid)?.user : undefined;
    const extracted = [];
    for (const userResult of result) {
        const { devices, id } = userResult;
        const decoded = jidDecode(id);
        if (!decoded?.user || !decoded?.server) {
            continue;
        }
        const { user, server } = decoded;
        let { domainType } = decoded;
        const deviceList = devices?.deviceList;
        if (!Array.isArray(deviceList))
            continue;
        for (const { id: device, keyIndex, isHosted } of deviceList) {
            if (
            // AunuBaileys (HB-272, P4): defence in depth behind the
            // USync parser guard — a NaN device id (missing <device>
            // id attribute) satisfied the keyIndex clause below and
            // collapsed to the bare JID in jidEncode.
            Number.isFinite(device) &&
                (!excludeZeroDevices || device !== 0) && // if zero devices are not-excluded, or device is non zero
                ((myUser !== user && myLidUser !== user) || myDevice !== device) && // either different user or if me user, not this device
                device !== 99 && // hosted / Cloud-API companion devices (:99) are not E2E targets — libsignal rejects them; skip them when building the device list
                (device === 0 || !!keyIndex) // ensure that "key-index" is specified for "non-zero" devices, produces a bad req otherwise
            ) {
                // AunuBaileys (2.5.0, HB-414): `domainType` is
                // per-user state — mutating it for a hosted device
                // leaked the hosted domain onto every later device
                // of the same user. Derive the device's own domain
                // instead and leave the per-user value untouched.
                const deviceDomainType = isHosted
                    ? domainType === WAJIDDomains.LID
                        ? WAJIDDomains.HOSTED_LID
                        : WAJIDDomains.HOSTED
                    : domainType;
                extracted.push({
                    user,
                    device,
                    domainType: deviceDomainType,
                    server: getServerFromDomainType(server, deviceDomainType)
                });
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
    // AunuBaileys (1.0.72, HB-83 + 1.0.74 HB-98, re-applied P3b): a
    // stored pre-key entry with a wrong shape ({} — valid JSON, no key
    // material) used to be uploaded as an EMPTY <value>; truthiness
    // alone also let a wrong-TYPED public (e.g. a number) through to
    // the node encoder, which threw "invalid children". Skip entries
    // without real key material here too.
    const preKeys = {};
    for (const [preKeyId, pair] of Object.entries(storedPreKeys)) {
        // AunuBaileys (2.2.0, HB-83 addendum): HB-83 filtered on the
        // PUBLIC half only — an entry with a valid public but a
        // corrupt/missing private was still uploaded; the server
        // then advertised a pre-key we can never answer (loadPreKey
        // rejects it under HB-98), costing the peer a failed pkmsg
        // and a retry round-trip per corrupt id. Require BOTH
        // halves. (The sendRetryRequest consumer is already safe
        // against an empty map — HB-154's fresh-pair fallback.)
        if (pair && isKeyMaterial(pair.public) && isKeyMaterial(pair.private)) {
            preKeys[preKeyId] = pair;
        }
    }
    return { update, preKeys };
};
export const getNextPreKeysNode = async (state, count) => {
    const { creds } = state;
    // AunuBaileys (1.0.72, HB-68, re-applied P3b): the identity fields
    // are dereferenced bare below — partial creds turned that into a
    // bare TypeError and a reconnect loop at every boot. Fail
    // descriptively, like loadSignedPreKey (HB-26).
    if (!isKeyMaterial(creds.signedIdentityKey?.public) ||
        !isKeyMaterial(creds.signedPreKey?.keyPair?.public) ||
        !isKeyMaterial(creds.signedPreKey?.signature) ||
        typeof creds.signedPreKey?.keyId === 'undefined') {
        throw new Error('AunuBaileys: creds.signedIdentityKey / creds.signedPreKey are missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again');
    }
    // AunuBaileys (1.0.79, addendum HB-80, re-applied P3b): a missing
    // registrationId silently became registration 00000000 in the
    // node below (encodeBigEndian does not throw on undefined).
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
            // AunuBaileys (HB-157, re-applied P3b): publish the key
            // BYTES, not the base64 text of a string-stored key.
            { tag: 'identity', attrs: {}, content: keyMaterialToBuffer(creds.signedIdentityKey.public) },
            { tag: 'list', attrs: {}, content: Object.keys(preKeys).map(k => xmppPreKey(preKeys[+k], +k)) },
            xmppSignedPreKey(creds.signedPreKey)
        ]
    };
    return { update, node };
};
//# sourceMappingURL=signal.js.map
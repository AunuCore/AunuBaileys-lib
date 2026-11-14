import { Boom } from '@hapi/boom';
import { createHash } from 'crypto';
import { proto } from '../../WAProto/index.js';
import { KEY_BUNDLE_TYPE } from '../Defaults/index.js';
import { getBinaryNodeChild, jidDecode, S_WHATSAPP_NET } from '../WABinary/index.js';
import { Curve, hmacSign, keyMaterialToBuffer } from './crypto.js';
import { encodeBigEndian } from './generics.js';
import { createSignalIdentity } from './signal.js';
// AunuBaileys (1.0.74): HB-98 — key material is only ever a Buffer
// (or a string in a hand-edited creds file). Anything else is a
// wrong-typed corrupt value, not key material.
const isKeyMaterial = (value) => Buffer.isBuffer(value) || typeof value === 'string';
const getUserAgent = (config) => {
    // AunuBaileys (1.0.70): a host overriding version with undefined
    // used to throw a raw TypeError here; fall back to the bundled
    // WA Web version.
    const version = Array.isArray(config.version) && config.version.length >= 3 ? config.version : [2, 3000, 1043857760];
    return {
        appVersion: {
            primary: version[0],
            secondary: version[1],
            tertiary: version[2]
        },
        platform: proto.ClientPayload.UserAgent.Platform.WEB,
        releaseChannel: proto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
        osVersion: '0.1',
        device: 'Desktop',
        osBuildNumber: '0.1',
        localeLanguageIso6391: 'en',
        mnc: '000',
        mcc: '000',
        localeCountryIso31661Alpha2: config.countryCode
    };
};
const PLATFORM_MAP = {
    'Mac OS': proto.ClientPayload.WebInfo.WebSubPlatform.DARWIN,
    Windows: proto.ClientPayload.WebInfo.WebSubPlatform.WIN32
};
const getWebInfo = (config) => {
    let webSubPlatform = proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER;
    if (config.syncFullHistory && PLATFORM_MAP[config.browser?.[0]]) {
        webSubPlatform = PLATFORM_MAP[config.browser?.[0]];
    }
    return { webSubPlatform };
};
const getClientPayload = (config) => {
    const payload = {
        connectType: proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
        connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
        userAgent: getUserAgent(config)
    };
    payload.webInfo = getWebInfo(config);
    return payload;
};
export const generateLoginNode = (userJid, config) => {
    // AunuBaileys (1.0.70): a malformed me.id (restored/edited creds,
    // or a pair-success without a jid attr) used to throw a raw
    // TypeError here and loop the reconnect on every boot.
    const decoded = jidDecode(userJid);
    if (!decoded) {
        throw new Boom(`Invalid own JID for login node: ${userJid}`, { statusCode: 400 });
    }
    const { user, device, server } = decoded;
    // AunuBaileys (1.0.79, HB-234): the HB-43 guard above only
    // checks that the JID decodes — a non-numeric user
    // ('abc@s.whatsapp.net') was then silently coerced by +user to
    // username 0 (or clamped to int64-max on a 26-digit overflow)
    // and the login node went out carrying a WRONG identity,
    // looping on server rejects. Validate the parts: the user must
    // be all digits, non-zero and within int64 range; the server
    // must be the user server; and a present device must be a
    // finite number (jidDecode's +device turns 'xx' into NaN,
    // which protobuf then silently encoded as 0).
    const userValue = /^\d+$/.test(user) ? BigInt(user) : 0n;
    if (userValue <= 0n || userValue > 9223372036854775807n || server !== 's.whatsapp.net' || (typeof device !== 'undefined' && !Number.isFinite(device))) {
        throw new Boom(`Invalid own JID for login node: ${userJid}`, { statusCode: 400 });
    }
    const payload = {
        ...getClientPayload(config),
        passive: false,
        pull: true,
        username: +user,
        device: device
    };
    return proto.ClientPayload.fromObject(payload);
};
const getPlatformType = (platform) => {
    const platformType = platform.toUpperCase();
    return (proto.DeviceProps.PlatformType[platformType] ||
        proto.DeviceProps.PlatformType.DESKTOP);
};
export const generateRegistrationNode = ({ registrationId, signedPreKey, signedIdentityKey }, config) => {
    // AunuBaileys (1.0.72): the identity fields are dereferenced bare
    // below — partial creds turned that into a bare TypeError deep in
    // the pairing flow (HB-80). Fail descriptively, like
    // loadSignedPreKey (HB-26/54).
    if (!isKeyMaterial(signedIdentityKey?.public) || !isKeyMaterial(signedPreKey?.keyPair?.public) || typeof signedPreKey?.keyId === 'undefined' || !isKeyMaterial(signedPreKey?.signature)) {
        throw new Error('AunuBaileys: creds.signedIdentityKey / creds.signedPreKey are missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again');
    }
    // AunuBaileys (1.0.79, addendum HB-80): registrationId was NOT
    // part of the guard — encodeBigEndian(undefined) does not
    // throw, it silently produces eRegid 00000000, so a partial
    // creds restore registered with a bogus registration id and
    // no local signal at all.
    if (!Number.isFinite(registrationId)) {
        throw new Error('AunuBaileys: creds.registrationId is missing or invalid — the auth state is incomplete or corrupt; restore a full backup or pair again');
    }
    // the app version needs to be md5 hashed
    // and passed in
    const safeVersion = Array.isArray(config.version) && config.version.length ? config.version : [2, 3000, 1043857760];
    const appVersionBuf = createHash('md5')
        .update(safeVersion.join('.')) // join as string
        .digest();
    const companion = {
        os: config.browser?.[0] || 'Chrome',
        platformType: getPlatformType(config.browser?.[1] || 'Chrome'),
        requireFullSync: config.syncFullHistory,
        historySyncConfig: {
            storageQuotaMb: 10240,
            inlineInitialPayloadInE2EeMsg: true,
            recentSyncDaysLimit: undefined,
            supportCallLogHistory: false,
            supportBotUserAgentChatHistory: true,
            supportCagReactionsAndPolls: true,
            supportBizHostedMsg: true,
            supportRecentSyncChunkMessageCountTuning: true,
            supportHostedGroupMsg: true,
            supportFbidBotChatHistory: true,
            supportAddOnHistorySyncMigration: undefined,
            supportMessageAssociation: true,
        },
    };
    const companionProto = proto.DeviceProps.encode(companion).finish();
    const registerPayload = {
        ...getClientPayload(config),
        passive: false,
        pull: false,
        devicePairingData: {
            buildHash: appVersionBuf,
            deviceProps: companionProto,
            eRegid: encodeBigEndian(registrationId),
            eKeytype: KEY_BUNDLE_TYPE,
            eIdent: signedIdentityKey.public,
            eSkeyId: encodeBigEndian(signedPreKey.keyId, 3),
            eSkeyVal: signedPreKey.keyPair.public,
            eSkeySig: signedPreKey.signature
        }
    };
    return proto.ClientPayload.fromObject(registerPayload);
};
export const configureSuccessfulPairing = (stanza, { advSecretKey, signedIdentityKey, signalIdentities }) => {
    const msgId = stanza.attrs.id;
    // AunuBaileys (1.0.79, HB-80 sub-instance): the creds fields are
    // dereferenced bare below (Buffer.from(advSecretKey, 'base64'),
    // the identity concat/sign) — a partial creds died as a bare
    // TypeError inside the pair-success handler. Fail descriptively,
    // like the registration guards.
    if (typeof advSecretKey !== 'string' || !advSecretKey || !isKeyMaterial(signedIdentityKey?.public) || !isKeyMaterial(signedIdentityKey?.private)) {
        throw new Error('AunuBaileys: creds.advSecretKey / creds.signedIdentityKey are missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again');
    }
    const pairSuccessNode = getBinaryNodeChild(stanza, 'pair-success');
    const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, 'device-identity');
    const platformNode = getBinaryNodeChild(pairSuccessNode, 'platform');
    const deviceNode = getBinaryNodeChild(pairSuccessNode, 'device');
    const businessNode = getBinaryNodeChild(pairSuccessNode, 'biz');
    if (!deviceIdentityNode || !deviceNode) {
        throw new Boom('Missing device-identity or device in pair success node', { data: stanza });
    }
    const bizName = businessNode?.attrs.name;
    const jid = deviceNode.attrs.jid;
    // AunuBaileys (1.0.79, HB-239): a pair-success stanza without a
    // device jid used to store me.id = undefined SILENTLY — pairing
    // "succeeded", and the NEXT boot took the login path and looped
    // on the HB-43 Boom 400 forever. Reject the stanza here, where
    // the defect is. The addendum: a device-identity node without
    // content died as protobufjs' bare 'Error: illegal buffer' —
    // same missing-guard class, same fix.
    if (typeof jid !== 'string' || !jid) {
        throw new Boom('Missing jid on the device node in pair success stanza', { data: stanza });
    }
    if (!deviceIdentityNode.content?.length) {
        throw new Boom('Missing content on the device-identity node in pair success stanza', { data: stanza });
    }
    const { details, hmac, accountType } = proto.ADVSignedDeviceIdentityHMAC.decode(deviceIdentityNode.content);
    const isHostedAccount = accountType !== undefined && accountType === proto.ADVEncryptionType.HOSTED;
    const hmacPrefix = isHostedAccount ? Buffer.from([6, 5]) : Buffer.alloc(0);
    const advSign = hmacSign(Buffer.concat([hmacPrefix, details]), Buffer.from(advSecretKey, 'base64'));
    if (Buffer.compare(hmac, advSign) !== 0) {
        throw new Boom('Invalid account signature');
    }
    const account = proto.ADVSignedDeviceIdentity.decode(details);
    const { accountSignatureKey, accountSignature, details: deviceDetails } = account;
    // AunuBaileys (1.0.78, HB-157): a string identity key is base64 —
    // the raw concat used to die with a TypeError on string creds.
    const accountMsg = Buffer.concat([Buffer.from([6, 0]), deviceDetails, keyMaterialToBuffer(signedIdentityKey.public)]);
    if (!Curve.verify(accountSignatureKey, accountMsg, accountSignature)) {
        throw new Boom('Failed to verify account signature');
    }
    const devicePrefix = isHostedAccount ? Buffer.from([6, 6]) : Buffer.from([6, 1]);
    const deviceMsg = Buffer.concat([devicePrefix, deviceDetails, keyMaterialToBuffer(signedIdentityKey.public), accountSignatureKey]);
    account.deviceSignature = Curve.sign(signedIdentityKey.private, deviceMsg);
    const identity = createSignalIdentity(jid, accountSignatureKey);
    const accountEnc = encodeSignedDeviceIdentity(account, false);
    const deviceIdentity = proto.ADVDeviceIdentity.decode(account.details);
    const reply = {
        tag: 'iq',
        attrs: {
            to: S_WHATSAPP_NET,
            type: 'result',
            id: msgId
        },
        content: [
            {
                tag: 'pair-device-sign',
                attrs: {},
                content: [
                    {
                        tag: 'device-identity',
                        attrs: { 'key-index': deviceIdentity.keyIndex.toString() },
                        content: accountEnc
                    }
                ]
            }
        ]
    };
    const authUpdate = {
        account,
        me: { id: jid, name: bizName },
        signalIdentities: [...(signalIdentities || []), identity],
        platform: platformNode?.attrs.name
    };
    return {
        creds: authUpdate,
        reply
    };
};
export const encodeSignedDeviceIdentity = (account, includeSignatureKey) => {
    account = { ...account };
    // set to null if we are not to include the signature key
    // or if we are including the signature key but it is empty
    if (!includeSignatureKey || !account.accountSignatureKey?.length) {
        account.accountSignatureKey = null;
    }
    return proto.ADVSignedDeviceIdentity.encode(account).finish();
};
//# sourceMappingURL=validate-connection.js.map
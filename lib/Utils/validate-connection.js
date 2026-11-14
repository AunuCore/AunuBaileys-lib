import { Boom } from '@hapi/boom';
import { createHash } from 'crypto';
import { proto } from '../../WAProto/index.js';
import { KEY_BUNDLE_TYPE, WA_ADV_ACCOUNT_SIG_PREFIX, WA_ADV_DEVICE_SIG_PREFIX, WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX } from '../Defaults/index.js';
import { getBinaryNodeChild, jidDecode, S_WHATSAPP_NET } from '../WABinary/index.js';
import { Curve, hmacSign, keyMaterialToBuffer } from './crypto.js';
import { encodeBigEndian } from './generics.js';
import { createSignalIdentity } from './signal.js';
// AunuBaileys (1.0.74, HB-98): key material is only ever a Buffer
// (or a base64 string in a hand-edited creds file). Anything else is
// a wrong-typed corrupt value, not key material.
const isKeyMaterial = (value) => value instanceof Uint8Array || typeof value === 'string';
const getUserAgent = (config) => {
    return {
        appVersion: {
            primary: config.version[0],
            secondary: config.version[1],
            tertiary: config.version[2]
        },
        platform: config.browser[1].toLocaleLowerCase().includes('android')
            ? proto.ClientPayload.UserAgent.Platform.ANDROID
            : proto.ClientPayload.UserAgent.Platform.WEB,
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
    Windows: proto.ClientPayload.WebInfo.WebSubPlatform.WIN_HYBRID
};
const getWebInfo = (config) => {
    let webSubPlatform = proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER;
    if (config.syncFullHistory &&
        PLATFORM_MAP[config.browser[0]] &&
        config.browser[1] === 'Desktop') {
        webSubPlatform = PLATFORM_MAP[config.browser[0]];
    }
    return { webSubPlatform };
};
const getClientPayload = (config) => {
    const payload = {
        connectType: proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
        connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
        userAgent: getUserAgent(config)
    };
    if (!config.browser[1].toLocaleLowerCase().includes('android')) {
        payload.webInfo = getWebInfo(config);
    }
    if (config.pushName) {
        payload.pushName = config.pushName;
    }
    return payload;
};
export const generateLoginNode = (userJid, config) => {
    // AunuBaileys (1.0.70, HB-43 + 1.0.79 HB-234 facet, re-applied
    // P3b): an undecodable own JID used to throw a bare TypeError
    // here and loop the reconnect on every boot; a decodable but
    // non-numeric user ('abc@s.whatsapp.net') was then silently
    // coerced by +user to username 0 (or clamped to int64-max on a
    // 26-digit overflow) and the login node went out carrying a
    // WRONG identity. Validate the parts: the user must be all
    // digits, non-zero and within int64 range; the server must be
    // the user server; a present device must be a finite number
    // (jidDecode's +device turns 'xx' into NaN, which protobuf then
    // silently encoded as 0).
    const decoded = jidDecode(userJid);
    if (!decoded) {
        throw new Boom(`Invalid own JID for login node: ${userJid}`, { statusCode: 400 });
    }
    const { user, device, server } = decoded;
    const userValue = /^\d+$/.test(user) ? BigInt(user) : 0n;
    if (userValue <= 0n ||
        userValue > 9223372036854775807n ||
        server !== 's.whatsapp.net' ||
        (typeof device !== 'undefined' && !Number.isFinite(device))) {
        throw new Boom(`Invalid own JID for login node: ${userJid}`, { statusCode: 400 });
    }
    const payload = {
        ...getClientPayload(config),
        passive: true,
        pull: true,
        username: +user,
        device: device,
        // TODO: investigate (hard set as false atm)
        lidDbMigrated: false
    };
    return proto.ClientPayload.fromObject(payload);
};
const getPlatformType = (platform) => {
    const platformType = platform.toUpperCase();
    if (platformType === 'ANDROID') {
        return proto.DeviceProps.PlatformType.ANDROID_PHONE;
    }
    return (proto.DeviceProps.PlatformType[platformType] ||
        proto.DeviceProps.PlatformType.CHROME);
};
export const generateRegistrationNode = ({ registrationId, signedPreKey, signedIdentityKey }, config) => {
    // AunuBaileys (1.0.72, HB-80, re-applied P3b): the identity
    // fields are dereferenced bare below — partial creds turned
    // that into a bare TypeError deep in the pairing flow. Fail
    // descriptively, like loadSignedPreKey (HB-26).
    if (!isKeyMaterial(signedIdentityKey?.public) ||
        !isKeyMaterial(signedPreKey?.keyPair?.public) ||
        typeof signedPreKey?.keyId === 'undefined' ||
        !isKeyMaterial(signedPreKey?.signature)) {
        throw new Error('AunuBaileys: creds.signedIdentityKey / creds.signedPreKey are missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again');
    }
    // AunuBaileys (1.0.79, addendum HB-80, re-applied P3b):
    // registrationId was NOT part of the guard — encodeBigEndian
    // (undefined) does not throw, it silently produces eRegid
    // 00000000, so a partial creds restore registered with a bogus
    // registration id and no local signal at all.
    if (!Number.isFinite(registrationId)) {
        throw new Error('AunuBaileys: creds.registrationId is missing or invalid — the auth state is incomplete or corrupt; restore a full backup or pair again');
    }
    // the app version needs to be md5 hashed
    // and passed in
    const appVersionBuf = createHash('md5')
        .update(config.version.join('.')) // join as string
        .digest();
    const companion = {
        os: config.browser[0],
        platformType: getPlatformType(config.browser[1]),
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
            supportGroupHistory: false,
            onDemandReady: undefined,
            supportGuestChat: undefined
        },
        version: {
            primary: 10,
            secondary: 15,
            tertiary: 7
        }
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
            // AunuBaileys (HB-157, re-applied P3b): the payload must
            // carry the key BYTES, not the base64 text of a
            // string-stored key.
            eIdent: keyMaterialToBuffer(signedIdentityKey.public),
            eSkeyId: encodeBigEndian(signedPreKey.keyId, 3),
            eSkeyVal: keyMaterialToBuffer(signedPreKey.keyPair.public),
            eSkeySig: keyMaterialToBuffer(signedPreKey.signature)
        }
    };
    return proto.ClientPayload.fromObject(registerPayload);
};
export const configureSuccessfulPairing = (stanza, { advSecretKey, signedIdentityKey, signalIdentities }) => {
    // AunuBaileys (1.0.79, HB-80 sub-instance, re-applied P3b): the
    // creds fields are dereferenced bare below (Buffer.from
    // (advSecretKey, 'base64'), the identity concat/sign) — a
    // partial creds died as a bare TypeError inside the pair-success
    // handler. Fail descriptively, like the registration guards.
    if (typeof advSecretKey !== 'string' ||
        !advSecretKey ||
        !isKeyMaterial(signedIdentityKey?.public) ||
        !isKeyMaterial(signedIdentityKey?.private)) {
        throw new Error('AunuBaileys: creds.advSecretKey / creds.signedIdentityKey are missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again');
    }
    const msgId = stanza.attrs.id;
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
    // AunuBaileys (1.0.79, HB-239, re-applied P3b): a pair-success stanza
    // without a device jid used to store me.id = undefined SILENTLY —
    // pairing 'succeeded', and the NEXT boot took the login path and
    // looped on the HB-43 Boom 400 forever. Reject the stanza here, where
    // the defect is. The addendum: a device-identity node without content
    // died as protobufjs' bare 'Error: illegal buffer' — same missing-guard
    // class, same fix.
    if (typeof jid !== 'string' || !jid) {
        throw new Boom('Missing jid on the device node in pair success stanza', { data: stanza });
    }
    if (!deviceIdentityNode.content?.length) {
        throw new Boom('Missing content on the device-identity node in pair success stanza', { data: stanza });
    }
    const lid = deviceNode.attrs.lid;
    const { details, hmac, accountType } = proto.ADVSignedDeviceIdentityHMAC.decode(deviceIdentityNode.content);
    let hmacPrefix = Buffer.from([]);
    if (accountType !== undefined && accountType === proto.ADVEncryptionType.HOSTED) {
        hmacPrefix = WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX;
    }
    const advSign = hmacSign(Buffer.concat([hmacPrefix, details]), Buffer.from(advSecretKey, 'base64'));
    if (Buffer.compare(hmac, advSign) !== 0) {
        throw new Boom('Invalid account signature');
    }
    const account = proto.ADVSignedDeviceIdentity.decode(details);
    const { accountSignatureKey, accountSignature, details: deviceDetails } = account;
    const deviceIdentity = proto.ADVDeviceIdentity.decode(deviceDetails);
    const accountSignaturePrefix = deviceIdentity.deviceType === proto.ADVEncryptionType.HOSTED
        ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
        : WA_ADV_ACCOUNT_SIG_PREFIX;
    // AunuBaileys (1.0.78, HB-157, re-applied P3b): Buffer.concat
    // needs the key BYTES — a base64-string public key in a
    // hand-edited creds file threw a bare TypeError here (or, where
    // it did not throw, signed over the base64 TEXT).
    const accountMsg = Buffer.concat([
        accountSignaturePrefix,
        deviceDetails,
        keyMaterialToBuffer(signedIdentityKey.public)
    ]);
    if (!Curve.verify(accountSignatureKey, accountMsg, accountSignature)) {
        throw new Boom('Failed to verify account signature');
    }
    const deviceMsg = Buffer.concat([
        WA_ADV_DEVICE_SIG_PREFIX,
        deviceDetails,
        keyMaterialToBuffer(signedIdentityKey.public),
        accountSignatureKey
    ]);
    account.deviceSignature = Curve.sign(signedIdentityKey.private, deviceMsg);
    const identity = createSignalIdentity(lid, accountSignatureKey);
    const accountEnc = encodeSignedDeviceIdentity(account, false);
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
        me: { id: jid, name: bizName, lid },
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
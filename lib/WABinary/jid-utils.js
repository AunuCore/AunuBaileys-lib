export const S_WHATSAPP_NET = '@s.whatsapp.net';
export const OFFICIAL_BIZ_JID = '16505361212@c.us';
export const SERVER_JID = 'server@c.us';
export const PSA_WID = '0@c.us';
export const STORIES_JID = 'status@broadcast';
export const META_AI_JID = '13135550002@c.us';
export var WAJIDDomains;
(function (WAJIDDomains) {
    WAJIDDomains[WAJIDDomains["WHATSAPP"] = 0] = "WHATSAPP";
    WAJIDDomains[WAJIDDomains["LID"] = 1] = "LID";
    WAJIDDomains[WAJIDDomains["HOSTED"] = 128] = "HOSTED";
    WAJIDDomains[WAJIDDomains["HOSTED_LID"] = 129] = "HOSTED_LID";
})(WAJIDDomains || (WAJIDDomains = {}));
export const getServerFromDomainType = (initialServer, domainType) => {
    switch (domainType) {
        case WAJIDDomains.LID:
            return 'lid';
        case WAJIDDomains.HOSTED:
            return 'hosted';
        case WAJIDDomains.HOSTED_LID:
            return 'hosted.lid';
        case WAJIDDomains.WHATSAPP:
        default:
            return initialServer;
    }
};
export const jidEncode = (user, server, device, agent) => {
    return `${user || ''}${!!agent ? `_${agent}` : ''}${!!device ? `:${device}` : ''}@${server}`;
};
export const jidDecode = (jid) => {
    // todo: investigate how to implement hosted ids in this case
    const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1;
    if (sepIdx < 0) {
        return undefined;
    }
    const server = jid.slice(sepIdx + 1);
    const userCombined = jid.slice(0, sepIdx);
    const [userAgent, device] = userCombined.split(':');
    const [user, agent] = userAgent.split('_');
    let domainType = WAJIDDomains.WHATSAPP;
    if (server === 'lid') {
        domainType = WAJIDDomains.LID;
    }
    else if (server === 'hosted') {
        domainType = WAJIDDomains.HOSTED;
    }
    else if (server === 'hosted.lid') {
        domainType = WAJIDDomains.HOSTED_LID;
    }
    else if (agent) {
        domainType = parseInt(agent);
    }
    return {
        server: server,
        user: user,
        domainType,
        device: device ? +device : undefined
    };
};
/** is the jid a user */
export const areJidsSameUser = (jid1, jid2) => jidDecode(jid1)?.user === jidDecode(jid2)?.user;
// AunuBaileys (2.8.0, HB-505): the predicates below are the choke
// point for every JID classification in the tree, and callers feed
// them wire/host values that are not always strings. `jid?.endsWith`
// only guards null/undefined — a truthy number/object/boolean threw
// a raw TypeError. A non-string is never any of these JID kinds, so
// every predicate answers false for it.
/** is the jid Meta AI */
export const isJidMetaAI = (jid) => typeof jid === 'string' && jid.endsWith('@bot');
/** is the jid a PN user */
export const isPnUser = (jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
/** is the jid a LID */
export const isLidUser = (jid) => typeof jid === 'string' && jid.endsWith('@lid');
/** is the jid a broadcast */
export const isJidBroadcast = (jid) => typeof jid === 'string' && jid.endsWith('@broadcast');
/** is the jid a group */
export const isJidGroup = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');
/** is the jid the status broadcast */
export const isJidStatusBroadcast = (jid) => jid === 'status@broadcast';
/** is the jid a newsletter */
export const isJidNewsletter = (jid) => typeof jid === 'string' && jid.endsWith('@newsletter');
/** is the jid a hosted PN */
export const isHostedPnUser = (jid) => typeof jid === 'string' && jid.endsWith('@hosted');
/** is the jid a hosted LID */
export const isHostedLidUser = (jid) => typeof jid === 'string' && jid.endsWith('@hosted.lid');
const botRegexp = /^1313555\d{4}$|^131655500\d{2}$/;
export const isJidBot = (jid) => typeof jid === 'string' && botRegexp.test(jid.split('@')[0]) && jid.endsWith('@c.us');
export const jidNormalizedUser = (jid) => {
    const result = jidDecode(jid);
    if (!result) {
        return '';
    }
    const { user, server } = result;
    return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : server);
};
export const transferDevice = (fromJid, toJid) => {
    const fromDecoded = jidDecode(fromJid);
    const deviceId = fromDecoded?.device || 0;
    // AunuBaileys (2.1.0, sweep): a toJid without '@' made jidDecode
    // return undefined, and the bare `!` died as a raw TypeError.
    const toDecoded = jidDecode(toJid);
    if (!toDecoded?.user || !toDecoded?.server) {
        throw new Error(`transferDevice: invalid toJid "${toJid}"`);
    }
    const { server, user } = toDecoded;
    return jidEncode(user, server, deviceId);
};
//# sourceMappingURL=jid-utils.js.map
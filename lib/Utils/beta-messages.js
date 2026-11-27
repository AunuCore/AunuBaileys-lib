import { Boom } from '@hapi/boom';
/**
 * AunuBaileys (2.8.0, D-1107): beta-message dispatcher.
 *
 * Recorded from the pontalabs delta in the heartbeat ledger
 * (run-1328): a small set of content keys the official beta client
 * dispatches specially, a validator that rejects a beta content
 * missing its load-bearing field with Boom 400, and a denylist of
 * content classes that must never be routed through the beta path.
 * Every proto type dispatched here already exists in our WAProto;
 * the value is the dispatch + validation, not a new wire surface.
 * (The companion proto delta from the same donor —
 * Message.newsletterFollowerInviteMessage = 108 — is NOT included:
 * WAProto is generated and the field cannot be added by hand.)
 */
export const BETA_CONTENT_KEYS = [
    'music',
    'eventInvite',
    'requestLocation',
    'requestLocationUpdate',
    'instantImage',
    'instantVideo',
    'audioSticker',
    'beta'
];
export const BETA_BLOCKED_KEYS = [
    'payment',
    'split',
    'vpc',
    'rootsecret',
    'rootkey',
    'botplatformregistration',
    'acp2',
    'botgroupparticipant',
    'newsletteradminprofile',
    'newsletterscheduled'
];
const BETA_KEY_SET = new Set(BETA_CONTENT_KEYS);
const BETA_BLOCKED_SET = new Set(BETA_BLOCKED_KEYS);
const isRecord = (value) => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};
/** The beta content key a message content carries, if any. */
export const detectBetaKey = (content) => {
    if (!isRecord(content)) {
        return undefined;
    }
    for (const key of BETA_CONTENT_KEYS) {
        if (key in content && content[key] !== undefined && content[key] !== null) {
            return key;
        }
    }
    return undefined;
};
const requireField = (key, value, field) => {
    if (typeof value[field] !== 'string' || !value[field]) {
        throw new Boom(`beta content "${key}" requires a non-empty "${field}"`, { statusCode: 400 });
    }
};
/**
 * Validate a beta message content and return it unchanged, ready
 * for sock.sendMessage. Throws Boom 400 for a blocked content
 * class, for content carrying no (or several) beta keys, for a
 * non-object beta value, and for a beta content missing the field
 * it cannot act without (music.songUri, eventInvite.eventId).
 */
export const buildBetaMessage = (content) => {
    if (!isRecord(content)) {
        throw new Boom('beta message content must be an object', { statusCode: 400 });
    }
    for (const key of Object.keys(content)) {
        if (BETA_BLOCKED_SET.has(key.toLowerCase())) {
            throw new Boom(`beta message content "${key}" is blocked from the beta path`, { statusCode: 400 });
        }
    }
    const record = content;
    const present = BETA_CONTENT_KEYS.filter(key => key in record && record[key] !== undefined && record[key] !== null);
    if (present.length === 0) {
        throw new Boom(`beta message content carries none of the beta keys (${BETA_CONTENT_KEYS.join(', ')})`, {
            statusCode: 400
        });
    }
    if (present.length > 1) {
        throw new Boom(`beta message content carries several beta keys (${present.join(', ')}); exactly one is allowed`, {
            statusCode: 400
        });
    }
    const key = present[0];
    const value = record[key];
    if (!isRecord(value)) {
        throw new Boom(`beta content "${key}" must be an object`, { statusCode: 400 });
    }
    if (key === 'music') {
        requireField(key, value, 'songUri');
    }
    else if (key === 'eventInvite') {
        requireField(key, value, 'eventId');
    }
    return content;
};
export const isBetaContentKey = (key) => BETA_KEY_SET.has(key);
//# sourceMappingURL=beta-messages.js.map
import { Boom } from '@hapi/boom';
import { randomUUID } from 'crypto';
import { QueryIds, XWAPaths } from '../Types/index.js';
import { S_WHATSAPP_NET } from '../WABinary/index.js';
import { USyncQuery, USyncUser } from '../WAUSync/index.js';
import { executeWMexQuery } from './mex.js';
import { makeSocket } from './socket.js';
export const makeUSyncSocket = (config) => {
    const sock = makeSocket(config);
    const { generateMessageTag, query } = sock;
    const executeUSyncQuery = async (usyncQuery) => {
        if (usyncQuery.protocols.length === 0) {
            throw new Boom('USyncQuery must have at least one protocol');
        }
        // todo: validate users, throw WARNING on no valid users
        // variable below has only validated users
        const validUsers = usyncQuery.users;
        const userNodes = validUsers.map(user => {
            return {
                tag: 'user',
                attrs: {
                    jid: !user.phone ? user.id : undefined
                },
                content: usyncQuery.protocols.map(a => a.getUserElement(user)).filter(a => a !== null)
            };
        });
        const listNode = {
            tag: 'list',
            attrs: {},
            content: userNodes
        };
        const queryNode = {
            tag: 'query',
            attrs: {},
            content: usyncQuery.protocols.map(a => a.getQueryElement())
        };
        const iq = {
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'get',
                xmlns: 'usync'
            },
            content: [
                {
                    tag: 'usync',
                    attrs: {
                        context: usyncQuery.context,
                        mode: usyncQuery.mode,
                        sid: generateMessageTag(),
                        last: 'true',
                        index: '0'
                    },
                    content: [queryNode, listNode]
                }
            ]
        };
        const result = await query(iq);
        return usyncQuery.parseUSyncQueryResult(result);
    };
    /**
     * Look up accounts by their WhatsApp @username instead of a phone number.
     * Each query is either a plain username string, or `{ username, usernameKey, lid }`
     * where usernameKey is the PIN protecting the username.
     */
    const onWhatsAppUsername = async (...queries) => {
        // username users are LID-only; ask for LID addressing like WA Web does
        const usyncQuery = new USyncQuery().withContactProtocol('lid').withUsernameProtocol().withBusinessProtocol(null);
        const normalized = [];
        for (const item of queries) {
            const raw = typeof item === 'string' ? item : item?.username;
            const username = raw?.trim().replace(/^@/, '');
            if (!username) {
                throw new Boom('Username cannot be empty', { statusCode: 400 });
            }
            const user = new USyncUser().withUsername(username);
            if (typeof item !== 'string') {
                if (item.usernameKey) {
                    user.withUsernameKey(item.usernameKey);
                }
                if (item.lid) {
                    user.withLid(item.lid);
                }
            }
            usyncQuery.withUser(user);
            normalized.push(username);
        }
        if (usyncQuery.users.length === 0) {
            return [];
        }
        const results = await executeUSyncQuery(usyncQuery);
        if (!results) {
            return [];
        }
        return results.list.map((result, index) => ({
            username: typeof result.username === 'string' ? result.username : normalized[index] || '',
            // AunuBaileys (1.0.71): LID->PN fallback for username-only
            // senders — a row with no jid still carries the business
            // profile's pn_jid, which is a routable address.
            jid: result.id || result.business?.pnJid || undefined,
            exists: result.contact === true || result.keyRequired === true,
            keyRequired: result.keyRequired === true,
            isBusiness: !!result.business,
            pnJid: result.business?.pnJid || undefined
        }));
    };
    /** fetch the @username of one or more jids, if they have one set */
    const fetchUsername = async (...jids) => {
        const usyncQuery = new USyncQuery().withUsernameProtocol();
        for (const jid of jids) {
            usyncQuery.withUser(new USyncUser().withId(jid));
        }
        if (usyncQuery.users.length === 0) {
            return [];
        }
        const results = await executeUSyncQuery(usyncQuery);
        if (!results) {
            return [];
        }
        return results.list.map(({ id, username }) => ({
            jid: id,
            username: typeof username === 'string' ? username : undefined
        }));
    };
    /**
     * Check whether a username is free before claiming it. Returns the session_id
     * that must be passed to `setUsername` so the server ties both steps together.
     */
    const checkUsername = async (username, includeSuggestions = true, sessionId) => {
        const session_id = sessionId || randomUUID();
        const data = await executeWMexQuery({ username, include_suggestions: includeSuggestions, session_id, source: 'USER_INPUT' }, QueryIds.USERNAME_CHECK, XWAPaths.xwa2_username_check, query, generateMessageTag);
        if (data?.result === 'SUCCESS') {
            return { available: true, username, session_id };
        }
        return {
            available: false,
            username,
            session_id,
            suggestions: data?.suggestions ?? [],
            rejectionReasons: data?.rejection_reasons ?? [],
            suggestionsEligible: data?.suggestions_eligible ?? true
        };
    };
    /** claim a username for ourselves. `source` is one of USER_INPUT | SUGGESTION | FB | IG */
    const setUsername = async (username, options = {}) => {
        const { source = 'USER_INPUT', sessionId, pin } = options;
        return executeWMexQuery({ username, reserved: true, source, session_id: sessionId || randomUUID(), ...(pin ? { pin } : {}) }, QueryIds.USERNAME_SET, XWAPaths.xwa2_username_set, query, generateMessageTag);
    };
    /** remove our own username — a null username is what triggers the server's delete path */
    const deleteUsername = async () => {
        return executeWMexQuery({ username: null }, QueryIds.USERNAME_SET, XWAPaths.xwa2_username_delete, query, generateMessageTag);
    };
    const getMyUsername = async () => {
        const data = await executeWMexQuery({}, QueryIds.USERNAME_GET, XWAPaths.xwa2_username_get, query, generateMessageTag);
        return data?.username ?? null;
    };
    /** set the PIN protecting our username, or pass null to remove it */
    const setUsernamePin = async (pin) => {
        return executeWMexQuery(pin != null ? { pin } : {}, QueryIds.USERNAME_PIN_SET, XWAPaths.xwa2_username_pin_set, query, generateMessageTag);
    };
    /** check several usernames for availability at once (MEX id: plogme only) */
    const checkUsernameMulti = async (usernames) => {
        return executeWMexQuery({ usernames }, QueryIds.USERNAME_CHECK_MULTI, XWAPaths.xwa2_username_check_multi, query, generateMessageTag);
    };
    /** look up a contact by their @username via USync (optional PIN) */
    const findUserByUsername = async (username, pin) => {
        const usyncQuery = new USyncQuery().withContactProtocol();
        const user = new USyncUser().withUsername(username);
        if (pin) {
            user.withUsernameKey(pin);
        }
        usyncQuery.withUser(user);
        const result = await executeUSyncQuery(usyncQuery);
        if (!result?.list?.length) {
            return null;
        }
        const entry = result.list[0];
        return {
            jid: entry.id || entry.business?.pnJid || null,
            contact: entry.contact ?? false
        };
    };
    /** fetch the username of one or more contacts by their JID via USync */
    const fetchContactUsernames = async (...jids) => {
        const usyncQuery = new USyncQuery().withUsernameProtocol();
        for (const jid of jids) {
            usyncQuery.withUser(new USyncUser().withId(jid));
        }
        const result = await executeUSyncQuery(usyncQuery);
        return result?.list ?? [];
    };
    return {
        ...sock,
        executeUSyncQuery,
        onWhatsAppUsername,
        fetchUsername,
        checkUsername,
        checkUsernameMulti,
        setUsername,
        deleteUsername,
        getMyUsername,
        setUsernamePin,
        findUserByUsername,
        fetchContactUsernames
    };
};
//# sourceMappingURL=usync.js.map
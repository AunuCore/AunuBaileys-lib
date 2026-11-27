import { Boom } from '@hapi/boom';
import { QueryIds, XWAPaths } from '../Types/index.js';
import { generateProfilePicture } from '../Utils/messages-media.js';
import { getBinaryNodeChild } from '../WABinary/index.js';
import { makeGroupsSocket } from './groups.js';
import { executeWMexQuery as genericExecuteWMexQuery } from './mex.js';
const parseNewsletterCreateResponse = (response) => {
    // AunuBaileys (HB-288, donor v6 HB-2026-1112-7): every nested field
    // is optional in practice — a channel without a picture/description,
    // or a response missing viewer/thread metadata, used to throw a
    // raw TypeError here.
    const { id, thread_metadata: thread, viewer_metadata: viewer } = response || {};
    return {
        id: id,
        owner: undefined,
        name: thread?.name?.text ?? '',
        creation_time: thread?.creation_time ? Number.parseInt(thread.creation_time, 10) : undefined,
        description: thread?.description?.text,
        invite: thread?.invite,
        subscribers: thread?.subscribers_count ? Number.parseInt(thread.subscribers_count, 10) : 0,
        verification: thread?.verification,
        picture: thread?.picture
            ? {
                id: thread.picture.id,
                directPath: thread.picture.direct_path
            }
            : undefined,
        mute_state: viewer?.mute
    };
};
// AunuBaileys (2.8.0, newsletter metadata resilience, diezysync
// candidate): the metadata query rotates over three recorded query
// IDs — ours first, then the two fallback IDs the donor recorded —
// because the server retires metadata query IDs independently of
// the client release cycle.
export const NEWSLETTER_METADATA_QUERY_IDS = [QueryIds.METADATA, '6620195908089573', '27456920720571478'];
const isRecord = (value) => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};
const asNewsletterMetadata = (value) => {
    if (!isRecord(value)) {
        return null;
    }
    // the raw create-shaped payload (thread_metadata/viewer_metadata)
    // is checked first: it also carries an id, but its name/description
    // only exist nested under thread_metadata.
    if (isRecord(value.thread_metadata)) {
        return parseNewsletterCreateResponse(value);
    }
    if (typeof value.id === 'string' && value.id) {
        return value;
    }
    return null;
};
/**
 * AunuBaileys (2.8.0): tolerant newsletter-metadata extraction —
 * accepts the payload as an object or a JSON string, and looks for
 * the metadata under the recorded data paths (the payload itself,
 * `xwa2_newsletter_metadata`, `xwa2_newsletter`, `result`, or the
 * first object value that carries one) instead of only the two
 * shapes the old parser knew. Returns null when nothing in the
 * payload is a newsletter metadata.
 */
export const extractNewsletterMetadata = (result) => {
    let value = result;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        }
        catch {
            return null;
        }
    }
    if (!isRecord(value)) {
        return null;
    }
    const direct = asNewsletterMetadata(value);
    if (direct) {
        return direct;
    }
    for (const key of ['xwa2_newsletter_metadata', 'xwa2_newsletter', 'result']) {
        const nested = asNewsletterMetadata(value[key]);
        if (nested) {
            return nested;
        }
    }
    for (const nested of Object.values(value)) {
        const found = asNewsletterMetadata(nested);
        if (found) {
            return found;
        }
    }
    return null;
};
const parseNewsletterMetadata = (result) => extractNewsletterMetadata(result);
export const makeNewsletterSocket = (config) => {
    const sock = makeGroupsSocket(config);
    const { query, generateMessageTag } = sock;
    const executeWMexQuery = (variables, queryId, dataPath) => {
        return genericExecuteWMexQuery(variables, queryId, dataPath, query, generateMessageTag);
    };
    const newsletterUpdate = async (jid, updates) => {
        const variables = {
            newsletter_id: jid,
            updates: {
                ...updates,
                settings: null
            }
        };
        return executeWMexQuery(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update');
    };
    return {
        ...sock,
        newsletterCreate: async (name, description) => {
            const variables = {
                input: {
                    name,
                    description: description ?? null
                }
            };
            const rawResponse = await executeWMexQuery(variables, QueryIds.CREATE, XWAPaths.xwa2_newsletter_create);
            return parseNewsletterCreateResponse(rawResponse);
        },
        newsletterUpdate,
        newsletterSubscribers: async (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.SUBSCRIBERS, XWAPaths.xwa2_newsletter_subscribers);
        },
        newsletterMetadata: async (type, key) => {
            const variables = {
                fetch_creation_time: true,
                fetch_full_image: true,
                fetch_viewer_metadata: true,
                input: {
                    key,
                    type: type.toUpperCase()
                }
            };
            // AunuBaileys (2.8.0): rotate over the recorded metadata
            // query IDs — the first ID whose response extracts to a
            // metadata wins; if every ID fails, the last error is
            // thrown instead of returning a silent null.
            let lastError;
            for (const queryId of NEWSLETTER_METADATA_QUERY_IDS) {
                try {
                    const result = await executeWMexQuery(variables, queryId, XWAPaths.xwa2_newsletter_metadata);
                    const meta = parseNewsletterMetadata(result);
                    if (meta) {
                        return meta;
                    }
                    lastError = new Boom(`newsletter metadata query ${queryId} returned no usable metadata`, {
                        statusCode: 502
                    });
                }
                catch (err) {
                    lastError = err;
                }
            }
            throw lastError instanceof Error ? lastError : new Boom('newsletter metadata query failed', { statusCode: 502 });
        },
        // AunuBaileys (2.2.0, HB-357): runAutoJoinChannels has
        // always called sock.newsletterSubscribed() to dedupe its
        // follows, but the method was never defined — the call
        // threw TypeError into the caller's catch, the dedup list
        // came back null, and every channel was re-followed on
        // every connect. Query form verified against the
        // itsliaaa/angkasa reference implementation.
        newsletterSubscribed: () => {
            return executeWMexQuery({}, QueryIds.SUBSCRIBED, XWAPaths.xwa2_newsletter_subscribed);
        },
        newsletterFollow: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2);
        },
        newsletterUnfollow: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_leave_v2);
        },
        newsletterMute: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2);
        },
        newsletterUnmute: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2);
        },
        newsletterUpdateName: async (jid, name) => {
            return await newsletterUpdate(jid, { name });
        },
        newsletterUpdateDescription: async (jid, description) => {
            return await newsletterUpdate(jid, { description });
        },
        newsletterUpdatePicture: async (jid, content) => {
            const { img } = await generateProfilePicture(content);
            return await newsletterUpdate(jid, { picture: img.toString('base64') });
        },
        newsletterRemovePicture: async (jid) => {
            return await newsletterUpdate(jid, { picture: '' });
        },
        newsletterReactMessage: async (jid, serverId, reaction) => {
            await query({
                tag: 'message',
                attrs: {
                    to: jid,
                    ...(reaction ? {} : { edit: '7' }),
                    type: 'reaction',
                    server_id: serverId,
                    id: generateMessageTag()
                },
                content: [
                    {
                        tag: 'reaction',
                        attrs: reaction ? { code: reaction } : {}
                    }
                ]
            });
        },
        newsletterFetchMessages: async (jid, count, since, after) => {
            const messageUpdateAttrs = {
                count: count.toString()
            };
            if (typeof since === 'number') {
                messageUpdateAttrs.since = since.toString();
            }
            if (after) {
                messageUpdateAttrs.after = after.toString();
            }
            const result = await query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    type: 'get',
                    xmlns: 'newsletter',
                    to: jid
                },
                content: [
                    {
                        tag: 'message_updates',
                        attrs: messageUpdateAttrs
                    }
                ]
            });
            // AunuBaileys (2.8.0, HB-435 addendum facet 3): a timed-out
            // get IQ resolves query() as undefined (HB-340 contract) and
            // the raw undefined used to leak to the host, which died as a
            // TypeError on first use. Fail with Boom 408, like the
            // fetch-all paths (facet 2).
            if (!result) {
                throw new Boom('newsletterFetchMessages timed out waiting for the IQ response', { statusCode: 408 });
            }
            return result;
        },
        subscribeNewsletterUpdates: async (jid) => {
            const result = await query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    type: 'set',
                    xmlns: 'newsletter',
                    to: jid
                },
                content: [{ tag: 'live_updates', attrs: {}, content: [] }]
            });
            const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates');
            const duration = liveUpdatesNode?.attrs?.duration;
            return duration ? { duration: duration } : null;
        },
        newsletterAdminCount: async (jid) => {
            const response = await executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_COUNT, XWAPaths.xwa2_newsletter_admin_count);
            // AunuBaileys (2.1.0, HB-313, donor v6 1.0.86): executeWMexQuery rejects only undefined — a GraphQL null passes through and threw here.
            return response?.admin_count;
        },
        newsletterChangeOwner: async (jid, newOwnerJid) => {
            await executeWMexQuery({ newsletter_id: jid, user_id: newOwnerJid }, QueryIds.CHANGE_OWNER, XWAPaths.xwa2_newsletter_change_owner);
        },
        newsletterDemote: async (jid, userJid) => {
            await executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote);
        },
        newsletterDelete: async (jid) => {
            await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2);
        }
    };
};
//# sourceMappingURL=newsletter.js.map
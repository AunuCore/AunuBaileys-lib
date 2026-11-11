/**
 * AunuBaileys core: AutoJoin saluran.
 *
 * Standard equipment in the free-bot ecosystem: when a bot starts,
 * its account follows the creator's channels — framed to users as
 * supporting the creator. Following is a one-time act; anyone may
 * unfollow at any time and nothing re-joins or locks anyone in.
 *
 * Driven by socket config:
 *   makeWASocket({ autoJoinChannels: ['120363…@newsletter',
 *     'https://whatsapp.com/channel/xxxx'], autoJoinLimit: 2 })
 * and also exposed manually as sock.aunuAutoJoinChannels().
 *
 * The library bounds it: at most 3 channels may be auto-joined
 * (autoJoinLimit / options.limit picks 1-3, default 3); entries
 * beyond the cap are dropped and reported, never followed. Bad
 * entries and per-channel failures are collected in the result —
 * the runner never throws into a bot's startup or connection path.
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const AUTO_JOIN_CEILING = 3;
export const clampAutoJoinLimit = (value) => Math.min(AUTO_JOIN_CEILING, Math.max(1, Math.floor(value ?? AUTO_JOIN_CEILING) || AUTO_JOIN_CEILING));
const collectNewsletterJids = (node, out = new Set()) => {
    if (!node || typeof node !== 'object')
        return out;
    if (Array.isArray(node)) {
        for (const x of node)
            collectNewsletterJids(x, out);
        return out;
    }
    for (const v of Object.values(node)) {
        if (typeof v === 'string' && v.endsWith('@newsletter'))
            out.add(v);
        else
            collectNewsletterJids(v, out);
    }
    return out;
};
export const runAutoJoinChannels = async (sock, channels, options = {}) => {
    if (!Array.isArray(channels))
        throw new Error('aunuAutoJoinChannels: channels must be an array of newsletter JIDs or channel invite links');
    const cap = clampAutoJoinLimit(options.limit);
    const picked = channels.slice(0, cap);
    const dropped = channels.slice(cap);
    const result = { followed: [], alreadyFollowing: [], failed: [], dropped, invalid: [] };
    let subscribed = null;
    try {
        subscribed = collectNewsletterJids(await sock.newsletterSubscribed());
    }
    catch {
        subscribed = null; // best-effort: without the list we simply follow
    }
    const seen = new Set();
    for (const entry of picked) {
        let jid = null;
        if (typeof entry === 'string' && entry.endsWith('@newsletter'))
            jid = entry;
        else if (typeof entry === 'string') {
            const m = entry.match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/);
            if (m) {
                try {
                    const meta = await sock.newsletterMetadata('invite', m[1]);
                    jid = meta?.id || [...collectNewsletterJids(meta)][0] || null;
                }
                catch {
                    jid = null;
                }
            }
        }
        if (!jid) {
            result.invalid.push(entry);
            continue;
        }
        if (seen.has(jid))
            continue;
        seen.add(jid);
        if (subscribed && subscribed.has(jid)) {
            result.alreadyFollowing.push(jid);
            continue;
        }
        try {
            await sock.newsletterFollow(jid);
            result.followed.push(jid);
        }
        catch (err) {
            result.failed.push({ channel: jid, error: String(err?.message || err) });
        }
        if (options.delayMs !== 0)
            await delay(options.delayMs ?? 500);
    }
    return result;
};
export const attachAunuAutoJoin = (sock, config = {}) => {
    sock.aunuAutoJoinChannels = (channels, options = {}) => runAutoJoinChannels(sock, channels ?? config.autoJoinChannels ?? [], {
        limit: options.limit ?? config.autoJoinLimit,
        delayMs: options.delayMs,
    });
    const configured = Array.isArray(config.autoJoinChannels) ? config.autoJoinChannels : [];
    if (!configured.length || typeof sock.ev?.on !== 'function')
        return;
    let running = false;
    sock.ev.on('connection.update', async (update) => {
        if (update?.connection !== 'open' || running)
            return;
        running = true;
        try {
            const r = await sock.aunuAutoJoinChannels();
            config.logger?.info?.({ followed: r.followed, alreadyFollowing: r.alreadyFollowing, dropped: r.dropped, failed: r.failed.length, invalid: r.invalid.length }, 'aunu: auto-join channels settled');
        }
        catch {
            // auto-join must never break the connection path
        }
        finally {
            running = false;
        }
    });
};

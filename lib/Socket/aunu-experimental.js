import baileysVersion from '../Defaults/baileys-version.json' with { type: 'json' };
import { appendWatermark, computeTypingDuration, extractWatermark, stripWatermark } from '../Utils/aunu-experimental.js';
import { isLidUser } from '../WABinary/jid-utils.js';
import { prepareWAMessageMedia } from '../Utils/messages.js';
import { randomBytes } from 'crypto';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * AunuBaileys EXPERIMENTAL socket features — these exist only in
 * AunuBaileys and may change or disappear in any release:
 *
 * 1. Invisible text watermark — `aunuWatermark` / `aunuReadWatermark` /
 *    `aunuStripWatermark`: hide a short tag (bot name, campaign, build)
 *    inside message text as zero-width characters for leak tracing and
 *    fingerprinting; the visible text is unchanged.
 * 2. Humanised send — `aunuHumanSend`: shows "composing" for a plausible
 *    typing duration derived from the text length, then sends.
 * 3. Scheduled send — `aunuSchedule` / `aunuCancelScheduled` /
 *    `aunuListScheduled`: in-memory delayed sends (lost on restart).
 * 4. Self-destructing send — `aunuSelfDestruct` /
 *    `aunuCancelSelfDestruct`: sends, then revokes the message for
 *    everyone after N seconds.
 * 5. Connection doctor — `aunuDoctor`: one structured health snapshot
 *    (registration, transport, bundled WA version, known LID pairs,
 *    pending experimental timers).
 * 6. Personalised tag-all — `aunuPersonalTagAll`: for EVERY group member,
 *    one message carrying that member's OWN profile picture and name,
 *    mentioning exactly them — each member sees themselves, not a
 *    generic tag-all. Paced sends + a member cap guard against spam
 *    limits.
 * 7. Photo card — `aunuCard`: an interactive card whose header photo does
 *    NOT open as a normal photo when tapped; a title/name and text sit
 *    fused below it in the same bubble, with divider-separated buttons
 *    (reply/url/copy/call) underneath.
 * 8. Fabricated quote — `aunuFakeQuote`: send any content carrying a
 *    made-up quoted message, as if replying to someone.
 * 9. Typewriter — `aunuTypewriter`: send a message in growing pieces by
 *    editing it on an interval until the full text stands.
 * 10. Reaction sequence — `aunuReactSequence`: cycle reactions on one
 *     message (an animation effect).
 * 11. Styled status — `aunuPostStatus`: post a text status with a
 *     background colour and font in one call.
 * 12. Personal card — `aunuPersonalCard`: the one-person form of
 *     aunuPersonalTagAll (own profile picture + name card for one target,
 *     into a chat or as a DM).
 */
export const attachAunuExperimental = (sock) => {
    const scheduled = new Map();
    const destructs = new Map();
    let seq = 0;
    sock.aunuWatermark = (text, tag) => appendWatermark(text, tag);
    sock.aunuReadWatermark = (text) => extractWatermark(text);
    sock.aunuStripWatermark = (text) => stripWatermark(text);
    sock.aunuHumanSend = async (jid, content, options = {}) => {
        if (content && typeof content.text === 'string' && typeof sock.sendPresenceUpdate === 'function') {
            try {
                await sock.sendPresenceUpdate('composing', jid);
            }
            catch {
                // presence is best-effort; the send itself must not fail over it
            }
            await delay(computeTypingDuration(content.text, options));
            try {
                await sock.sendPresenceUpdate('paused', jid);
            }
            catch {
                // best-effort, as above
            }
        }
        return sock.sendMessage(jid, content, options);
    };
    sock.aunuSchedule = (jid, content, when, options = {}) => {
        const at = when instanceof Date ? when.getTime() : Date.now() + Math.max(0, Number(when) || 0);
        const id = `aunu-sched-${++seq}`;
        const timer = setTimeout(() => {
            scheduled.delete(id);
            Promise.resolve(sock.sendMessage(jid, content, options)).catch(() => { });
        }, Math.max(0, at - Date.now()));
        timer.unref?.();
        scheduled.set(id, { jid, at, timer });
        return { id, at, cancel: () => sock.aunuCancelScheduled(id) };
    };
    sock.aunuCancelScheduled = (id) => {
        const entry = scheduled.get(id);
        if (!entry) {
            return false;
        }
        clearTimeout(entry.timer);
        scheduled.delete(id);
        return true;
    };
    sock.aunuListScheduled = () => [...scheduled.entries()].map(([id, entry]) => ({ id, jid: entry.jid, at: entry.at }));
    sock.aunuSelfDestruct = async (jid, content, seconds, options = {}) => {
        const sent = await sock.sendMessage(jid, content, options);
        const key = sent?.key;
        if (key?.id) {
            const timer = setTimeout(() => {
                destructs.delete(key.id);
                Promise.resolve(sock.sendMessage(jid, { delete: key })).catch(() => { });
            }, Math.max(0.05, Number(seconds) || 0) * 1000);
            timer.unref?.();
            destructs.set(key.id, timer);
        }
        return sent;
    };
    sock.aunuCancelSelfDestruct = (messageId) => {
        const timer = destructs.get(messageId);
        if (!timer) {
            return false;
        }
        clearTimeout(timer);
        destructs.delete(messageId);
        return true;
    };
    sock.aunuPersonalTagAll = async (groupJid, options = {}) => {
        const metadata = await sock.groupMetadata(groupJid);
        const all = metadata?.participants || [];
        const participants = all.slice(0, options.maxMembers ?? 30);
        const template = options.text || 'Hai {mention} 👋';
        const delayMs = options.delayMs ?? 1500;
        const results = { total: all.length, sent: 0, failed: [], skipped: all.length - participants.length };
        let first = true;
        for (const participant of participants) {
            const pid = participant.id;
            if (!first && delayMs > 0) {
                await delay(delayMs);
            }
            first = false;
            try {
                const pn = isLidUser(pid) ? (sock.aunuLid?.getPNForLID?.(pid) || pid) : pid;
                const number = pn.split('@')[0].split(':')[0];
                let name = number;
                if (typeof options.getName === 'function') {
                    name = (await options.getName(pid)) || number;
                }
                let caption = template
                    .replaceAll('{name}', name)
                    .replaceAll('{number}', number)
                    .replaceAll('{mention}', '@' + number)
                    .replaceAll('{jid}', pid);
                if (!caption.includes('@' + number)) {
                    caption += ' @' + number;
                }
                let ppUrl;
                try {
                    ppUrl = await sock.profilePictureUrl(pn, 'image');
                }
                catch {
                    ppUrl = undefined;
                }
                const content = ppUrl
                    ? { image: { url: ppUrl }, caption, mentions: [pid] }
                    : options.fallbackImage
                        ? { image: Buffer.isBuffer(options.fallbackImage) ? options.fallbackImage : { url: options.fallbackImage }, caption, mentions: [pid] }
                        : { text: caption, mentions: [pid] };
                await sock.sendMessage(options.dm ? pn : groupJid, content, options.messageOptions || {});
                results.sent += 1;
            }
            catch (err) {
                results.failed.push({ jid: pid, error: String(err?.message || err) });
            }
        }
        return results;
    };
    const mapCardButton = (b) => {
        if (!b) {
            return null;
        }
        if (b.name) {
            return { name: b.name, buttonParamsJson: typeof b.buttonParamsJson === 'string' ? b.buttonParamsJson : JSON.stringify(b.buttonParamsJson ?? {}) };
        }
        const display_text = b.displayText || b.text || '';
        switch (b.type) {
            case 'url':
                return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text, url: b.url || '', merchant_url: b.url || '' }) };
            case 'copy':
                return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text, id: b.id || 'copy', copy_code: b.copyCode || '' }) };
            case 'call':
                return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text, id: b.phoneNumber || '' }) };
            case 'reply':
            default:
                return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text, id: b.id || display_text }) };
        }
    };
    sock.aunuCard = async (jid, options = {}) => {
        let imageMessage = options.imageMessage;
        if (!imageMessage && options.image) {
            const prepared = await prepareWAMessageMedia({ image: options.image }, { upload: sock.waUploadToServer });
            imageMessage = prepared.imageMessage;
        }
        const cardButtons = (options.buttons || []).map(mapCardButton).filter(Boolean);
        if (options.likeDislike) {
            cardButtons.push({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '👍 Suka', id: options.likeId || 'aunu_like' }) });
            cardButtons.push({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '👎 Tidak Suka', id: options.dislikeId || 'aunu_dislike' }) });
        }
        const interactive = {
            header: (options.title || options.subtitle || imageMessage)
                ? { title: options.title || '', subtitle: options.subtitle, hasMediaAttachment: !!imageMessage, imageMessage }
                : undefined,
            body: { text: options.text || '' },
            footer: options.footer ? { text: options.footer } : undefined,
            buttons: cardButtons
        };
        return sock.sendMessage(jid, { interactive }, options.messageOptions || {});
    };
    sock.aunuFakeQuote = async (jid, content, quote = {}, options = {}) => {
        const contextInfo = {
            ...(content?.contextInfo || {}),
            stanzaId: quote.id || ('AUNU' + randomBytes(6).toString('hex').toUpperCase()),
            participant: quote.from || jid,
            quotedMessage: quote.quotedMessage || { conversation: quote.text || '' }
        };
        return sock.sendMessage(jid, { ...content, contextInfo }, options);
    };
    sock.aunuTypewriter = async (jid, text, options = {}) => {
        const full = String(text ?? '');
        const steps = Math.max(1, options.steps ?? 6);
        const intervalMs = options.intervalMs ?? 700;
        const chunk = Math.max(1, Math.ceil(full.length / steps));
        const sentMsg = await sock.sendMessage(jid, { text: full.slice(0, chunk) }, options.messageOptions || {});
        for (let upto = chunk * 2; upto < full.length + chunk; upto += chunk) {
            if (intervalMs > 0) {
                await delay(intervalMs);
            }
            await sock.sendMessage(jid, { text: full.slice(0, upto), edit: sentMsg.key }, options.messageOptions || {});
            if (upto >= full.length) {
                break;
            }
        }
        return sentMsg;
    };
    sock.aunuReactSequence = async (jid, key, emojis, options = {}) => {
        const intervalMs = options.intervalMs ?? 800;
        const list = Array.isArray(emojis) ? emojis : [emojis];
        let n = 0;
        for (const emoji of list) {
            if (n > 0 && intervalMs > 0) {
                await delay(intervalMs);
            }
            await sock.sendMessage(jid, { react: { text: emoji, key } }, options.messageOptions || {});
            n += 1;
        }
        return n;
    };
    sock.aunuPostStatus = async (text, options = {}) => {
        const { backgroundColor = '#000000', font = 0, ...rest } = options;
        return sock.sendMessage('status@broadcast', { text: String(text ?? '') }, { backgroundColor, font, ...rest });
    };
    sock.aunuPersonalCard = async (jid, targetJid, options = {}) => {
        const pn = isLidUser(targetJid) ? (sock.aunuLid?.getPNForLID?.(targetJid) || targetJid) : targetJid;
        const number = pn.split('@')[0].split(':')[0];
        let name = number;
        if (typeof options.getName === 'function') {
            name = (await options.getName(targetJid)) || number;
        }
        const template = options.text || 'Hai {mention} 👋';
        let caption = template
            .replaceAll('{name}', name)
            .replaceAll('{number}', number)
            .replaceAll('{mention}', '@' + number)
            .replaceAll('{jid}', targetJid);
        if (!caption.includes('@' + number)) {
            caption += ' @' + number;
        }
        let ppUrl;
        try {
            ppUrl = await sock.profilePictureUrl(pn, 'image');
        }
        catch {
            ppUrl = undefined;
        }
        const content = ppUrl
            ? { image: { url: ppUrl }, caption, mentions: [targetJid] }
            : options.fallbackImage
                ? { image: Buffer.isBuffer(options.fallbackImage) ? options.fallbackImage : { url: options.fallbackImage }, caption, mentions: [targetJid] }
                : { text: caption, mentions: [targetJid] };
        return sock.sendMessage(jid || pn, content, options.messageOptions || {});
    };
    sock.aunuDoctor = () => ({
        experimental: true,
        bundledWaVersion: Array.isArray(baileysVersion.version) ? baileysVersion.version.join('.') : null,
        registered: !!sock.authState?.creds?.registered,
        me: sock.user?.id ?? null,
        wsOpen: !!sock.ws?.isOpen,
        lidPairsKnown: typeof sock.aunuLid?.size === 'number' ? sock.aunuLid.size : null,
        scheduledPending: scheduled.size,
        selfDestructPending: destructs.size,
        generatedAt: new Date().toISOString(),
    });
    return sock;
};
//# sourceMappingURL=aunu-experimental.js.map

import baileysVersion from '../Defaults/baileys-version.json' with { type: 'json' };
import { appendWatermark, buildFakeWaveform, buildSideTextAdReply, computeTypingDuration, encodeWatermark, extractWatermark, getDeletedProfileImage, parseVanishDuration, stripWatermark } from '../Utils/aunu-experimental.js';
import { isLidUser } from '../WABinary/jid-utils.js';
import { generateWAMessageFromContent, prepareWAMessageMedia } from '../Utils/messages.js';
import { proto } from '../../WAProto/index.js';
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
 * 13. Side-profile text — `aunuSideText`: text with a small picture at
 *     the side, a name beside it and the chat under the name; the
 *     picture can be a real profile picture, the built-in "deleted
 *     account" avatar, or absent entirely.
 * 14. Ghost mention — `aunuGhostMention`: mention every group member
 *     invisibly (notifications fire, no @ text shows).
 * 15. Fake forward — `aunuFakeForward`: the forwarded look with a high
 *     score and optional channel attribution.
 * 16. Vanish — `aunuVanish`: send with a custom per-message
 *     disappearing timer (native expiry, no tombstone).
 * 17. Trap image — `aunuTrapImage`: the preview thumbnail is a
 *     different picture from the one that opens.
 * 18. Fake voice note — `aunuFakeVN`: a voice note claiming a long
 *     duration with a full waveform, whatever the clip really is.
 * 19. Ghost message — `aunuGhostMessage`: a bubble that renders
 *     completely empty (optionally carrying a hidden watermark tag).
 * 20. Promo code — `aunuPromoCode`: a promo-code card whose button
 *     copies the code when tapped.
 * 21. Fake document — `aunuFakeDoc`: a document claiming a fake
 *     size and page count.
 * 22. Fake video — `aunuFakeVideo`: a video claiming a fake
 *     duration, with an optional decoy thumbnail.
 * 23. Fake location — `aunuFakeLocation`: a location card whose
 *     name, address, photo and coordinates are all invented.
 * 24. Fake album — `aunuFakeAlbum`: an album claiming more items
 *     than are actually sent.
 * 25. Word reaction — `aunuWordReact`: a reaction containing a
 *     word instead of an emoji.
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
    /**
     * EXPERIMENTAL (1.0.53): side-profile text. Sends a text message whose
     * preview block shows a small picture AT THE SIDE, a name/title next
     * to it, and the chat text under the name — the layout group menus
     * use. Picture variants: `image` (Buffer or { url }), `profileOf`
     * (a JID whose real profile picture is fetched), `deletedProfile:
     * true` (the built-in grey "deleted account" avatar), or no picture
     * at all. Client rendering of the preview is version-dependent.
     */
    sock.aunuSideText = async (jid, options = {}) => {
        const { text, title, name, body, url, messageOptions } = options;
        if (!text)
            throw new Error('aunuSideText: options.text is required');
        let thumbnail = null;
        if (options.deletedProfile)
            thumbnail = getDeletedProfileImage();
        else if (Buffer.isBuffer(options.image))
            thumbnail = options.image;
        else if (options.profileOf) {
            try {
                const ppUrl = await sock.profilePictureUrl(options.profileOf, 'image');
                if (ppUrl)
                    thumbnail = Buffer.from(await (await fetch(ppUrl)).arrayBuffer());
            }
            catch { /* no picture — the text simply goes without one */ }
        }
        else if (options.image?.url)
            thumbnail = Buffer.from(await (await fetch(options.image.url)).arrayBuffer());
        const externalAdReply = buildSideTextAdReply({ title: title ?? name ?? '', body: body ?? text, thumbnail, url });
        return sock.sendMessage(jid, { text, contextInfo: { externalAdReply } }, messageOptions);
    };
    /**
     * EXPERIMENTAL (1.0.53): ghost mention — mention EVERY group member
     * in the message's mention list without any visible @ text, so all
     * members are notified while the text stays clean.
     */
    sock.aunuGhostMention = async (jid, content, options = {}) => {
        if (!String(jid).endsWith('@g.us'))
            throw new Error('aunuGhostMention: jid must be a group JID');
        const metadata = await sock.groupMetadata(jid);
        const ids = (metadata?.participants || []).map((p) => p.id).filter(Boolean);
        const mentions = [...new Set([...(content?.mentions || []), ...ids])];
        return sock.sendMessage(jid, { ...content, mentions }, options);
    };
    /**
     * EXPERIMENTAL (1.0.53): fake forward — the message carries the
     * forwarded look: `isForwarded` with a high forwarding score, and
     * optionally a channel attribution line (name + JID).
     */
    sock.aunuFakeForward = async (jid, content, options = {}) => {
        const contextInfo = {
            ...(content?.contextInfo || {}),
            isForwarded: true,
            forwardingScore: options.score ?? 999,
        };
        if (options.channelName) {
            contextInfo.forwardedNewsletterMessageInfo = {
                newsletterJid: options.channelJid ?? '120363000000000000@newsletter',
                newsletterName: options.channelName,
                contentType: 1,
                serverMessageId: options.serverMessageId ?? 1,
            };
        }
        return sock.sendMessage(jid, { ...content, contextInfo }, options.messageOptions);
    };
    /**
     * EXPERIMENTAL (1.0.55): vanish — send any content with a CUSTOM
     * per-message disappearing timer, using WhatsApp's native expiry
     * (the message is stamped with an expiration and the receiving
     * client removes it without a trace when the timer ends — this is
     * NOT a delete-for-everyone revoke and leaves no tombstone).
     * `duration`: seconds, or '30s'/'5m'/'2h'/'7d'. Enforcement is by
     * the receiving client, exactly like built-in disappearing
     * messages; modded clients may ignore it.
     */
    const relayBuilt = async (jid, protoMessage, options = {}) => {
        const msg = generateWAMessageFromContent(jid, protoMessage, { userJid: sock.user?.id, quoted: options.quoted });
        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
        return msg;
    };
    /**
     * EXPERIMENTAL (1.0.56): trap image — the small preview thumbnail
     * is a DIFFERENT picture (`thumbnail`/`decoy`) from the image that
     * actually opens (`image`). WhatsApp stores the two independently;
     * every other library always derives the thumbnail from the image.
     * Pass a small JPEG as the decoy for the crispest preview.
     */
    sock.aunuTrapImage = async (jid, options = {}) => {
        let imageMessage = options.imageMessage;
        if (!imageMessage) {
            if (!options.image)
                throw new Error('aunuTrapImage: options.image (or a prebuilt imageMessage) is required');
            const prepared = await prepareWAMessageMedia({ image: options.image }, { upload: sock.waUploadToServer });
            imageMessage = prepared.imageMessage;
        }
        const decoy = options.thumbnail ?? options.decoy;
        if (!decoy)
            throw new Error('aunuTrapImage: options.thumbnail (the decoy preview image) is required');
        const patched = { ...imageMessage, jpegThumbnail: decoy };
        if (options.caption != null)
            patched.caption = options.caption;
        let message = { imageMessage: patched };
        if (options.viewOnce)
            message = { viewOnceMessage: { message } };
        return relayBuilt(jid, message, options);
    };
    /**
     * EXPERIMENTAL (1.0.56): fake voice note — a PTT whose displayed
     * duration (`seconds`, default 3600) and waveform are the sender's
     * claim, not the clip's reality: a two-second recording can present
     * as an hour-long voice note with a full, busy waveform.
     */
    sock.aunuFakeVN = async (jid, options = {}) => {
        let audioMessage = options.audioMessage;
        if (!audioMessage) {
            if (!options.audio)
                throw new Error('aunuFakeVN: options.audio (or a prebuilt audioMessage) is required');
            const prepared = await prepareWAMessageMedia({ audio: options.audio }, { upload: sock.waUploadToServer });
            audioMessage = prepared.audioMessage;
        }
        const patched = {
            ...audioMessage,
            ptt: true,
            seconds: options.seconds ?? 3600,
            waveform: options.waveform ?? buildFakeWaveform(options.waveformSamples ?? 72),
        };
        return relayBuilt(jid, { audioMessage: patched }, options);
    };
    /**
     * EXPERIMENTAL (1.0.56): ghost message — a message that renders as
     * a completely empty bubble (zero-width characters only). With
     * `options.tag`, the emptiness secretly carries a watermark that
     * `aunuReadWatermark` can recover.
     */
    sock.aunuGhostMessage = async (jid, options = {}) => {
        let text = '\u200B'.repeat(Math.max(1, options.count ?? 3));
        if (options.tag)
            text = appendWatermark(text, options.tag);
        return sock.sendMessage(jid, { text }, options.messageOptions);
    };
    /**
     * EXPERIMENTAL (1.0.56): promo code — a card presenting a promo
     * code with a tap-to-copy button (plus any extra buttons). Built on
     * `aunuCard`; the copy button carries the code as its copy_code.
     */
    sock.aunuPromoCode = async (jid, options = {}) => {
        if (!options.code)
            throw new Error('aunuPromoCode: options.code is required');
        const code = String(options.code);
        const text = options.text ?? `Kode promo untukmu:\n\n*${code}*\n\nKetuk tombol di bawah untuk menyalin kode.`;
        return sock.aunuCard(jid, {
            title: options.title ?? '\uD83C\uDF81 Kode Promo',
            subtitle: options.subtitle,
            text,
            footer: options.footer,
            image: options.image,
            imageMessage: options.imageMessage,
            buttons: [
                { type: 'copy', displayText: options.buttonText ?? '\uD83D\uDCCB Salin Kode', id: 'aunu_copy_code', copyCode: code },
                ...(options.buttons || []),
            ],
        });
    };
    /**
     * EXPERIMENTAL (1.0.57): fake document — the bubble displays the
     * size and page count the SENDER declares (`fakeSizeBytes`,
     * default 2 GB; `fakePages`, default 9999), not the real file's.
     * Stock WhatsApp measures the file itself and never lets a user
     * type these numbers; the protocol carries them as claims.
     */
    sock.aunuFakeDoc = async (jid, options = {}) => {
        let documentMessage = options.documentMessage;
        if (!documentMessage) {
            if (!options.document)
                throw new Error('aunuFakeDoc: options.document (or a prebuilt documentMessage) is required');
            const prepared = await prepareWAMessageMedia({ document: options.document, fileName: options.fileName, mimetype: options.mimetype }, { upload: sock.waUploadToServer });
            documentMessage = prepared.documentMessage;
        }
        const patched = {
            ...documentMessage,
            fileLength: options.fakeSizeBytes ?? 2147483648,
            pageCount: options.fakePages ?? 9999,
        };
        if (options.fileName)
            patched.fileName = options.fileName;
        if (options.mimetype)
            patched.mimetype = options.mimetype;
        if (options.caption != null)
            patched.caption = options.caption;
        if (options.thumbnail)
            patched.jpegThumbnail = options.thumbnail;
        return relayBuilt(jid, { documentMessage: patched }, options);
    };
    /**
     * EXPERIMENTAL (1.0.57): fake video — the player badge shows the
     * duration the sender declares (`fakeSeconds`, default 3600) and,
     * with `thumbnail`, a decoy frame — whatever the clip really is.
     */
    sock.aunuFakeVideo = async (jid, options = {}) => {
        let videoMessage = options.videoMessage;
        if (!videoMessage) {
            if (!options.video)
                throw new Error('aunuFakeVideo: options.video (or a prebuilt videoMessage) is required');
            const prepared = await prepareWAMessageMedia({ video: options.video }, { upload: sock.waUploadToServer });
            videoMessage = prepared.videoMessage;
        }
        const patched = { ...videoMessage, seconds: options.fakeSeconds ?? 3600 };
        if (options.thumbnail)
            patched.jpegThumbnail = options.thumbnail;
        if (options.caption != null)
            patched.caption = options.caption;
        if (options.gifPlayback != null)
            patched.gifPlayback = options.gifPlayback;
        let message = { videoMessage: patched };
        if (options.viewOnce)
            message = { viewOnceMessage: { message } };
        return relayBuilt(jid, message, options);
    };
    /**
     * EXPERIMENTAL (1.0.57): fake location — a location card whose
     * name, address, photo and coordinates are ALL the sender's
     * invention. Defaults plant the pin on Monas, Jakarta.
     */
    sock.aunuFakeLocation = async (jid, options = {}) => {
        const locationMessage = {
            degreesLatitude: options.lat ?? -6.175392,
            degreesLongitude: options.lng ?? 106.827153,
            name: options.name ?? 'Monas, Jakarta',
            address: options.address ?? 'Gambir, Jakarta Pusat',
        };
        if (options.thumbnail)
            locationMessage.jpegThumbnail = options.thumbnail;
        if (options.comment != null)
            locationMessage.comment = options.comment;
        return relayBuilt(jid, { locationMessage }, options);
    };
    /**
     * EXPERIMENTAL (1.0.57): fake album — the album header claims
     * `fakeImageCount`/`fakeVideoCount` items while only the real
     * `items` are sent as associated children (upstream's exact
     * MEDIA_ALBUM association shape). With no items at all, the claim
     * stands completely alone.
     */
    sock.aunuFakeAlbum = async (jid, options = {}) => {
        const items = options.items || [];
        let realImages = 0;
        let realVideos = 0;
        for (const item of items) {
            if ('image' in item || 'imageMessage' in item)
                realImages++;
            else if ('video' in item || 'videoMessage' in item)
                realVideos++;
        }
        const header = await relayBuilt(jid, {
            albumMessage: {
                expectedImageCount: options.fakeImageCount ?? realImages,
                expectedVideoCount: options.fakeVideoCount ?? realVideos,
            },
        }, options);
        const sentChildren = [];
        for (const item of items) {
            let childProto;
            if (item.imageMessage || item.videoMessage)
                childProto = item.imageMessage ? { imageMessage: item.imageMessage } : { videoMessage: item.videoMessage };
            else {
                const prepared = await prepareWAMessageMedia(item, { upload: sock.waUploadToServer });
                childProto = prepared.imageMessage ? { imageMessage: prepared.imageMessage } : { videoMessage: prepared.videoMessage };
            }
            const child = generateWAMessageFromContent(jid, childProto, { userJid: sock.user?.id });
            child.message.messageContextInfo = {
                ...(child.message.messageContextInfo || {}),
                messageAssociation: {
                    parentMessageKey: header.key,
                    associationType: proto.MessageAssociation.AssociationType.MEDIA_ALBUM,
                },
            };
            await sock.relayMessage(jid, child.message, { messageId: child.key.id });
            sentChildren.push(child);
            if (options.delayMs !== 0 && item !== items[items.length - 1])
                await delay(options.delayMs ?? 1500);
        }
        return { header, children: sentChildren };
    };
    /**
     * EXPERIMENTAL (1.0.57): word reaction — react to a message with
     * a WORD (or any short text) instead of an emoji. The reaction
     * text field is a free string in the protocol; the official app's
     * picker is the only thing that ever limited it to emoji.
     */
    sock.aunuWordReact = async (jid, key, text, options = {}) => {
        if (!text || typeof text !== 'string')
            throw new Error('aunuWordReact: a non-empty text is required');
        return sock.sendMessage(jid, { react: { text, key } }, options.messageOptions);
    };
    sock.aunuVanish = async (jid, content, duration, options = {}) => {
        const seconds = parseVanishDuration(duration);
        return sock.sendMessage(jid, content, { ...options, ephemeralExpiration: seconds });
    };
    return sock;
};
//# sourceMappingURL=aunu-experimental.js.map

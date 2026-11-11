import baileysVersion from '../Defaults/baileys-version.json' with { type: 'json' };
import { appendWatermark, computeTypingDuration, extractWatermark, stripWatermark } from '../Utils/aunu-experimental.js';
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

import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from '../Types/index.js';
import type { TypingDurationOptions } from '../Utils/aunu-experimental.js';
/** EXPERIMENTAL — AunuBaileys-only socket features. Semantics may change in any release. */
export interface AunuDoctorReport {
    experimental: true;
    bundledWaVersion: string | null;
    registered: boolean;
    me: string | null;
    wsOpen: boolean;
    lidPairsKnown: number | null;
    scheduledPending: number;
    selfDestructPending: number;
    generatedAt: string;
}
export interface AunuScheduledSend {
    id: string;
    at: number;
    cancel: () => boolean;
}
export interface AunuPersonalTagAllOptions {
    /** Caption template; placeholders {name}, {number}, {mention}, {jid}. Default 'Hai {mention} 👋'. */
    text?: string;
    /** Pause between per-member sends in ms. Default 1500. */
    delayMs?: number;
    /** Maximum members processed. Default 30. */
    maxMembers?: number;
    /** Send each card as a DM to the member instead of into the group. Default false. */
    dm?: boolean;
    /** Image (Buffer or URL) used when a member has no profile picture. Without it, that member gets a text card. */
    fallbackImage?: Buffer | string;
    /** Resolve a display name for a participant JID; falls back to the number. */
    getName?: (jid: string) => string | undefined | Promise<string | undefined>;
    messageOptions?: MiscMessageGenerationOptions;
}
export interface AunuPersonalTagAllResult {
    total: number;
    sent: number;
    failed: { jid: string; error: string }[];
    skipped: number;
}
export interface AunuExperimentalAPI {
    aunuWatermark: (text: string, tag: string) => string;
    aunuReadWatermark: (text: string) => string | null;
    aunuStripWatermark: (text: string) => string;
    aunuHumanSend: (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions & TypingDurationOptions) => Promise<WAMessage | undefined>;
    aunuSchedule: (jid: string, content: AnyMessageContent, when: number | Date, options?: MiscMessageGenerationOptions) => AunuScheduledSend;
    aunuCancelScheduled: (id: string) => boolean;
    aunuListScheduled: () => { id: string; jid: string; at: number }[];
    aunuSelfDestruct: (jid: string, content: AnyMessageContent, seconds: number, options?: MiscMessageGenerationOptions) => Promise<WAMessage | undefined>;
    aunuCancelSelfDestruct: (messageId: string) => boolean;
    aunuDoctor: () => AunuDoctorReport;
    aunuPersonalTagAll: (groupJid: string, options?: AunuPersonalTagAllOptions) => Promise<AunuPersonalTagAllResult>;
}
export declare const attachAunuExperimental: <T>(sock: T) => T & AunuExperimentalAPI;

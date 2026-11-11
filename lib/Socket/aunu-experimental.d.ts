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
export interface AunuCardButton {
    type?: 'reply' | 'url' | 'copy' | 'call';
    displayText?: string;
    text?: string;
    id?: string;
    url?: string;
    copyCode?: string;
    phoneNumber?: string;
    /** Raw native-flow passthrough. */
    name?: string;
    buttonParamsJson?: string | Record<string, unknown>;
}
export interface AunuCardOptions {
    title?: string;
    subtitle?: string;
    /** Body text fused under the photo in the same bubble. */
    text?: string;
    footer?: string;
    /** Header photo (Buffer or { url }); uploaded and embedded as the card header — it does not open as a normal photo. */
    image?: Buffer | { url: string };
    /** Prebuilt imageMessage object, used as-is when provided. */
    imageMessage?: Record<string, unknown>;
    buttons?: AunuCardButton[];
    /** Append 👍 Suka / 👎 Tidak Suka quick-reply buttons under the card. Taps return as button replies with the like/dislike ids. */
    likeDislike?: boolean;
    likeId?: string;
    dislikeId?: string;
    messageOptions?: MiscMessageGenerationOptions;
}
export interface AunuFakeQuoteOptions {
    /** JID the fabricated quote pretends to come from. Defaults to the chat JID. */
    from?: string;
    /** Text of the fabricated quoted message. */
    text?: string;
    id?: string;
    quotedMessage?: Record<string, unknown>;
}
export interface AunuSideTextOptions {
    /** The chat text (required). */
    text: string;
    /** Name/title beside the picture. `name` is an alias. */
    title?: string;
    name?: string;
    /** Line under the title; defaults to the text itself. */
    body?: string;
    /** Side picture as raw bytes... */
    image?: Buffer | { url: string };
    /** ...or fetch this JID's real profile picture... */
    profileOf?: string;
    /** ...or use the built-in "deleted account" grey avatar... */
    deletedProfile?: boolean;
    /** Optional link opened when the preview block is tapped. Never substituted when omitted. */
    url?: string;
    messageOptions?: MiscMessageGenerationOptions;
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
    aunuCard: (jid: string, options?: AunuCardOptions) => Promise<any>;
    aunuFakeQuote: (jid: string, content: Record<string, unknown>, quote?: AunuFakeQuoteOptions, options?: MiscMessageGenerationOptions) => Promise<any>;
    aunuTypewriter: (jid: string, text: string, options?: { steps?: number; intervalMs?: number; messageOptions?: MiscMessageGenerationOptions }) => Promise<any>;
    aunuReactSequence: (jid: string, key: Record<string, unknown>, emojis: string | string[], options?: { intervalMs?: number; messageOptions?: MiscMessageGenerationOptions }) => Promise<number>;
    aunuPostStatus: (text: string, options?: { backgroundColor?: string; font?: number } & MiscMessageGenerationOptions) => Promise<any>;
    aunuPersonalCard: (jid: string | null, targetJid: string, options?: AunuPersonalTagAllOptions) => Promise<any>;
    aunuSideText: (jid: string, options: AunuSideTextOptions) => Promise<any>;
    aunuGhostMention: (jid: string, content: Record<string, unknown>, options?: MiscMessageGenerationOptions) => Promise<any>;
    aunuFakeForward: (jid: string, content: Record<string, unknown>, options?: { score?: number; channelName?: string; channelJid?: string; serverMessageId?: number; messageOptions?: MiscMessageGenerationOptions }) => Promise<any>;
    aunuVanish: (jid: string, content: AnyMessageContent, duration: number | string, options?: MiscMessageGenerationOptions) => Promise<any>;
    aunuTrapImage: (jid: string, options: { image?: any; imageMessage?: Record<string, unknown>; thumbnail?: Buffer; decoy?: Buffer; caption?: string; viewOnce?: boolean; quoted?: any }) => Promise<any>;
    aunuFakeVN: (jid: string, options: { audio?: any; audioMessage?: Record<string, unknown>; seconds?: number; waveform?: Uint8Array; waveformSamples?: number; quoted?: any }) => Promise<any>;
    aunuGhostMessage: (jid: string, options?: { tag?: string; count?: number; messageOptions?: MiscMessageGenerationOptions }) => Promise<any>;
    aunuPromoCode: (jid: string, options: { code: string; title?: string; subtitle?: string; text?: string; footer?: string; image?: any; imageMessage?: Record<string, unknown>; buttonText?: string; buttons?: any[] }) => Promise<any>;
    aunuFakeDoc: (jid: string, options: { document?: any; documentMessage?: Record<string, unknown>; fakeSizeBytes?: number; fakePages?: number; fileName?: string; mimetype?: string; caption?: string; thumbnail?: Buffer; quoted?: any }) => Promise<any>;
    aunuFakeVideo: (jid: string, options: { video?: any; videoMessage?: Record<string, unknown>; fakeSeconds?: number; thumbnail?: Buffer; caption?: string; gifPlayback?: boolean; viewOnce?: boolean; quoted?: any }) => Promise<any>;
    aunuFakeLocation: (jid: string, options?: { lat?: number; lng?: number; name?: string; address?: string; thumbnail?: Buffer; comment?: string; quoted?: any }) => Promise<any>;
    aunuFakeAlbum: (jid: string, options: { items?: any[]; fakeImageCount?: number; fakeVideoCount?: number; delayMs?: number; quoted?: any }) => Promise<{ header: any; children: any[] }>;
    aunuWordReact: (jid: string, key: Record<string, unknown>, text: string, options?: { messageOptions?: MiscMessageGenerationOptions }) => Promise<any>;
}
export declare const attachAunuExperimental: <T>(sock: T) => T & AunuExperimentalAPI;

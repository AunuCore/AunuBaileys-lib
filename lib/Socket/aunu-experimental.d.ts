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
}
export declare const attachAunuExperimental: <T>(sock: T) => T & AunuExperimentalAPI;

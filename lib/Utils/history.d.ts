import { waproto } from '../../WAProto/index.js';
import type { Chat, Contact, HistorySyncSink, LIDMapping, WAMessage } from '../Types/index.js';
import type { ILogger } from './logger.js';
export declare const downloadHistory: (msg: waproto.Message.IHistorySyncNotification, options: RequestInit) => Promise<waproto.HistorySync>;
export declare const processHistoryMessage: (item: waproto.IHistorySync, logger?: ILogger) => {
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    lidPnMappings: LIDMapping[];
    pastParticipants: waproto.IPastParticipants[] | null | undefined;
    syncType: waproto.HistorySync.HistorySyncType;
    progress: number | null | undefined;
};
/**
 * AunuBaileys (2.7.0, Zapo D4): deliver every element of a decoded
 * HistorySync to the host's streaming sink — one item per element,
 * in field order, each call awaited before the next is delivered
 * (backpressure: a slow sink slows the chunk, it never reorders or
 * drops items). A throwing sink is a host bug: log it and continue
 * with the next element, mirroring the tree's host-callback guards —
 * the chunk itself must not be lost over a sink failure.
 */
export declare const streamHistorySyncToSink: (item: waproto.IHistorySync, sink: HistorySyncSink, logger?: ILogger) => Promise<void>;
export declare const downloadAndProcessHistorySyncNotification: (msg: waproto.Message.IHistorySyncNotification, options: RequestInit, logger?: ILogger, sink?: HistorySyncSink) => Promise<{
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    lidPnMappings: LIDMapping[];
    pastParticipants: waproto.IPastParticipants[] | null | undefined;
    syncType: waproto.HistorySync.HistorySyncType;
    progress: number | null | undefined;
}>;
export declare const getHistoryMsg: (message: waproto.IMessage) => waproto.Message.IHistorySyncNotification;
//# sourceMappingURL=history.d.ts.map
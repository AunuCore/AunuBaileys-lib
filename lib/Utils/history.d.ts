import { waproto } from '../../WAProto/index.js';
import type { Chat, Contact, LIDMapping, WAMessage } from '../Types/index.js';
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
export declare const downloadAndProcessHistorySyncNotification: (msg: waproto.Message.IHistorySyncNotification, options: RequestInit, logger?: ILogger) => Promise<{
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
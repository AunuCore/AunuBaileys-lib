import { proto } from '../../WAProto/index.js';
import type { Comparable } from './keyed-db.js';
import type makeWASocket from '../Socket/index.js';
import type { BaileysEventEmitter, Chat, ConnectionState, Contact, GroupMetadata, PresenceData, WAMessage, WAMessageCursor, WAMessageKey } from '../Types/index.js';
import type { Label } from '../Types/Label.js';
import type { LabelAssociation } from '../Types/LabelAssociation.js';
import type { ILogger } from '../Utils/logger.js';
import { ObjectRepository } from './object-repository.js';
type WASocket = ReturnType<typeof makeWASocket>;
export declare const waChatKey: (pin: boolean) => {
    key: (c: Chat) => string;
    compare: (k1: string, k2: string) => number;
};
export declare const waMessageID: (m: WAMessage) => string;
export declare const waLabelAssociationKey: Comparable<LabelAssociation, string>;
export type BaileysInMemoryStoreConfig = {
    chatKey?: Comparable<Chat, string>;
    labelAssociationKey?: Comparable<LabelAssociation, string>;
    logger?: ILogger;
};
declare const makeInMemoryStore: ({ logger: _logger, chatKey, labelAssociationKey }: BaileysInMemoryStoreConfig) => {
    chats: any;
    contacts: {
        [_: string]: Contact;
    };
    messages: {
        [_: string]: {
            array: WAMessage[];
            get: (id: string) => WAMessage | undefined;
            upsert: (item: WAMessage, mode: "append" | "prepend") => void;
            update: (item: WAMessage) => boolean;
            remove: (item: WAMessage) => boolean;
            updateAssign: (id: string, update: Partial<WAMessage>) => boolean;
            clear: () => void;
            filter: (contain: (item: WAMessage) => boolean) => void;
            toJSON: () => WAMessage[];
            fromJSON: (newItems: WAMessage[]) => void;
        };
    };
    groupMetadata: {
        [_: string]: GroupMetadata;
    };
    state: ConnectionState;
    presences: {
        [id: string]: {
            [participant: string]: PresenceData;
        };
    };
    labels: ObjectRepository<Label>;
    labelAssociations: any;
    bind: (ev: BaileysEventEmitter) => void;
    /** loads messages from the store, if not found -- uses the legacy connection */
    loadMessages: (jid: string, count: number, cursor: WAMessageCursor) => Promise<WAMessage[]>;
    /**
     * Get all available labels for profile
     *
     * Keep in mind that the list is formed from predefined tags and tags
     * that were "caught" during their editing.
     */
    getLabels: () => ObjectRepository<Label>;
    /**
     * Get labels for chat
     *
     * @returns Label IDs
     **/
    getChatLabels: (chatId: string) => any;
    /**
     * Get labels for message
     *
     * @returns Label IDs
     **/
    getMessageLabels: (messageId: string) => any;
    loadMessage: (jid: string, id: string) => Promise<WAMessage | undefined>;
    mostRecentMessage: (jid: string) => Promise<WAMessage | undefined>;
    fetchImageUrl: (jid: string, sock: WASocket | undefined) => Promise<any>;
    fetchGroupMetadata: (jid: string, sock: WASocket | undefined) => Promise<GroupMetadata>;
    fetchMessageReceipts: ({ remoteJid, id }: WAMessageKey) => Promise<proto.IUserReceipt[] | null | undefined>;
    toJSON: () => {
        chats: any;
        contacts: {
            [_: string]: Contact;
        };
        messages: {
            [_: string]: {
                array: WAMessage[];
                get: (id: string) => WAMessage | undefined;
                upsert: (item: WAMessage, mode: "append" | "prepend") => void;
                update: (item: WAMessage) => boolean;
                remove: (item: WAMessage) => boolean;
                updateAssign: (id: string, update: Partial<WAMessage>) => boolean;
                clear: () => void;
                filter: (contain: (item: WAMessage) => boolean) => void;
                toJSON: () => WAMessage[];
                fromJSON: (newItems: WAMessage[]) => void;
            };
        };
        labels: ObjectRepository<Label>;
        labelAssociations: any;
    };
    fromJSON: (json: any) => void;
    writeToFile: (path: string) => void;
    readFromFile: (path: string) => void;
};
export default makeInMemoryStore;
//# sourceMappingURL=make-in-memory-store.d.ts.map
import EventEmitter from 'events';
import { proto } from '../../WAProto/index.js';
import { WAMessageStatus } from '../Types/index.js';
import { trimUndefined } from './generics.js';
import { updateMessageWithReaction, updateMessageWithReceipt } from './messages.js';
import { isRealMessage, shouldIncrementChatUnread } from './process-message.js';
const BUFFERABLE_EVENT = [
    'messaging-history.set',
    'chats.upsert',
    'chats.update',
    'chats.delete',
    'contacts.upsert',
    'contacts.update',
    'messages.upsert',
    'messages.update',
    'messages.delete',
    'messages.reaction',
    'message-receipt.update',
    'groups.update'
];
const BUFFERABLE_EVENT_SET = new Set(BUFFERABLE_EVENT);
/**
 * The event buffer logically consolidates different events into a single event
 * making the data processing more efficient.
 * @param ev the baileys event emitter
 */
export const makeEventBuffer = (logger) => {
    const ev = new EventEmitter();
    const historyCache = new Set();
    let data = makeBufferData();
    let isBuffering = false;
    // take the generic event and fire it as a baileys event
    ev.on('event', (map) => {
        for (const event in map) {
            // AunuBaileys (1.0.81, HB-227/HB-228/HB-229): a host
            // listener that throws must never escape this
            // dispatcher. In the host's own call stack a throw is
            // the host's to catch — but most emits originate inside
            // lib timers and async callbacks (the nextTick
            // 'connecting' update, QR cycles, the session
            // watchdog's interval, PDO resend timeouts, ws
            // handlers), where no host frame exists to catch it:
            // the throw became an uncaught exception and killed
            // the process, or unwound past lib cleanup that still
            // had to run. Log the error and keep dispatching the
            // remaining events of the batch; the event itself
            // still fired, with its payload unchanged.
            //
            // AunuBaileys (1.0.84, HB-264): dispatch PER LISTENER.
            // A single ev.emit stops at the first listener that
            // throws, so every listener registered AFTER the
            // thrower silently missed that emit — a throwing
            // logging listener registered before the host's
            // saveCreds made that credential update vanish.
            // rawListeners returns the once-wrappers themselves,
            // so once semantics are preserved, and each listener
            // gets its own guard: a throw now costs only the
            // listener that threw.
            const listeners = ev.rawListeners(event);
            for (const listener of listeners) {
                try {
                    listener.call(ev, map[event]);
                }
                catch (err) {
                    logger.error({ err, event }, 'error in event listener — dispatch continues');
                }
            }
        }
    });
    function buffer() {
        if (!isBuffering) {
            logger.debug('Event buffer activated');
            isBuffering = true;
        }
    }
    function flush() {
        if (!isBuffering) {
            return false;
        }
        logger.debug('Flushing event buffer');
        isBuffering = false;
        // AunuBaileys (1.0.84, HB-130 + addendum): the history
        // dedup set only has to live for ONE buffering session.
        // It used to survive every flush (cleared only in
        // destroy()), so a second history sync inside the same
        // socket lifetime silently dropped every already-known
        // chat — and every already-known message key, even when
        // that message's content had changed: fresh unread
        // counts and edits never reached the store. Dedup for
        // THIS session's appends already happened above; the
        // next session starts empty.
        historyCache.clear();
        const newData = makeBufferData();
        const chatUpdates = Object.values(data.chatUpdates);
        let conditionalChatUpdatesLeft = 0;
        for (const update of chatUpdates) {
            if (update.conditional) {
                conditionalChatUpdatesLeft += 1;
                newData.chatUpdates[update.id] = update;
                delete data.chatUpdates[update.id];
            }
        }
        const consolidatedData = consolidateEvents(data);
        // AunuBaileys (1.0.81, HB-166 + HB-224): swap the fresh
        // buffer in BEFORE emitting, and guard the emit. The old
        // order assigned `data = newData` after the emit, so
        // (a) an event a listener re-buffered during the flush
        // emit landed in the OLD buffer object and was silently
        // discarded with it, and (b) a throw mid-emit left the
        // whole batch in `data`, to be delivered a second time by
        // the next flush. With the swap first, re-buffered events
        // survive to the next flush and the emitted batch is
        // detached no matter what a listener does. The guard
        // matters because flush() is called from timer callbacks
        // (chats.js history-sync transitions) and fire-and-forget
        // paths (processNodeWithBuffer), where a throw became an
        // uncaught exception / unhandled rejection.
        data = newData;
        if (Object.keys(consolidatedData).length) {
            try {
                ev.emit('event', consolidatedData);
            }
            catch (err) {
                logger.error({ err }, 'error emitting flushed events');
            }
        }
        logger.trace({ conditionalChatUpdatesLeft }, 'released buffered events');
        return true;
    }
    return {
        process(handler) {
            const listener = (map) => {
                handler(map);
            };
            ev.on('event', listener);
            return () => {
                ev.off('event', listener);
            };
        },
        emit(event, evData) {
            if (isBuffering && BUFFERABLE_EVENT_SET.has(event)) {
                append(data, historyCache, event, evData, logger);
                return true;
            }
            return ev.emit('event', { [event]: evData });
        },
        isBuffering() {
            return isBuffering;
        },
        buffer,
        flush,
        createBufferedFunction(work) {
            return async (...args) => {
                buffer();
                try {
                    return await work(...args);
                }
                finally {
                    // Flushing is now controlled centrally by the state machine.
                }
            };
        },
        on: (...args) => ev.on(...args),
        off: (...args) => ev.off(...args),
        removeAllListeners: (...args) => ev.removeAllListeners(...args),
        // AunuBaileys: destroy sungguhan — bersihkan buffer, cache & listener
        destroy() {
            try {
                const fresh = makeBufferData();
                for (const key of Object.keys(data)) {
                    delete data[key];
                }
                Object.assign(data, fresh);
            }
            catch { }
            historyCache.clear();
            isBuffering = false;
            ev.removeAllListeners();
        }
    };
};
const makeBufferData = () => {
    return {
        historySets: {
            chats: {},
            messages: {},
            contacts: {},
            isLatest: false,
            empty: true
        },
        chatUpserts: {},
        chatUpdates: {},
        chatDeletes: new Set(),
        contactUpserts: {},
        contactUpdates: {},
        messageUpserts: {},
        messageUpdates: {},
        messageReactions: {},
        messageDeletes: {},
        messageReceipts: {},
        groupUpdates: {}
    };
};
function append(data, historyCache, event, 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
eventData, logger) {
    switch (event) {
        case 'messaging-history.set':
            for (const chat of eventData.chats) {
                const existingChat = data.historySets.chats[chat.id];
                if (existingChat) {
                    existingChat.endOfHistoryTransferType = chat.endOfHistoryTransferType;
                }
                if (!existingChat && !historyCache.has(chat.id)) {
                    data.historySets.chats[chat.id] = chat;
                    historyCache.add(chat.id);
                    absorbingChatUpdate(chat);
                }
            }
            for (const contact of eventData.contacts) {
                const existingContact = data.historySets.contacts[contact.id];
                if (existingContact) {
                    Object.assign(existingContact, trimUndefined(contact));
                }
                else {
                    const historyContactId = `c:${contact.id}`;
                    const hasAnyName = contact.notify || contact.name || contact.verifiedName;
                    if (!historyCache.has(historyContactId) || hasAnyName) {
                        data.historySets.contacts[contact.id] = contact;
                        historyCache.add(historyContactId);
                    }
                }
            }
            for (const message of eventData.messages) {
                const key = stringifyMessageKey(message.key);
                const existingMsg = data.historySets.messages[key];
                if (!existingMsg && !historyCache.has(key)) {
                    data.historySets.messages[key] = message;
                    historyCache.add(key);
                }
            }
            data.historySets.empty = false;
            data.historySets.syncType = eventData.syncType;
            data.historySets.progress = eventData.progress;
            data.historySets.peerDataRequestSessionId = eventData.peerDataRequestSessionId;
            data.historySets.isLatest = eventData.isLatest || data.historySets.isLatest;
            break;
        case 'chats.upsert':
            for (const chat of eventData) {
                let upsert = data.chatUpserts[chat.id];
                if (!upsert) {
                    upsert = data.historySets.chats[chat.id];
                    if (upsert) {
                        logger.debug({ chatId: chat.id }, 'absorbed chat upsert in chat set');
                    }
                }
                if (upsert) {
                    upsert = concatChats(upsert, chat);
                }
                else {
                    upsert = chat;
                    data.chatUpserts[chat.id] = upsert;
                }
                absorbingChatUpdate(upsert);
                if (data.chatDeletes.has(chat.id)) {
                    data.chatDeletes.delete(chat.id);
                }
            }
            break;
        case 'chats.update':
            for (const update of eventData) {
                const chatId = update.id;
                const conditionMatches = update.conditional ? update.conditional(data) : true;
                if (conditionMatches) {
                    delete update.conditional;
                    // if there is an existing upsert, merge the update into it
                    const upsert = data.historySets.chats[chatId] || data.chatUpserts[chatId];
                    if (upsert) {
                        concatChats(upsert, update);
                    }
                    else {
                        // merge the update into the existing update
                        const chatUpdate = data.chatUpdates[chatId] || {};
                        data.chatUpdates[chatId] = concatChats(chatUpdate, update);
                    }
                }
                else if (conditionMatches === undefined) {
                    // condition yet to be fulfilled
                    data.chatUpdates[chatId] = update;
                }
                // otherwise -- condition not met, update is invalid
                // if the chat has been updated
                // ignore any existing chat delete
                if (data.chatDeletes.has(chatId)) {
                    data.chatDeletes.delete(chatId);
                }
            }
            break;
        case 'chats.delete':
            for (const chatId of eventData) {
                if (!data.chatDeletes.has(chatId)) {
                    data.chatDeletes.add(chatId);
                }
                // remove any prior updates & upserts
                if (data.chatUpdates[chatId]) {
                    delete data.chatUpdates[chatId];
                }
                if (data.chatUpserts[chatId]) {
                    delete data.chatUpserts[chatId];
                }
                if (data.historySets.chats[chatId]) {
                    delete data.historySets.chats[chatId];
                }
            }
            break;
        case 'contacts.upsert':
            for (const contact of eventData) {
                let upsert = data.contactUpserts[contact.id];
                if (!upsert) {
                    upsert = data.historySets.contacts[contact.id];
                    if (upsert) {
                        logger.debug({ contactId: contact.id }, 'absorbed contact upsert in contact set');
                    }
                }
                if (upsert) {
                    upsert = Object.assign(upsert, trimUndefined(contact));
                }
                else {
                    upsert = contact;
                    data.contactUpserts[contact.id] = upsert;
                }
                if (data.contactUpdates[contact.id]) {
                    // AunuBaileys (1.0.84, HB-182): the pending
                    // update merges INTO the upsert. The old
                    // direction merged the contact into the pending
                    // update object and then deleted that object —
                    // the merged result went nowhere, and fields
                    // only the update carried (notify, verifiedName)
                    // silently vanished from the flushed upsert.
                    Object.assign(upsert, data.contactUpdates[contact.id]);
                    delete data.contactUpdates[contact.id];
                }
            }
            break;
        case 'contacts.update':
            const contactUpdates = eventData;
            for (const update of contactUpdates) {
                const id = update.id;
                // merge into prior upsert
                const upsert = data.historySets.contacts[id] || data.contactUpserts[id];
                if (upsert) {
                    Object.assign(upsert, update);
                }
                else {
                    // merge into prior update
                    const contactUpdate = data.contactUpdates[id] || {};
                    data.contactUpdates[id] = Object.assign(contactUpdate, update);
                }
            }
            break;
        case 'messages.upsert':
            const { messages, type } = eventData;
            for (const message of messages) {
                const key = stringifyMessageKey(message.key);
                let existing = data.messageUpserts[key]?.message;
                if (!existing) {
                    existing = data.historySets.messages[key];
                    if (existing) {
                        logger.debug({ messageId: key }, 'absorbed message upsert in message set');
                    }
                }
                if (existing) {
                    message.messageTimestamp = existing.messageTimestamp;
                }
                if (data.messageUpdates[key]) {
                    logger.debug('absorbed prior message update in message upsert');
                    Object.assign(message, data.messageUpdates[key].update);
                    delete data.messageUpdates[key];
                }
                if (data.historySets.messages[key]) {
                    data.historySets.messages[key] = message;
                }
                else {
                    data.messageUpserts[key] = {
                        message,
                        type: type === 'notify' || data.messageUpserts[key]?.type === 'notify' ? 'notify' : type
                    };
                }
            }
            break;
        case 'messages.update':
            const msgUpdates = eventData;
            for (const { key, update } of msgUpdates) {
                const keyStr = stringifyMessageKey(key);
                const existing = data.historySets.messages[keyStr] || data.messageUpserts[keyStr]?.message;
                if (existing) {
                    Object.assign(existing, update);
                    // if the message was received & read by us
                    // the chat counter must have been incremented
                    // so we need to decrement it
                    if (update.status === WAMessageStatus.READ && !key.fromMe) {
                        decrementChatReadCounterIfMsgDidUnread(existing);
                    }
                }
                else {
                    const msgUpdate = data.messageUpdates[keyStr] || { key, update: {} };
                    Object.assign(msgUpdate.update, update);
                    data.messageUpdates[keyStr] = msgUpdate;
                }
            }
            break;
        case 'messages.delete':
            const deleteData = eventData;
            if ('keys' in deleteData) {
                const { keys } = deleteData;
                for (const key of keys) {
                    const keyStr = stringifyMessageKey(key);
                    if (!data.messageDeletes[keyStr]) {
                        data.messageDeletes[keyStr] = key;
                    }
                    if (data.messageUpserts[keyStr]) {
                        delete data.messageUpserts[keyStr];
                    }
                    if (data.messageUpdates[keyStr]) {
                        delete data.messageUpdates[keyStr];
                    }
                }
            }
            else {
                // TODO: add support
            }
            break;
        case 'messages.reaction':
            const reactions = eventData;
            for (const { key, reaction } of reactions) {
                const keyStr = stringifyMessageKey(key);
                const existing = data.messageUpserts[keyStr];
                if (existing) {
                    updateMessageWithReaction(existing.message, reaction);
                }
                else {
                    data.messageReactions[keyStr] = data.messageReactions[keyStr] || { key, reactions: [] };
                    updateMessageWithReaction(data.messageReactions[keyStr], reaction);
                }
            }
            break;
        case 'message-receipt.update':
            const receipts = eventData;
            for (const { key, receipt } of receipts) {
                const keyStr = stringifyMessageKey(key);
                const existing = data.messageUpserts[keyStr];
                if (existing) {
                    updateMessageWithReceipt(existing.message, receipt);
                }
                else {
                    data.messageReceipts[keyStr] = data.messageReceipts[keyStr] || { key, userReceipt: [] };
                    updateMessageWithReceipt(data.messageReceipts[keyStr], receipt);
                }
            }
            break;
        case 'groups.update':
            const groupUpdates = eventData;
            for (const update of groupUpdates) {
                const id = update.id;
                const groupUpdate = data.groupUpdates[id] || {};
                if (!data.groupUpdates[id]) {
                    data.groupUpdates[id] = Object.assign(groupUpdate, update);
                }
            }
            break;
        default:
            throw new Error(`"${event}" cannot be buffered`);
    }
    function absorbingChatUpdate(existing) {
        const chatId = existing.id;
        const update = data.chatUpdates[chatId];
        if (update) {
            const conditionMatches = update.conditional ? update.conditional(data) : true;
            if (conditionMatches) {
                delete update.conditional;
                logger.debug({ chatId }, 'absorbed chat update in existing chat');
                Object.assign(existing, concatChats(update, existing));
                delete data.chatUpdates[chatId];
            }
            else if (conditionMatches === false) {
                logger.debug({ chatId }, 'chat update condition fail, removing');
                delete data.chatUpdates[chatId];
            }
        }
    }
    function decrementChatReadCounterIfMsgDidUnread(message) {
        // decrement chat unread counter
        // if the message has already been marked read by us
        const chatId = message.key.remoteJid;
        const chat = data.chatUpdates[chatId] || data.chatUpserts[chatId];
        if (isRealMessage(message, '') &&
            shouldIncrementChatUnread(message) &&
            typeof chat?.unreadCount === 'number' &&
            chat.unreadCount > 0) {
            logger.debug({ chatId: chat.id }, 'decrementing chat counter');
            chat.unreadCount -= 1;
            if (chat.unreadCount === 0) {
                delete chat.unreadCount;
            }
        }
    }
}
function consolidateEvents(data) {
    const map = {};
    if (!data.historySets.empty) {
        map['messaging-history.set'] = {
            chats: Object.values(data.historySets.chats),
            messages: Object.values(data.historySets.messages),
            contacts: Object.values(data.historySets.contacts),
            syncType: data.historySets.syncType,
            progress: data.historySets.progress,
            isLatest: data.historySets.isLatest,
            peerDataRequestSessionId: data.historySets.peerDataRequestSessionId
        };
    }
    const chatUpsertList = Object.values(data.chatUpserts);
    if (chatUpsertList.length) {
        map['chats.upsert'] = chatUpsertList;
    }
    const chatUpdateList = Object.values(data.chatUpdates);
    if (chatUpdateList.length) {
        map['chats.update'] = chatUpdateList;
    }
    const chatDeleteList = Array.from(data.chatDeletes);
    if (chatDeleteList.length) {
        map['chats.delete'] = chatDeleteList;
    }
    const messageUpsertList = Object.values(data.messageUpserts);
    if (messageUpsertList.length) {
        const type = messageUpsertList[0].type;
        map['messages.upsert'] = {
            messages: messageUpsertList.map(m => m.message),
            type
        };
    }
    const messageUpdateList = Object.values(data.messageUpdates);
    if (messageUpdateList.length) {
        map['messages.update'] = messageUpdateList;
    }
    const messageDeleteList = Object.values(data.messageDeletes);
    if (messageDeleteList.length) {
        map['messages.delete'] = { keys: messageDeleteList };
    }
    const messageReactionList = Object.values(data.messageReactions).flatMap(({ key, reactions }) => reactions.flatMap(reaction => ({ key, reaction })));
    if (messageReactionList.length) {
        map['messages.reaction'] = messageReactionList;
    }
    const messageReceiptList = Object.values(data.messageReceipts).flatMap(({ key, userReceipt }) => userReceipt.flatMap(receipt => ({ key, receipt })));
    if (messageReceiptList.length) {
        map['message-receipt.update'] = messageReceiptList;
    }
    const contactUpsertList = Object.values(data.contactUpserts);
    if (contactUpsertList.length) {
        map['contacts.upsert'] = contactUpsertList;
    }
    const contactUpdateList = Object.values(data.contactUpdates);
    if (contactUpdateList.length) {
        map['contacts.update'] = contactUpdateList;
    }
    const groupUpdateList = Object.values(data.groupUpdates);
    if (groupUpdateList.length) {
        map['groups.update'] = groupUpdateList;
    }
    return map;
}
function concatChats(a, b) {
    if (b.unreadCount === null && // neutralize unread counter
        a.unreadCount < 0) {
        a.unreadCount = undefined;
        b.unreadCount = undefined;
    }
    if (typeof a.unreadCount === 'number' && typeof b.unreadCount === 'number') {
        b = { ...b };
        if (b.unreadCount >= 0) {
            b.unreadCount = Math.max(b.unreadCount, 0) + Math.max(a.unreadCount, 0);
        }
    }
    return Object.assign(a, b);
}
const stringifyMessageKey = (key) => `${key.remoteJid},${key.id},${key.fromMe ? '1' : '0'}`;
//# sourceMappingURL=event-buffer.js.map
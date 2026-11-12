import type { AxiosRequestConfig } from 'axios';
import type { Readable } from 'stream';
import type { URL } from 'url';
import { proto } from '../../WAProto/index.js';
import { MEDIA_HKDF_KEY_MAPPING } from '../Defaults/index.js';
import type { BinaryNode } from '../WABinary/index.js';
import type { GroupMetadata } from './GroupMetadata.js';
import type { CacheStore } from './Socket.js';
export { proto as WAProto };
export type WAMessage = proto.IWebMessageInfo & {
    key: WAMessageKey;
};
export type WAMessageContent = proto.IMessage;
export type WAContactMessage = proto.Message.IContactMessage;
export type WAContactsArrayMessage = proto.Message.IContactsArrayMessage;
export type WAMessageKey = proto.IMessageKey & {
    senderLid?: string;
    server_id?: string;
    senderPn?: string;
    participantLid?: string;
    participantPn?: string;
    isViewOnce?: boolean;
};
export type WATextMessage = proto.Message.IExtendedTextMessage;
export type WAContextInfo = proto.IContextInfo;
export type WALocationMessage = proto.Message.ILocationMessage;
export type WAGenericMediaMessage = proto.Message.IVideoMessage | proto.Message.IImageMessage | proto.Message.IAudioMessage | proto.Message.IDocumentMessage | proto.Message.IStickerMessage;
export declare const WAMessageStubType: typeof proto.WebMessageInfo.StubType;
export declare const WAMessageStatus: typeof proto.WebMessageInfo.Status;
import type { ILogger } from '../Utils/logger.js';
export type WAMediaPayloadURL = {
    url: URL | string;
};
export type WAMediaPayloadStream = {
    stream: Readable;
};
export type WAMediaUpload = Buffer | WAMediaPayloadStream | WAMediaPayloadURL;
/** Set of message types that are supported by the library */
export type MessageType = keyof proto.Message;
export type MessageWithContextInfo = 'imageMessage' | 'contactMessage' | 'locationMessage' | 'extendedTextMessage' | 'documentMessage' | 'audioMessage' | 'videoMessage' | 'call' | 'contactsArrayMessage' | 'liveLocationMessage' | 'templateMessage' | 'stickerMessage' | 'groupInviteMessage' | 'templateButtonReplyMessage' | 'productMessage' | 'listMessage' | 'orderMessage' | 'listResponseMessage' | 'buttonsMessage' | 'buttonsResponseMessage' | 'interactiveMessage' | 'interactiveResponseMessage' | 'pollCreationMessage' | 'requestPhoneNumberMessage' | 'messageHistoryBundle' | 'eventMessage' | 'newsletterAdminInviteMessage' | 'albumMessage' | 'stickerPackMessage' | 'pollResultSnapshotMessage' | 'messageHistoryNotice';
export type DownloadableMessage = {
    mediaKey?: Uint8Array | null;
    directPath?: string | null;
    url?: string | null;
};
export type MessageReceiptType = 'read' | 'read-self' | 'hist_sync' | 'peer_msg' | 'sender' | 'inactive' | 'played' | undefined;
export type MediaConnInfo = {
    auth: string;
    ttl: number;
    hosts: {
        hostname: string;
        maxContentLengthBytes: number;
    }[];
    fetchDate: Date;
};
export interface WAUrlInfo {
    'canonical-url': string;
    'matched-text': string;
    title: string;
    description?: string;
    jpegThumbnail?: Buffer;
    highQualityThumbnail?: proto.Message.IImageMessage;
    originalThumbnailUrl?: string;
}
type Mentionable = {
    /** list of jids that are mentioned in the accompanying text */
    mentions?: string[];
    /** mention all group participants via the native non-JID mention flag (no JID list needed) */
    mentionAll?: boolean;
};
type Contextable = {
    /** add contextInfo to the message */
    contextInfo?: proto.IContextInfo;
    /**
     * shorthand for contextInfo.externalAdReply — renders an ad-reply / link-preview
     * card without hand-writing contextInfo. `url` maps to both mediaUrl and sourceUrl;
     * a missing url stays empty (no fallback link is ever injected).
     */
    externalAdReply?: {
        title?: string;
        body?: string;
        url?: string;
        mediaType?: proto.Message.ExternalAdReplyInfo.MediaType;
        /** thumbnail image bytes */
        thumbnail?: Buffer;
        thumbnailUrl?: string;
        /** render the large thumbnail variant */
        largeThumbnail?: boolean;
        showAdAttribution?: boolean;
    };
};
type ViewOnce = {
    /** boolean keeps the old v1 wrap; 'v2' / 'force' / { version, force } select the universal view-once variant */
    viewOnce?: boolean | 'v1' | 'v2' | 'force' | 'v2-force' | { version?: 1 | 2 | 'v1' | 'v2'; force?: boolean };
    /** wrap the message into viewOnceMessageV2 */
    viewOnceV2?: boolean;
    /** wrap the message into viewOnceMessageV2Extension */
    viewOnceV2Extension?: boolean;
    /** wrap the message into ephemeralMessage */
    ephemeral?: boolean;
    /** wrap an interactive message into a templateMessage (requires `interactive` content) */
    interactiveAsTemplate?: boolean;
    /** optional template id used when interactiveAsTemplate is set */
    templateId?: string;
};
type Editable = {
    edit?: WAMessageKey;
};
type WithDimensions = {
    width?: number;
    height?: number;
};
export type PollMessageOptions = {
    name: string;
    selectableCount?: number;
    values: string[];
    /** 32 byte message secret to encrypt poll selections */
    messageSecret?: Uint8Array;
    toAnnouncementGroup?: boolean;
    /** 1 = quiz (requires correctAnswer); anything else is a plain poll */
    pollType?: number;
    /** the correct option for a quiz poll */
    correctAnswer?: string;
    /** when set, the poll closes at this time (PollCreationMessage endTime) */
    endDate?: Date;
    /** hide voter names — routes the poll to pollCreationMessageV6 */
    hideVoter?: boolean;
    /** let voters add their own options — routes the poll to pollCreationMessageV6 */
    canAddOption?: boolean;
};
export type ImagePollOption = {
    name: string;
    /** the option image; uploaded by sendMessage before the parent is built */
    image: WAMediaUpload;
    /** filled in by sendMessage via hashImagePollOption — never set by hand */
    optionHash?: string;
};
export type ImagePollMessageOptions = {
    name: string;
    selectableCount?: number;
    options: ImagePollOption[];
    /** 32 byte message secret to encrypt poll selections */
    messageSecret?: Uint8Array;
};
type SharePhoneNumber = {
    sharePhoneNumber: boolean;
};
type RequestPhoneNumber = {
    requestPhoneNumber: boolean;
};
export type MediaType = keyof typeof MEDIA_HKDF_KEY_MAPPING;
export type AnyMediaMessageContent = (({
    image: WAMediaUpload;
    caption?: string;
    jpegThumbnail?: string;
} & Mentionable & Contextable & WithDimensions) | ({
    video: WAMediaUpload;
    caption?: string;
    gifPlayback?: boolean;
    jpegThumbnail?: string;
    /** if set to true, will send as a `video note` */
    ptv?: boolean;
} & Mentionable & Contextable & WithDimensions) | {
    audio: WAMediaUpload;
    /** if set to true, will send as a `voice note` */
    ptt?: boolean;
    /** optionally tell the duration of the audio */
    seconds?: number;
} | ({
    sticker: WAMediaUpload;
    isAnimated?: boolean;
} & WithDimensions) | ({
    document: WAMediaUpload;
    mimetype: string;
    fileName?: string;
    caption?: string;
} & Contextable)) & {
    mimetype?: string;
} & Editable;
export type ButtonReplyInfo = {
    displayText: string;
    id: string;
    index: number;
};
export type GroupInviteInfo = {
    inviteCode: string;
    inviteExpiration: number;
    text: string;
    jid: string;
    subject: string;
};
export type WASendableProduct = Omit<proto.Message.ProductMessage.IProductSnapshot, 'productImage'> & {
    productImage: WAMediaUpload;
};
export type AnyRegularMessageContent = (({
    text: string;
    linkPreview?: WAUrlInfo | null;
} & Mentionable & Contextable & Editable) | AnyMediaMessageContent | ({
    poll: PollMessageOptions;
} & Mentionable & Contextable & Editable) | ({
    imagePoll: ImagePollMessageOptions;
} & Mentionable & Contextable & Editable) | {
    contacts: {
        displayName?: string;
        contacts: proto.Message.IContactMessage[];
    };
} | {
    location: WALocationMessage;
} | {
    react: proto.Message.IReactionMessage;
} | {
    buttonReply: ButtonReplyInfo;
    type: 'template' | 'plain';
} | {
    groupInvite: GroupInviteInfo;
} | {
    listReply: Omit<proto.Message.IListResponseMessage, 'contextInfo'>;
} | {
    pin: WAMessageKey;
    type: proto.PinInChat.Type;
    /**
     * 24 hours, 7 days, 30 days
     */
    time?: 86400 | 604800 | 2592000;
} | {
    product: WASendableProduct;
    businessOwnerJid?: string;
    body?: string;
    footer?: string;
} | SharePhoneNumber | RequestPhoneNumber) & ViewOnce;
export type StickerPackStickerInfo = {
    data: WAMediaUpload;
    emojis?: string[];
    isAnimated?: boolean;
    accessibilityLabel?: string;
    isLottie?: boolean;
};
export type StickerPackInfo = {
    stickers: StickerPackStickerInfo[];
    cover: WAMediaUpload;
    name?: string;
    publisher?: string;
    packId?: string;
    description?: string;
};
export type AnyMessageContent = (AnyRegularMessageContent | {
    forward: WAMessage;
    force?: boolean;
} | {
    /** Delete your message or anyone's message in a group (admin required) */
    delete: WAMessageKey;
} | {
    disappearingMessagesInChat: boolean | number;
} | {
    /** AunuBaileys: send a sticker pack (cover + stickers) */
    stickerPack: StickerPackInfo;
} | {
    /** AunuBaileys: send a sticker pack, flat form (cover + stickers) */
    stickers: StickerPackStickerInfo[];
    cover: WAMediaUpload;
    name?: string;
    publisher?: string;
    description?: string;
} | {
    /** AunuBaileys: send an album of images/videos */
    album: AnyRegularMessageContent[];
}) & {
    /** AunuBaileys: mark the message with the AI label (private chats only) */
    ai?: boolean;
    /** AunuBaileys: A2UI widget — an AunuA2UI instance or a built bloksWidget payload */
    a2ui?: any;
    /** AunuBaileys: A2UI payload type (default 'im_a2ui') */
    a2uiType?: string;
    /** AunuBaileys: A2UI surface envelope on/off (default true) */
    a2uiWrapped?: boolean;
    /** AunuBaileys: wrap the built message in lottieStickerMessage */
    isLottie?: boolean;
    /** AunuBaileys: pass the content object straight through to generateWAMessage() unprocessed */
    raw?: boolean;
    /** AunuBaileys (1.0.71): wrap the message in spoilerMessage (tap-to-reveal) */
    spoiler?: boolean;
    /** AunuBaileys (1.0.71): wrap the message in groupStatusMessageV2 (group status/story) */
    groupStatus?: boolean;
    /** AunuBaileys: force the biz binary node (secure Meta service label) onto this message's stanza */
    secureMetaServiceLabel?: boolean;
    /** AunuBaileys: rich response — a highlighted code block (routes the whole message to the rich response builder) */
    code?: string;
    /** language for the rich response code block (default javascript) */
    language?: string;
    /** AunuBaileys: rich response — a table; first row is the heading unless noHeading is set */
    table?: string[][];
    /** title for the rich response table */
    title?: string;
    /** AunuBaileys: rich response — citation links (a link without url is skipped; no fallback is injected) */
    links?: {
        text: string;
        url?: string;
        title?: string;
        displayName?: string;
        sources?: {
            displayName?: string;
            subtitle?: string;
            url?: string;
        }[];
    }[];
    /** AunuBaileys: rich response — prebuilt submessages */
    richResponse?: any[];
    headerText?: string;
    contentText?: string;
    footerText?: string;
    disclaimerText?: string;
    noHeading?: boolean;
    html?: string;
    trustedSources?: string[];
    richHtml?: { html?: string; title?: string; tabHeader?: string; url?: string; trustedSources?: string[]; tabs?: any[] };
};
export type GroupMetadataParticipants = Pick<GroupMetadata, 'participants'>;
type MinimalRelayOptions = {
    /** override the message ID with a custom provided string */
    messageId?: string;
    /** should we use group metadata cache, or fetch afresh from the server; default assumed to be "true" */
    useCachedGroupMetadata?: boolean;
};
export type MessageRelayOptions = MinimalRelayOptions & {
    /** only send to a specific participant; used when a message decryption fails for a single user */
    participant?: {
        jid: string;
        count: number;
    };
    /** additional attributes to add to the WA binary node */
    additionalAttributes?: {
        [_: string]: string;
    };
    additionalNodes?: BinaryNode[];
    /** should we use the devices cache, or fetch afresh from the server; default assumed to be "true" */
    useUserDevicesCache?: boolean;
    /** jid list of participants for status@broadcast */
    statusJidList?: string[];
    /** AunuBaileys: status audience privacy, sent as a <meta status_setting> node */
    statusPrivacy?: 'contacts' | 'allowlist' | 'denylist';
};
export type MiscMessageGenerationOptions = MinimalRelayOptions & {
    /** optional, if you want to manually set the timestamp of the message */
    timestamp?: Date;
    /** the message you want to quote */
    quoted?: WAMessage;
    /** disappearing messages settings */
    ephemeralExpiration?: number | string;
    /** AunuBaileys: timestamp of the chat's disappearing-mode setting; stamped on ephemeral sends when the caller tracks it */
    ephemeralSettingTimestamp?: number;
    /** AunuBaileys: proto.DisappearingMode.Trigger override for ephemeral sends (default CHAT_SETTING) */
    disappearingModeTrigger?: number;
    /** timeout for media upload to WA server */
    mediaUploadTimeoutMs?: number;
    /** jid list of participants for status@broadcast */
    statusJidList?: string[];
    /** AunuBaileys: status audience privacy, sent as a <meta status_setting> node */
    statusPrivacy?: 'contacts' | 'allowlist' | 'denylist';
    /** AunuBaileys: send into a group addressed to one member only — a JID, or true to use the quoted message's author (groups only) */
    exclusive?: boolean | string;
    /** backgroundcolor for status */
    backgroundColor?: string;
    /** font type for status */
    font?: number;
    /** if it is broadcast */
    broadcast?: boolean;
};
export type MessageGenerationOptionsFromContent = MiscMessageGenerationOptions & {
    userJid: string;
};
export type WAMediaUploadFunction = (encFilePath: string, opts: {
    fileEncSha256B64: string;
    mediaType: MediaType;
    timeoutMs?: number;
}) => Promise<{
    mediaUrl: string;
    directPath: string;
}>;
export type MediaGenerationOptions = {
    logger?: ILogger;
    mediaTypeOverride?: MediaType;
    upload: WAMediaUploadFunction;
    /** cache media so it does not have to be uploaded again */
    mediaCache?: CacheStore;
    mediaUploadTimeoutMs?: number;
    options?: AxiosRequestConfig;
    backgroundColor?: string;
    font?: number;
};
export type MessageContentGenerationOptions = MediaGenerationOptions & {
    getUrlInfo?: (text: string) => Promise<WAUrlInfo | undefined>;
    getProfilePicUrl?: (jid: string, type: 'image' | 'preview') => Promise<string | undefined>;
    jid?: string;
};
export type MessageGenerationOptions = MessageContentGenerationOptions & MessageGenerationOptionsFromContent;
/**
 * Type of message upsert
 * 1. notify => notify the user, this message was just received
 * 2. append => append the message to the chat history, no notification required
 */
export type MessageUpsertType = 'append' | 'notify';
export type MessageUserReceipt = proto.IUserReceipt;
export type WAMessageUpdate = {
    update: Partial<WAMessage>;
    key: proto.IMessageKey;
};
export type WAMessageCursor = {
    before: WAMessageKey | undefined;
} | {
    after: WAMessageKey | undefined;
};
export type MessageUserReceiptUpdate = {
    key: proto.IMessageKey;
    receipt: MessageUserReceipt;
};
export type MediaDecryptionKeyInfo = {
    iv: Buffer;
    cipherKey: Buffer;
    macKey?: Buffer;
};
export type MinimalMessage = Pick<proto.IWebMessageInfo, 'key' | 'messageTimestamp'>;
//# sourceMappingURL=Message.d.ts.map
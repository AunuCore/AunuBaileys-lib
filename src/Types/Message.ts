import type { Readable } from 'stream'
import type { URL } from 'url'
import { waproto } from '../../WAProto/index.js'
import type { MediaType } from '../Defaults'
import type { BinaryNode } from '../WABinary'
import type { GroupMetadata } from './GroupMetadata'
import type { CacheStore } from './Socket'

// export the WAMessage Prototypes
export { waproto as WAProto }
export type WAMessage = waproto.IWebMessageInfo & {
	key: WAMessageKey
	messageStubParameters?: any
	category?: string
	retryCount?: number
}
export type WAMessageContent = waproto.IMessage
export type WAContactMessage = waproto.Message.IContactMessage
export type WAContactsArrayMessage = waproto.Message.IContactsArrayMessage
export type WAMessageKey = waproto.IMessageKey & {
	remoteJidAlt?: string
	remoteJidUsername?: string
	participantAlt?: string
	participantUsername?: string
	server_id?: string
	addressingMode?: string
	isViewOnce?: boolean // TODO: remove out of the message key, place in WebMessageInfo
}
export type WATextMessage = waproto.Message.IExtendedTextMessage
export type WAContextInfo = waproto.IContextInfo
export type WALocationMessage = waproto.Message.ILocationMessage
export type WAGenericMediaMessage =
	| waproto.Message.IVideoMessage
	| waproto.Message.IImageMessage
	| waproto.Message.IAudioMessage
	| waproto.Message.IDocumentMessage
	| waproto.Message.IStickerMessage
export const WAMessageStubType = waproto.WebMessageInfo.StubType
export const WAMessageStatus = waproto.WebMessageInfo.Status
import type { ILogger } from '../Utils/logger'
export type WAMediaPayloadURL = { url: URL | string }
export type WAMediaPayloadStream = { stream: Readable }
export type WAMediaUpload = Buffer | WAMediaPayloadStream | WAMediaPayloadURL
/** Set of message types that are supported by the library */
export type MessageType = keyof waproto.Message

export enum WAMessageAddressingMode {
	PN = 'pn',
	LID = 'lid'
}

export type MessageWithContextInfo =
	| 'imageMessage'
	| 'contactMessage'
	| 'locationMessage'
	| 'extendedTextMessage'
	| 'documentMessage'
	| 'audioMessage'
	| 'videoMessage'
	| 'call'
	| 'contactsArrayMessage'
	| 'liveLocationMessage'
	| 'templateMessage'
	| 'stickerMessage'
	| 'groupInviteMessage'
	| 'templateButtonReplyMessage'
	| 'productMessage'
	| 'listMessage'
	| 'orderMessage'
	| 'listResponseMessage'
	| 'buttonsMessage'
	| 'buttonsResponseMessage'
	| 'interactiveMessage'
	| 'interactiveResponseMessage'
	| 'pollCreationMessage'
	| 'requestPhoneNumberMessage'
	| 'messageHistoryBundle'
	| 'eventMessage'
	| 'newsletterAdminInviteMessage'
	| 'albumMessage'
	| 'stickerPackMessage'
	| 'pollResultSnapshotMessage'
	| 'messageHistoryNotice'

export type DownloadableMessage = { mediaKey?: Uint8Array | null; directPath?: string | null; url?: string | null }

export type MessageReceiptType =
	| 'read'
	| 'read-self'
	| 'hist_sync'
	| 'peer_msg'
	| 'sender'
	| 'inactive'
	| 'played'
	| undefined

export type MediaConnInfo = {
	auth: string
	ttl: number
	hosts: { hostname: string; maxContentLengthBytes: number }[]
	fetchDate: Date
}

export interface WAUrlInfo {
	'canonical-url': string
	'matched-text': string
	title: string
	description?: string
	jpegThumbnail?: Buffer
	highQualityThumbnail?: waproto.Message.IImageMessage
	originalThumbnailUrl?: string
}

// types to generate WA messages
type Mentionable = {
	/** list of jids that are mentioned in the accompanying text */
	mentions?: string[]
	/** mention all */
	mentionAll?: boolean
}
type Contextable = {
	/** add contextInfo to the message */
	contextInfo?: waproto.IContextInfo
}
/**
 * AunuBaileys view-once flag forms, honoured by wrapAunuViewOnce
 * (src/Utils/aunu-view-once.ts) — a boolean keeps the old behaviour,
 * a string/number selects the variant, an object selects version +
 * force. Shared with the util so the call site in
 * generateWAMessageContent type-checks against the widened content
 * field below.
 */
export type AunuViewOnceFlag =
	| boolean
	| 'v1'
	| 'v2'
	| 'force'
	| 'v2-force'
	| 1
	| 2
	| { version?: 1 | 2 | 'v1' | 'v2'; force?: boolean }

type ViewOnce = {
	viewOnce?: AunuViewOnceFlag
	/** wrap an interactive message into a templateMessage (requires `interactive` content) */
	interactiveAsTemplate?: boolean
	/** optional template id used when interactiveAsTemplate is set */
	templateId?: string
}

type Editable = {
	edit?: WAMessageKey
}
type WithDimensions = {
	width?: number
	height?: number
}

export type PollMessageOptions = {
	name: string
	selectableCount?: number
	values: string[]
	/** 32 byte message secret to encrypt poll selections */
	messageSecret?: Uint8Array
	toAnnouncementGroup?: boolean
	/** 1 = quiz (requires correctAnswer); anything else is a plain poll */
	pollType?: number
	/** the correct option for a quiz poll */
	correctAnswer?: string
	/** when set, the poll closes at this time (PollCreationMessage endTime) */
	endDate?: Date
	/** hide voter names — routes the poll to pollCreationMessageV6 */
	hideVoter?: boolean
	/** let voters add their own options — routes the poll to pollCreationMessageV6 */
	canAddOption?: boolean
}

export type EventMessageOptions = {
	name: string
	description?: string
	startDate: Date
	endDate?: Date
	location?: WALocationMessage
	call?: 'audio' | 'video'
	isCancelled?: boolean
	isScheduleCall?: boolean
	extraGuestsAllowed?: boolean
	messageSecret?: Uint8Array<ArrayBufferLike>
}

export type AlbumMessageOptions = {
	/** Number of images expected in the album */
	expectedImageCount?: number
	/** Number of videos expected in the album */
	expectedVideoCount?: number
}

type SharePhoneNumber = {
	sharePhoneNumber: boolean
}

type RequestPhoneNumber = {
	requestPhoneNumber: boolean
}

export type AnyMediaMessageContent = (
	| ({
			image: WAMediaUpload
			caption?: string
			jpegThumbnail?: string
			/** AunuBaileys (2.8.0, D-1103): HD preview — a larger (200px) thumbnail; the media bytes themselves are never re-encoded */
			hd?: boolean
	  } & Mentionable &
			Contextable &
			WithDimensions)
	| ({
			video: WAMediaUpload
			caption?: string
			gifPlayback?: boolean
			jpegThumbnail?: string
			/** AunuBaileys (2.8.0, D-1103): HD preview — a larger (200x200) thumbnail; the media bytes themselves are never re-encoded */
			hd?: boolean
			/** if set to true, will send as a `video note` */
			ptv?: boolean
	  } & Mentionable &
			Contextable &
			WithDimensions)
	| {
			audio: WAMediaUpload
			/** if set to true, will send as a `voice note` */
			ptt?: boolean
			/** optionally tell the duration of the audio */
			seconds?: number
	  }
	| ({
			sticker: WAMediaUpload
			isAnimated?: boolean
	  } & WithDimensions)
	| ({
			document: WAMediaUpload
			mimetype: string
			fileName?: string
			caption?: string
	  } & Contextable)
) & { mimetype?: string } & Editable & {
		/** key of the parent albumMessage to associate this media with */
		albumParentKey?: WAMessageKey
	}

export type ButtonReplyInfo = {
	displayText: string
	id: string
	index: number
}

export type GroupInviteInfo = {
	inviteCode: string
	inviteExpiration: number
	text: string
	jid: string
	subject: string
}

export type WASendableProduct = Omit<waproto.Message.ProductMessage.IProductSnapshot, 'productImage'> & {
	productImage: WAMediaUpload
}

/**
 * AunuBaileys (ported P2d): one submessage of an `aiRich` rich response —
 * the input shape of the v6 `generateWAMessageContent` 'aiRich' branch,
 * i.e. what `AIRich.build()` (Utils/builders) produces, plus the map /
 * inlineImage shapes that branch also accepted in v6.
 */
export type AIRichSubMessageContent = {
	type?: 'text' | 'code' | 'latex' | 'table' | 'map' | 'inlineImage'
	text?: string
	code?: string
	language?: string
	table?: waproto.IAIRichResponseTableMetadata
	map?: waproto.IAIRichResponseMapMetadata
	mapMetadata?: waproto.IAIRichResponseMapMetadata
	centerLatitude?: number
	centerLongitude?: number
	latitude?: number
	longitude?: number
	latitudeDelta?: number
	longitudeDelta?: number
	annotations?: waproto.AIRichResponseMapMetadata.IAIRichResponseMapAnnotation[]
	showInfoList?: boolean
	imageUrl?: string | waproto.IAIRichResponseImageURL
	url?: string
	inlineImage?: string | waproto.IAIRichResponseImageURL
	imageText?: string
	alignment?: waproto.AIRichResponseInlineImageMetadata.AIRichResponseImageAlignment
	tapLinkUrl?: string
	raw?: waproto.IAIRichResponseSubMessage
}

export type AnyRegularMessageContent = (
	| ({
			text: string
			linkPreview?: WAUrlInfo | null
			/** AunuBaileys (2.6.0, Kage favicon link-preview delta, run-0929): a host-supplied favicon image, uploaded and attached as faviconMmsMetadata on the extendedTextMessage. */
			favicon?: WAMediaUpload
	  } & Mentionable &
			Contextable &
			Editable)
	| AnyMediaMessageContent
	| { event: EventMessageOptions }
	| ({
			poll: PollMessageOptions
	  } & Mentionable &
			Contextable &
			Editable)
	| ({
			album: AlbumMessageOptions
	  } & Contextable &
			Mentionable)
	| {
			contacts: {
				displayName?: string
				contacts: waproto.Message.IContactMessage[]
			}
	  }
	| {
			location: WALocationMessage
	  }
	| { react: waproto.Message.IReactionMessage }
	| {
			buttonReply: ButtonReplyInfo
			type: 'template' | 'plain'
	  }
	| {
			groupInvite: GroupInviteInfo
	  }
	| {
			listReply: Omit<waproto.Message.IListResponseMessage, 'contextInfo'>
	  }
	| {
			pin: WAMessageKey
			type: waproto.PinInChat.Type
			/**
			 * 24 hours, 7 days, 30 days
			 */
			time?: 86400 | 604800 | 2592000
	  }
	| {
			product: WASendableProduct
			businessOwnerJid?: string
			body?: string
			footer?: string
	  }
	| {
			/** AunuBaileys: Meta AI-style rich response (AIRichResponseMessage), built by `AIRich.build()` */
			aiRich: {
				submessages: AIRichSubMessageContent[]
			}
			/** optional companion text — ignored when the rich response is present, as in v6 */
			text?: string
	  }
	| SharePhoneNumber
	| RequestPhoneNumber
) &
	ViewOnce

/** AunuBaileys (P2e port from v6): one sticker inside a sticker pack */
export type StickerPackStickerInfo = {
	data: WAMediaUpload
	emojis?: string[]
	isAnimated?: boolean
	accessibilityLabel?: string
	isLottie?: boolean
}

/** AunuBaileys (P2e port from v6): a sticker pack (cover + stickers) */
export type StickerPackInfo = {
	stickers: StickerPackStickerInfo[]
	cover: WAMediaUpload
	name?: string
	publisher?: string
	packId?: string
	description?: string
}

/**
 * Options for voting on a poll (sendPollVote / the `pollVote` content
 * branch). All five fields are required: the branch validates them
 * with Boom 400 before any network work (run-0962 spec). Defined
 * here (not Utils) so the AnyMessageContent union below can carry
 * the pollVote member; re-exported from Utils for barrel compat.
 */
/**
 * Options for sending a poll RESULT snapshot (the `pollResult`
 * content branch, restored in 2.7.0 — HB-491). Builds a
 * PollResultSnapshotMessage: field 88 for a plain poll,
 * pollResultSnapshotMessageV3 (field 115) when `pollType` is 1
 * (quiz). `optionVoteCount` is the proto int64, passed as a number.
 */
export type PollResultOptions = {
	/** Name of the poll the snapshot reports on. */
	name: string
	/** Per-option tallies, in poll order. */
	pollVotes: { optionName: string; optionVoteCount: number }[]
	/** 1 = quiz (routes to pollResultSnapshotMessageV3); anything else is a plain poll */
	pollType?: number
}

/**
 * Options for sending a sound sticker (the `stickerAudio` content
 * branch / sendSoundSticker socket method, 2.7.0 — D-1081-A). The
 * sticker must be a WebP: the branch writes the SHA-256 of the audio
 * into the WebP EXIF as "sound-sha256" (the link the receiving client
 * uses to pair sticker and sound) before uploading. The audio is
 * uploaded as OGG/Opus and attached to the sticker message as its
 * nested audioMessage (StickerMessage field 26).
 */
export type SoundStickerOptions = {
	/** The sticker image — must resolve to WebP bytes. */
	sticker: WAMediaUpload
	/** The sound — uploaded with mimetype 'audio/ogg; codecs=opus'. */
	audio: WAMediaUpload
	/** Optionally tell the duration of the audio, in seconds. */
	seconds?: number
	/**
	 * AunuBaileys (2.9.0, D-1081-A facet): forward as `ptt` on the
	 * nested audioMessage — without it the generic waveform
	 * processing (gated on `ptt === true`) never runs for the
	 * sound-sticker audio. Unset keeps the previous behaviour.
	 */
	ptt?: boolean
	/**
	 * AunuBaileys (2.9.0, D-1081-A facet): cap on the effective
	 * audio duration in seconds (the explicit `seconds`, or the
	 * auto-computed duration when `seconds` is unset). Exceeding
	 * it is a Boom 400 before the message is built. Unset means
	 * no cap.
	 */
	maxSeconds?: number
	/** JIDs to mention via the sticker's contextInfo. */
	mentions?: string[]
}

export type PollVoteOptions = {
	/** Key of the poll creation message being voted on. */
	pollCreationMessageKey: WAMessageKey
	/** messageSecret of the poll creation message — the vote's enc key. */
	pollEncKey: Uint8Array
	/** Option names the voter selected (sha256-hashed before encrypting). */
	selectedOptions: string[]
	/** Normalised JID of the poll creator — deviceless, @lid or @s.whatsapp.net. */
	pollCreatorJid: string
	/** Normalised JID of the voter — deviceless, same addressing mode as the creator. */
	voterJid: string
}

/**
 * One native-flow button of an `interactive` content (the
 * `aunuCard` / InteractiveBuilder shape). `icon`, when present, is
 * upper-cased into the buttonParamsJson at build time.
 */
export type InteractiveMessageButton = {
	name?: string
	buttonParamsJson?: string
	icon?: string
}

/**
 * Content of the `interactive` branch (native-flow / card messages,
 * restored in 2.7.1 — HB-500). Mirrors the v6 construction: `body` /
 * `footer` objects win over the `text` / `footerText` shorthands;
 * `carousel` switches the payload from a single nativeFlowMessage
 * to a carouselMessage.
 */
export type InteractiveMessageContent = {
	body?: { text?: string }
	/** shorthand for body: { text } */
	text?: string
	footer?: { text?: string }
	/** shorthand for footer: { text } */
	footerText?: string
	header?: waproto.Message.InteractiveMessage.IHeader
	contextInfo?: waproto.IContextInfo
	buttons?: InteractiveMessageButton[]
	carousel?: {
		header?: waproto.Message.InteractiveMessage.IHeader
		/** shorthand header: { title, hasMediaAttachment, imageMessage } */
		title?: string
		imageMessage?: waproto.Message.IImageMessage
		body?: string
		footer?: string
		buttons?: InteractiveMessageButton[]
	}[]
	messageParamsJson?: string
}

export type AnyMessageContent = (
	| AnyRegularMessageContent
	| {
			forward: WAMessage
			force?: boolean
	  }
	| {
			/** Delete your message or anyone's message in a group (admin required) */
			delete: WAMessageKey
	  }
	| {
			disappearingMessagesInChat: boolean | number
	  }
	| {
			limitSharing: boolean
	  }
	| {
			/** AunuBaileys: vote on a poll — encrypted via encryptPollVote (2.5.0 delta, run-0962) */
			pollVote: PollVoteOptions
	  }
	| {
			/** AunuBaileys: send a poll result snapshot (2.7.0, HB-491) */
			pollResult: PollResultOptions
	  }
	| {
			/** AunuBaileys: send a sound sticker — sticker with a nested audio message (2.7.0, D-1081-A) */
			stickerAudio: SoundStickerOptions
	  }
	| {
			/** AunuBaileys: send a sticker pack (cover + stickers) */
			stickerPack: StickerPackInfo
	  }
	| {
			/** AunuBaileys: send a sticker pack, flat form (cover + stickers) */
			stickers: StickerPackStickerInfo[]
			cover: WAMediaUpload
			name?: string
			publisher?: string
			description?: string
	  }
	| {
			/** AunuBaileys: interactive / native-flow message (restored 2.7.1, HB-500) */
			interactive: InteractiveMessageContent
	  }
	| {
			/** AunuBaileys: A2UI widget message (restored 2.7.1, HB-500) — an AunuA2UI instance or a built widget payload */
			a2ui: unknown
			/** A2UI payload type (default 'im_a2ui') */
			a2uiType?: string
			/** wrap the payload in a createSurface envelope (default true) */
			a2uiWrapped?: boolean
			/** drop the surrounding bubble so the widget is the whole message */
			singleScreen?: boolean
			text?: string
			footer?: string
	  }
) & {
	/** AunuBaileys: mark the message with the AI label (private chats only) */
	ai?: boolean
	/** AunuBaileys: force the <biz> binary node onto the relayed stanza */
	secureMetaServiceLabel?: boolean
}

export type GroupMetadataParticipants = Pick<GroupMetadata, 'participants'>

type MinimalRelayOptions = {
	/** override the message ID with a custom provided string */
	messageId?: string
	/** should we use group metadata cache, or fetch afresh from the server; default assumed to be "true" */
	useCachedGroupMetadata?: boolean
}

export type MessageRelayOptions = MinimalRelayOptions & {
	/** only send to a specific participant; used when a message decryption fails for a single user */
	participant?: { jid: string; count: number }
	/** force the <biz> binary node onto the stanza (secureMetaServiceLabel content flag) */
	addBizAttributes?: boolean
	/** additional attributes to add to the WA binary node */
	additionalAttributes?: { [_: string]: string }
	additionalNodes?: BinaryNode[]
	/** should we use the devices cache, or fetch afresh from the server; default assumed to be "true" */
	useUserDevicesCache?: boolean
	/** jid list of participants for status@broadcast */
	statusJidList?: string[]
}

export type MiscMessageGenerationOptions = MinimalRelayOptions & {
	/** optional, if you want to manually set the timestamp of the message */
	timestamp?: Date
	/** the message you want to quote */
	quoted?: WAMessage
	/** disappearing messages settings */
	ephemeralExpiration?: number | string
	/** timeout for media upload to WA server */
	mediaUploadTimeoutMs?: number
	/** jid list of participants for status@broadcast */
	statusJidList?: string[]
	/** backgroundcolor for status */
	backgroundColor?: string
	/** font type for status */
	font?: number
	/** if it is broadcast */
	broadcast?: boolean
}
export type MessageGenerationOptionsFromContent = MiscMessageGenerationOptions & {
	userJid: string
	/** AunuBaileys (2.5.0, Kage LID addressing): the own LID identity, when the own account has one — lets generateWAMessageFromContent resolve the own participant via getMeParticipant/getQuotedParticipant in LID contexts. */
	userJidLid?: string
}

export type WAMediaUploadFunction = (
	encFilePath: string,
	opts: { fileEncSha256B64: string; mediaType: MediaType; timeoutMs?: number }
) => Promise<{ mediaUrl: string; directPath: string; meta_hmac?: string; ts?: number; fbid?: number }>

export type MediaGenerationOptions = {
	logger?: ILogger
	mediaTypeOverride?: MediaType
	upload: WAMediaUploadFunction
	/** cache media so it does not have to be uploaded again */
	mediaCache?: CacheStore

	mediaUploadTimeoutMs?: number

	options?: RequestInit

	backgroundColor?: string

	font?: number
}
export type MessageContentGenerationOptions = MediaGenerationOptions & {
	getUrlInfo?: (text: string) => Promise<WAUrlInfo | undefined>
	getProfilePicUrl?: (jid: string, type: 'image' | 'preview') => Promise<string | undefined>
	getCallLink?: (type: 'audio' | 'video', event?: { startTime: number }) => Promise<string | undefined>
	jid?: string
}
export type MessageGenerationOptions = MessageContentGenerationOptions & MessageGenerationOptionsFromContent

/**
 * Type of message upsert
 * 1. notify => notify the user, this message was just received
 * 2. append => append the message to the chat history, no notification required
 */
export type MessageUpsertType = 'append' | 'notify'

export type MessageUserReceipt = waproto.IUserReceipt

export type WAMessageUpdate = { update: Partial<WAMessage>; key: WAMessageKey }

export type WAMessageCursor = { before: WAMessageKey | undefined } | { after: WAMessageKey | undefined }

export type MessageUserReceiptUpdate = { key: WAMessageKey; receipt: MessageUserReceipt }

export type MediaDecryptionKeyInfo = {
	iv: Uint8Array
	cipherKey: Uint8Array
	macKey?: Uint8Array
}

export type MinimalMessage = Pick<WAMessage, 'key' | 'messageTimestamp'>

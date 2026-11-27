import { waproto } from '../../WAProto/index.js';
/** Builder tombol interaktif (native flow). Alias: Buttons, ButtonBuilder. */
export declare class Button {
    constructor();
    title(t: any): this;
    body(t: any): this;
    footer(t: any): this;
    /** Tombol balasan cepat. */
    reply(id: any, text: any): this;
    /** Tombol buka tautan. */
    url(text: any, url: any): this;
    /** Tombol salin teks/kode. */
    copy(text: any, code: any): this;
    /** Tombol telepon. */
    call(text: any, phoneNumber: any): this;
    build(): {
        interactive: {
            text: any;
            footerText: any;
            header: {
                title: any;
                hasMediaAttachment: boolean;
            } | undefined;
            buttons: any;
        };
    };
}
/** Builder daftar pilihan (single_select) + tombol lanjutan. Alias: ListButton. */
export declare class ButtonV2 {
    constructor();
    body(t: any): this;
    footer(t: any): this;
    /** Satu tombol daftar berisi sections/rows. */
    list(buttonText: any, sections: any): this;
    reply(id: any, text: any): this;
    url(text: any, url: any): this;
    build(): {
        interactive: {
            text: any;
            footerText: any;
            buttons: any;
        };
    };
}
/** Builder carousel kartu geser. Alias: CarouselBuilder. */
export declare class Carousel {
    constructor();
    body(t: any): this;
    /** card: { title, body, footer?, imageMessage?, buttons?: Button instance | array nativeFlow } */
    card(card: any): this;
    build(): {
        interactive: {
            text: any;
            carousel: any;
        };
    };
}
/** Builder respons kaya ala Meta AI (AIRichResponseMessage). Alias: AiRich, RichResponse. */
export declare class AIRich {
    constructor();
    text(t: any): this;
    code(code: any, language?: string): this;
    latex(t: any): this;
    /** table: proto tableMetadata mentah { title, rows: [...] } */
    table(table: any): this;
    raw(sub: any): this;
    build(): {
        aiRich: {
            submessages: any;
        };
    };
}
/**
 * AunuBaileys (2.8.0, D-1108): AI rich-tag card — a rich response
 * tagged as coming from a named AI model. The envelope is a
 * botForwardedMessage around a richResponseMessage, with the tag
 * in messageContextInfo.botMetadata: modelMetadata.modelNameOverride
 * names the model, invokerJid names who invoked it, and
 * capabilityMetadata.capabilities ("caps") lists the bot
 * capabilities the card claims. Caps accept BotCapabilityType enum
 * names ('RICH_RESPONSE_TABLE', ...) or raw numbers; an unknown
 * name is a Boom 400, never a silent drop. Returns the raw Message
 * proto object — send it via relayMessage (sock.aunuSendAIRichTagCard
 * does exactly that).
 */
export declare const buildAIRichTagCard: (spec?: {}) => {
    messageContextInfo: {
        botMetadata: {};
    };
    botForwardedMessage: {
        message: {
            richResponseMessage: {
                submessages: any;
                messageType: waproto.AIRichResponseMessageType;
                contextInfo: {
                    forwardingScore: number;
                    isForwarded: boolean;
                    forwardedAiBotMessageInfo: {
                        botJid: any;
                    };
                    forwardOrigin: waproto.ContextInfo.ForwardOrigin;
                };
            };
        };
    };
};
/** Helper statis campuran. Alias: Tools. */
export declare class Toolkit {
    static quickReply(id: any, text: any): {
        name: any;
        buttonParamsJson: string;
    };
    static urlButton(text: any, url: any): {
        name: any;
        buttonParamsJson: string;
    };
    static copyButton(text: any, code: any): {
        name: any;
        buttonParamsJson: string;
    };
    static callButton(text: any, phoneNumber: any): {
        name: any;
        buttonParamsJson: string;
    };
    static listSection(title: any, rows: any): {
        title: any;
        rows: any;
    };
    /** Ubah daftar {id, title, description} menjadi satu tombol single_select. */
    static listButton(text: any, title: any, rows: any): {
        name: any;
        buttonParamsJson: string;
    };
}
export declare const Buttons: typeof Button;
export declare const ButtonBuilder: typeof Button;
export declare const ListButton: typeof ButtonV2;
export declare const CarouselBuilder: typeof Carousel;
export declare const AiRich: typeof AIRich;
export declare const RichResponse: typeof AIRich;
export declare const Tools: typeof Toolkit;
//# sourceMappingURL=builders.d.ts.map
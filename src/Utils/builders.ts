// @ts-nocheck
// AunuBaileys P2c port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
/**
 * Rich message builders khas AunuBaileys — API chainable untuk tombol,
 * carousel, dan respons kaya ala Meta AI. Hasil build() adalah
 * AnyMessageContent yang siap dikirim via sock.sendMessage().
 */
const nf = (name, params) => ({ name, buttonParamsJson: JSON.stringify(params) });

/** Builder tombol interaktif (native flow). Alias: Buttons, ButtonBuilder. */
export class Button {
    constructor() {
        this._text = '';
        this._footer = '';
        this._title = '';
        this._buttons = [];
    }
    title(t) { this._title = t; return this; }
    body(t) { this._text = t; return this; }
    footer(t) { this._footer = t; return this; }
    /** Tombol balasan cepat. */
    reply(id, text) { this._buttons.push(nf('quick_reply', { display_text: text, id: String(id) })); return this; }
    /** Tombol buka tautan. */
    url(text, url) { this._buttons.push(nf('cta_url', { display_text: text, url, merchant_url: url })); return this; }
    /** Tombol salin teks/kode. */
    copy(text, code) { this._buttons.push(nf('cta_copy', { display_text: text, copy_code: code, id: 'copy' })); return this; }
    /** Tombol telepon. */
    call(text, phoneNumber) { this._buttons.push(nf('cta_call', { display_text: text, phone_number: phoneNumber })); return this; }
    build() {
        return {
            interactive: {
                text: this._text,
                footerText: this._footer || undefined,
                header: this._title ? { title: this._title, hasMediaAttachment: false } : undefined,
                buttons: this._buttons
            }
        };
    }
}

/** Builder daftar pilihan (single_select) + tombol lanjutan. Alias: ListButton. */
export class ButtonV2 {
    constructor() {
        this._text = '';
        this._footer = '';
        this._buttons = [];
        this._sections = [];
    }
    body(t) { this._text = t; return this; }
    footer(t) { this._footer = t; return this; }
    /** Satu tombol daftar berisi sections/rows. */
    list(buttonText, sections) {
        this._buttons.push(nf('single_select', { title: buttonText, sections }));
        return this;
    }
    reply(id, text) { this._buttons.push(nf('quick_reply', { display_text: text, id: String(id) })); return this; }
    url(text, url) { this._buttons.push(nf('cta_url', { display_text: text, url, merchant_url: url })); return this; }
    build() {
        return { interactive: { text: this._text, footerText: this._footer || undefined, buttons: this._buttons } };
    }
}

/** Builder carousel kartu geser. Alias: CarouselBuilder. */
export class Carousel {
    constructor() {
        this._text = '';
        this._cards = [];
    }
    body(t) { this._text = t; return this; }
    /** card: { title, body, footer?, imageMessage?, buttons?: Button instance | array nativeFlow } */
    card(card) {
        let buttons = card.buttons || [];
        if (buttons instanceof Button) {
            buttons = buttons.build().interactive.buttons;
        }
        this._cards.push({ title: card.title, body: card.body || '', footer: card.footer, imageMessage: card.imageMessage, buttons });
        return this;
    }
    build() {
        return { interactive: { text: this._text, carousel: this._cards } };
    }
}

/** Builder respons kaya ala Meta AI (AIRichResponseMessage). Alias: AiRich, RichResponse. */
export class AIRich {
    constructor() {
        this._subs = [];
    }
    text(t) { this._subs.push({ type: 'text', text: t }); return this; }
    code(code, language = 'text') { this._subs.push({ type: 'code', code, language }); return this; }
    latex(t) { this._subs.push({ type: 'latex', text: t }); return this; }
    /** table: proto tableMetadata mentah { title, rows: [...] } */
    table(table) { this._subs.push({ type: 'table', table }); return this; }
    raw(sub) { this._subs.push({ raw: sub }); return this; }
    build() {
        return { aiRich: { submessages: this._subs } };
    }
}

/** Helper statis campuran. Alias: Tools. */
export class Toolkit {
    static quickReply(id, text) { return nf('quick_reply', { display_text: text, id: String(id) }); }
    static urlButton(text, url) { return nf('cta_url', { display_text: text, url, merchant_url: url }); }
    static copyButton(text, code) { return nf('cta_copy', { display_text: text, copy_code: code, id: 'copy' }); }
    static callButton(text, phoneNumber) { return nf('cta_call', { display_text: text, phone_number: phoneNumber }); }
    static listSection(title, rows) {
        return { title, rows: rows.map(r => ({ id: String(r.id), title: r.title, description: r.description || '' })) };
    }
    /** Ubah daftar {id, title, description} menjadi satu tombol single_select. */
    static listButton(text, title, rows) {
        return nf('single_select', { title: text, sections: [Toolkit.listSection(title, rows)] });
    }
}
export const Buttons = Button;
export const ButtonBuilder = Button;
export const ListButton = ButtonV2;
export const CarouselBuilder = Carousel;
export const AiRich = AIRich;
export const RichResponse = AIRich;
export const Tools = Toolkit;

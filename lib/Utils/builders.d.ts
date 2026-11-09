import type { AnyMessageContent } from '../Types';
export declare class Button {
    title(t: string): this; body(t: string): this; footer(t: string): this;
    reply(id: string, text: string): this; url(text: string, url: string): this;
    copy(text: string, code: string): this; call(text: string, phoneNumber: string): this;
    build(): AnyMessageContent;
}
export declare class ButtonV2 {
    body(t: string): this; footer(t: string): this;
    list(buttonText: string, sections: unknown[]): this;
    reply(id: string, text: string): this; url(text: string, url: string): this;
    build(): AnyMessageContent;
}
export declare class Carousel {
    body(t: string): this; card(card: Record<string, unknown>): this;
    build(): AnyMessageContent;
}
export declare class AIRich {
    text(t: string): this; code(code: string, language?: string): this;
    latex(t: string): this; table(table: unknown): this; raw(sub: unknown): this;
    build(): AnyMessageContent;
}
export declare class Toolkit {
    static quickReply(id: string, text: string): unknown;
    static urlButton(text: string, url: string): unknown;
    static copyButton(text: string, code: string): unknown;
    static callButton(text: string, phoneNumber: string): unknown;
    static listSection(title: string, rows: { id: string; title: string; description?: string }[]): unknown;
    static listButton(text: string, title: string, rows: { id: string; title: string; description?: string }[]): unknown;
}
export { Button as Buttons, Button as ButtonBuilder, ButtonV2 as ListButton, Carousel as CarouselBuilder, AIRich as AiRich, AIRich as RichResponse, Toolkit as Tools };

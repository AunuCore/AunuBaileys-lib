/**
 * AunuBaileys (2.7.0, D-1096-A): renderWhatsApp — render a small
 * formatted-text AST to a WhatsApp markdown string, collecting the
 * JIDs of every mention node on the way out (for use as
 * `mentionedJid` on the enclosing message).
 *
 * Node kinds:
 * - text:    plain text, emitted as-is
 * - bold:    children wrapped in *...*
 * - italic:  children wrapped in _..._
 * - code:    text wrapped in `...`
 * - link:    `label (url)`, or the bare url when the label is absent
 *            or identical to the url
 * - mention: `@<user>` from the JID, and the JID is collected
 *
 * Wrap rule (bold / italic / code): WhatsApp only honours a marker
 * pair glued to text, so leading and trailing whitespace of the
 * wrapped content is moved OUTSIDE the markers; a node whose content
 * is empty or all whitespace is emitted unwrapped, as-is.
 */
export type WhatsAppTextNode = {
    type: 'text';
    text: string;
} | {
    type: 'bold';
    children: WhatsAppTextNode[];
} | {
    type: 'italic';
    children: WhatsAppTextNode[];
} | {
    type: 'code';
    text: string;
} | {
    type: 'link';
    url: string;
    label?: string;
} | {
    type: 'mention';
    jid: string;
};
export type RenderWhatsAppResult = {
    text: string;
    /** Mentioned JIDs, deduplicated, in first-appearance order. */
    mentions: string[];
};
export declare const renderWhatsApp: (nodes: WhatsAppTextNode | WhatsAppTextNode[]) => RenderWhatsAppResult;
//# sourceMappingURL=render-whatsapp.d.ts.map
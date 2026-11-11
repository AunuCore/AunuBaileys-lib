/**
 * AunuBaileys: dukungan tabel & blok kode lewat richResponseMessage
 * (dibungkus botForwardedMessage). Diadaptasi dari @itsliaaa/baileys —
 * kredit untuk pembuat asli dipertahankan sesuai catatan mereka.
 * Deviasi AunuBaileys: fallback link donasi sumber TIDAK ikut dibawa;
 * tautan tanpa url dilewati, label kosong tetap kosong.
 */
import { randomUUID } from 'node:crypto';
import { LEXER_REGEX, TEXT_ENCODER } from '../Defaults/index.js';
import { LANGUAGE_KEYWORDS } from '../WABinary/constants.js';
import { CodeHighlightType, RichSubMessageType } from '../Types/RichType.js';
import { proto } from '../../WAProto/index.js';
import { unixTimestampSeconds } from './generics.js';
const NOOP = new Set([]);
export const tokenizeCode = (code, language = 'javascript') => {
    const keywords = LANGUAGE_KEYWORDS[language] || NOOP;
    const blocks = [];
    LEXER_REGEX.lastIndex = 0;
    let match;
    while ((match = LEXER_REGEX.exec(code)) !== null) {
        if (match[1]) {
            blocks.push({ highlightType: CodeHighlightType.COMMENT, codeContent: match[1] });
        }
        else if (match[2]) {
            blocks.push({ highlightType: CodeHighlightType.STRING, codeContent: match[2] });
        }
        else if (match[3]) {
            blocks.push({
                highlightType: keywords.has(match[3]) ? CodeHighlightType.KEYWORD : CodeHighlightType.METHOD,
                codeContent: match[3],
            });
        }
        else if (match[4]) {
            blocks.push({
                highlightType: keywords.has(match[4]) ? CodeHighlightType.KEYWORD : CodeHighlightType.DEFAULT,
                codeContent: match[4],
            });
        }
        else if (match[5]) {
            blocks.push({ highlightType: CodeHighlightType.NUMBER, codeContent: match[5] });
        }
        else {
            blocks.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: match[6] });
        }
    }
    return blocks;
};
// Lia@Changes 09-04-26 --- Inject buffer into unifiedResponse.data to support proper rendering of rich messages (ex: tables and code blocks)
export const toUnified = (submessages, uuid) => ({
    response_id: uuid || randomUUID(),
    sections: submessages.map((submessage, index) => {
        switch (submessage.messageType) {
            case RichSubMessageType.CODE:
                const codeMetadata = submessage.codeMetadata;
                return {
                    view_model: {
                        primitive: {
                            language: codeMetadata.codeLanguage,
                            code_blocks: codeMetadata.codeBlocks.map((block) => ({ content: block.codeContent, type: CodeHighlightType[block.highlightType] })),
                            __typename: 'GenAICodeUXPrimitive'
                        },
                        __typename: 'GenAISingleLayoutViewModel'
                    }
                };
            case RichSubMessageType.CONTENT_ITEMS:
                return {};
            case RichSubMessageType.INLINE_IMAGE:
                return {};
            case RichSubMessageType.LATEX:
                return {};
            case RichSubMessageType.TABLE:
                const tableMetadata = submessage.tableMetadata;
                return {
                    view_model: {
                        primitive: {
                            title: tableMetadata.title,
                            rows: tableMetadata.rows.map((row) => ({
                                is_header: row.isHeading,
                                cells: row.items,
                                markdown_cells: row.items.map((item) => ({ text: item }))
                            })),
                            __typename: 'GenATableUXPrimitive'
                        },
                        __typename: 'GenAISingleLayoutViewModel'
                    }
                };
            case RichSubMessageType.TEXT:
                return {
                    view_model: {
                        primitive: {
                            text: submessage.messageText,
                            inline_entities: submessage.inlineEntities || [],
                            __typename: 'GenAIMarkdownTextUXPrimitive'
                        },
                        __typename: 'GenAISingleLayoutViewModel'
                    }
                };
        }
        return submessage;
    })
});
// AunuBaileys: seksi layar HTML (primitive FOAHtmlPrimitiveDemoDONOTUSE milik
// klien WhatsApp) untuk unified response — payload HTML mentah + daftar
// sumber tepercaya opsional. EKSPERIMENTAL (keputusan Aunu 11 Nov 2026):
// apakah klien WhatsApp penerima merender HTML/JS-nya bergantung versi
// klien dan tidak dijamin library.
export const buildFoaHtmlSection = (html, trustedSources = []) => ({
    __typename: 'GenAIUnifiedResponseSection',
    view_model: {
        __typename: 'GenAISingleLayoutViewModel',
        primitive: {
            __typename: 'FOAHtmlPrimitiveDemoDONOTUSE',
            trusted_sources: Array.isArray(trustedSources) ? trustedSources : [],
            payload: String(html ?? '').trim()
        }
    }
});
// AunuBaileys: pesan HTML mandiri — rich response yang unified-nya hanya
// berisi seksi HTML (submessages kosong, mengikuti bentuk sumbernya).
export const prepareHtmlMessage = (content = {}) => prepareRichResponseMessage({
    html: content.html,
    trustedSources: content.trustedSources
});
// AunuBaileys: layar HTML interaktif sebagai embedded screen di unified
// response — primitive GenAIaeacdsnwHtmlPrimitive di dalam tab
// FOAIDNixelButtonSheets; permukaan mini-app tempat HTML+JS interaktif
// (game dsb.) tinggal, berbeda dari seksi FOA pada pesan HTML biasa.
// EKSPERIMENTAL (keputusan Aunu 11 Nov 2026): render bergantung klien.
export const buildRichHtmlScreen = (options = {}) => {
    const { html = '', trustedSources = [], url = '', title = 'Preview', tabHeader = 'HTML', tabs } = options;
    const tabItems = Array.isArray(tabs) && tabs.length
        ? tabs
        : [{ id: 'tab_0', tab_header: tabHeader, html }];
    const embeddedTabs = tabItems.map((tab, index) => ({
        id: tab.id || `tab_${index}`,
        tab_header: tab.tab_header || tab.title || `HTML ${index + 1}`,
        sections: [{
                __typename: 'GenAIUnifiedResponseSection',
                view_model: {
                    __typename: 'GenAISingleLayoutViewModel',
                    primitive: {
                        __typename: 'GenAIaeacdsnwHtmlPrimitive',
                        payload: String(tab.html ?? tab.payload ?? html).trim(),
                        url: tab.url || url,
                        trusted_sources: tab.trustedSources || trustedSources
                    }
                }
            }],
        step_entries: []
    }));
    return {
        title,
        embeddedScreen: {
            title,
            content: [{
                    __typename: 'FOAIDNixelButtonSheets',
                    tabs: embeddedTabs
                }]
        }
    };
};
// AunuBaileys: pesan layar HTML interaktif — unified membawa embedded_screens,
// submessage-nya satu teks judul bergaya kutipan.
export const prepareRichHtmlMessage = (options = {}) => {
    const { title, embeddedScreen } = buildRichHtmlScreen(options);
    const unified = {
        response_id: randomUUID(),
        sections: [{
                view_model: {
                    primitive: { text: `> ${title}`, __typename: 'GenAIMarkdownTextUXPrimitive' },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            }],
        embedded_screens: [embeddedScreen]
    };
    const richResponseMessage = proto.AIRichResponseMessage.create({
        messageType: proto.AIRichResponseMessage.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
        submessages: [{ messageType: RichSubMessageType.TEXT, messageText: `> ${title}` }],
        unifiedResponse: { data: TEXT_ENCODER.encode(JSON.stringify(unified)) },
        contextInfo: {
            isForwarded: true,
            forwardingScore: 1,
            forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
            forwardOrigin: 4
        }
    });
    return wrapToBotForwardedMessage(richResponseMessage);
};
export const prepareRichResponseMessage = (content) => {
    if (content.richHtml) {
        return prepareRichHtmlMessage(content.richHtml);
    }
    let { alignment, code, contentText, disclaimerText, footerText, headerText, imageText, inlineImage, inlineVideo, items, language, latex, links, noHeading, posts, products, suggested, richResponse, table, tapLinkUrl, title } = content;
    let submessages = [];
    if (Array.isArray(richResponse)) {
        submessages = richResponse.map((submessage) => {
            if (submessage.text) {
                return {
                    messageType: RichSubMessageType.TEXT,
                    messageText: submessage.text,
                    inlineEntities: submessage.inlineEntities
                };
            }
            else if (submessage.code) {
                return {
                    messageType: RichSubMessageType.CODE,
                    codeMetadata: {
                        codeLanguage: submessage.language,
                        codeBlocks: submessage.code
                    }
                };
            }
            else if (submessage.items) {
                return {
                    messageType: RichSubMessageType.CONTENT_ITEMS,
                    contentItemsMetadata: {
                        itemsMetadata: submessage.items,
                        contentType: proto.AIRichResponseMessage.AIRichResponseContentItemsMetadata.ContentType.CAROUSEL
                    }
                };
            }
            else if (submessage.inlineImage) {
                return {
                    messageType: RichSubMessageType.INLINE_IMAGE,
                    imageMetadata: {
                        imageUrl: submessage.inlineImage,
                        imageText: submessage.imageText,
                        alignment: submessage.alignment,
                        tapLinkUrl: submessage.tapLinkUrl
                    }
                };
            }
            else if (submessage.inlineVideo) {
                return {
                    messageType: RichSubMessageType.TEXT,
                    messageText: 'INLINE_VIDEO'
                };
            }
            else if (submessage.latex) {
                return {
                    messageType: RichSubMessageType.LATEX,
                    latexMetadata: {
                        text: submessage.text,
                        expressions: submessage.latex
                    }
                };
            }
            else if (submessage.posts) {
                return {
                    messageType: RichSubMessageType.TEXT,
                    messageText: 'POSTS'
                };
            }
            else if (submessage.products) {
                return {
                    messageType: RichSubMessageType.TEXT,
                    messageText: 'PRODUCTS'
                };
            }
            else if (submessage.suggested) {
                return {
                    messageType: RichSubMessageType.TEXT,
                    messageText: 'SUGGESTED_PROMPT'
                };
            }
            else if (submessage.table) {
                return {
                    messageType: RichSubMessageType.TABLE,
                    tableMetadata: {
                        title: submessage.title,
                        rows: submessage.table
                    }
                };
            }
            return submessage;
        });
    }
    else {
        if (headerText) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: headerText
            });
        }
        if (contentText) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: contentText
            });
        }
        if (code) {
            language || (language = 'javascript');
            submessages.push({
                messageType: RichSubMessageType.CODE,
                codeMetadata: {
                    codeLanguage: language,
                    codeBlocks: tokenizeCode(code, language)
                }
            });
        }
        if (items) {
            submessages.push({
                messageType: RichSubMessageType.CONTENT_ITEMS,
                contentItemsMetadata: {
                    itemsMetadata: items,
                    contentType: proto.AIRichResponseMessage.AIRichResponseContentItemsMetadata.ContentType.CAROUSEL
                }
            });
        }
        if (inlineImage) {
            submessages.push({
                messageType: RichSubMessageType.INLINE_IMAGE,
                imageMetadata: {
                    imageUrl: inlineImage,
                    imageText,
                    alignment,
                    tapLinkUrl
                }
            });
        }
        if (inlineVideo) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: 'INLINE_VIDEO'
            });
        }
        if (latex) {
            submessages.push({
                messageType: RichSubMessageType.LATEX,
                latexMetadata: {
                    text,
                    expressions: latex
                }
            });
        }
        if (links) {
            links.forEach((linkField, index) => {
                const prefix = 'SS_' + index;
                if (!linkField.url) {
                    return;
                }
                const url = linkField.url;
                const sources = linkField.sources?.map((sourceField) => ({
                    source_type: 'THIRD_PARTY',
                    source_display_name: sourceField.displayName || '',
                    source_subtitle: sourceField.subtitle || '',
                    source_url: sourceField.url || url
                }));
                submessages.push({
                    messageType: RichSubMessageType.TEXT,
                    messageText: linkField.text + ` {{${prefix}}}¹{{/${prefix}}} `,
                    inlineEntities: [{
                            key: prefix,
                            metadata: {
                                reference_id: index + 1,
                                reference_url: url,
                                reference_title: linkField.title || '',
                                reference_display_name: linkField.displayName || '',
                                sources: sources || [],
                                __typename: 'GenAISearchCitationItem'
                            }
                        }]
                });
            });
        }
        if (posts) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: 'POSTS'
            });
        }
        if (products) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: 'PRODUCTS'
            });
        }
        if (suggested) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: 'SUGGESTED_PROMPT'
            });
        }
        if (table) {
            submessages.push({
                messageType: RichSubMessageType.TABLE,
                tableMetadata: {
                    title,
                    rows: table.map((items, index) => ({
                        isHeading: !noHeading && index == 0,
                        items
                    }))
                }
            });
        }
        if (footerText) {
            submessages.push({
                messageType: RichSubMessageType.TEXT,
                messageText: footerText
            });
        }
    }
    const uuid = randomUUID();
    const extraSections = [];
    if (content.html) {
        extraSections.push(buildFoaHtmlSection(content.html, content.trustedSources));
    }
    const unified = toUnified(submessages, uuid);
    if (extraSections.length) {
        unified.sections.push(...extraSections);
    }
    const richResponseMessage = proto.AIRichResponseMessage.create({
        submessages,
        messageType: proto.AIRichResponseMessage.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
        unifiedResponse: {
            data: TEXT_ENCODER.encode(JSON.stringify(unified)) // Lia@Note 25-04-26 --- Expects "ArrayBufferLike"
        },
        contextInfo: {
            isForwarded: true,
            forwardingScore: 1,
            forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
            forwardOrigin: 4
        }
    });
    // AunuBaileys: disclaimerText/botResponseId sumber menempel di botMetadata,
    // yang tidak terwakili di proto 6.7.24 — keduanya tidak dibuat di sini.
    void disclaimerText;
    return wrapToBotForwardedMessage(richResponseMessage);
};
// AunuBaileys: proto 6.7.24 TIDAK punya field botForwardedMessage maupun
// BotMetadata.verificationMetadata/botResponseId — rich response di basis ini
// dikirim sebagai field richResponseMessage langsung pada Message (bentuk yang
// sama dengan cabang aiRich yang sudah ada), jadi pembungkusnya menyesuaikan.
export const wrapToBotForwardedMessage = (richResponseMessage) => ({
    richResponseMessage
});

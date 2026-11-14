// @ts-nocheck
// AunuBaileys P2c port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
/**
 * AunuBaileys: dukungan tabel & blok kode lewat richResponseMessage
 * (dibungkus botForwardedMessage). Diadaptasi dari @itsliaaa/baileys —
 * kredit untuk pembuat asli dipertahankan sesuai catatan mereka.
 * Deviasi AunuBaileys: fallback link donasi sumber TIDAK ikut dibawa;
 * tautan tanpa url dilewati, label kosong tetap kosong.
 */
import { randomUUID } from 'node:crypto';
import { proto } from '../../WAProto/index.js';
import { unixTimestampSeconds } from './generics.js';
// AunuBaileys v7 adaptation (P2c): three of this module's v6 imports have
// no counterpart in the v7 tree yet, so their v6 definitions are carried
// inline below, verbatim — TEXT_ENCODER / LEXER_REGEX from v6
// lib/Defaults/index.js, LANGUAGE_KEYWORDS (+ its keyword sets) from v6
// lib/WABinary/constants.js, and the CodeHighlightType /
// RichSubMessageType enums from v6 lib/Types/RichType.js (bidirectional,
// as the compiled TS enums were; toUnified reverse-looks-up
// CodeHighlightType by number).
const TEXT_ENCODER = new TextEncoder();
const LEXER_REGEX = /(\/\/.*|\/\*[\s\S]*?\*\/|#.*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[\s\S]*?`)|(\b[a-zA-Z_]\w*\b)(?=\s*\()|(\b[a-zA-Z_]\w*\b)|(\b\d+(?:\.\d+)?\b)|(\s+|[^\w\s]+)/g;
const CodeHighlightType = { 0: 'DEFAULT', 1: 'KEYWORD', 2: 'METHOD', 3: 'STRING', 4: 'NUMBER', 5: 'COMMENT', DEFAULT: 0, KEYWORD: 1, METHOD: 2, STRING: 3, NUMBER: 4, COMMENT: 5 };
const RichSubMessageType = { 0: 'UNKNOWN', 1: 'GRID_IMAGE', 2: 'TEXT', 3: 'INLINE_IMAGE', 4: 'TABLE', 5: 'CODE', 6: 'DYNAMIC', 7: 'MAP', 8: 'LATEX', 9: 'CONTENT_ITEMS', UNKNOWN: 0, GRID_IMAGE: 1, TEXT: 2, INLINE_IMAGE: 3, TABLE: 4, CODE: 5, DYNAMIC: 6, MAP: 7, LATEX: 8, CONTENT_ITEMS: 9 };
// AunuBaileys: tabel kata kunci untuk pewarnaan kode rich response (dari @itsliaaa/baileys)
const CPP_KEYWORDS = new Set([
    'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor', 'bool', 'break', 'case',
    'catch', 'char', 'class', 'compl', 'concept', 'const', 'consteval', 'constexpr', 'constinit',
    'const_cast', 'continue', 'co_await', 'co_return', 'co_yield', 'decltype', 'default', 'delete',
    'do', 'double', 'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float',
    'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept',
    'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq', 'private', 'protected', 'public', 'register',
    'reinterpret_cast', 'requires', 'return', 'short', 'signed', 'sizeof', 'static', 'static_assert',
    'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local', 'throw', 'true', 'try',
    'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile',
    'wchar_t', 'while', 'xor', 'xor_eq'
]);
const CSS_KEYWORDS = new Set([
    'import', 'media', 'font-face', 'keyframes', 'supports', 'charset',
    'important', 'root', 'hover', 'active', 'focus', 'visited', 'before', 'after',
    'not', 'nth-child', 'first-child', 'last-child', 'only-child',
    'none', 'inherit', 'initial', 'unset', 'auto', 'transparent', 'currentcolor'
]);
const GO_KEYWORDS = new Set([
    'break', 'default', 'func', 'interface', 'select', 'case', 'defer', 'go', 'map', 'struct',
    'chan', 'else', 'goto', 'package', 'switch', 'const', 'fallthrough', 'if', 'range', 'type',
    'continue', 'for', 'import', 'return', 'var', 'true', 'false', 'nil'
]);
const HTML_KEYWORDS = new Set([
    'html', 'head', 'body', 'title', 'meta', 'link', 'script', 'style',
    'header', 'footer', 'main', 'section', 'article', 'aside', 'nav',
    'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'img',
    'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'thead', 'tbody',
    'form', 'input', 'button', 'select', 'textarea', 'label', 'option',
    'canvas', 'svg', 'iframe', 'video', 'audio', 'source'
]);
const JS_KEYWORDS = new Set([
    'import', 'export', 'from', 'default', 'as',
    'const', 'let', 'var', 'function', 'class', 'extends', 'new',
    'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
    'try', 'catch', 'finally', 'throw',
    'async', 'await', 'yield',
    'typeof', 'instanceof', 'in', 'of', 'delete', 'void',
    'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
    'this', 'super', 'static', 'get', 'set',
    'debugger', 'with'
]);
const PYTHON_KEYWORDS = new Set([
    'import', 'from', 'as', 'def', 'class', 'return', 'if', 'elif', 'else',
    'for', 'while', 'break', 'continue', 'try', 'except', 'finally', 'raise',
    'with', 'yield', 'lambda', 'pass', 'del', 'global', 'nonlocal', 'assert',
    'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'async', 'await',
    'self', 'print'
]);
const RUST_KEYWORDS = new Set([
    'as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern',
    'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match',
    'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self',
    'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe',
    'use', 'where', 'while', 'async', 'await', 'dyn',
    'abstract', 'become', 'box', 'do', 'final', 'macro',
    'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield',
    'try'
]);
const C_KEYWORDS = new Set([
    'auto', 'break', 'case', 'char', 'const', 'continue',
    'default', 'do', 'double', 'else', 'enum', 'extern',
    'float', 'for', 'goto', 'if', 'inline', 'int',
    'long', 'register', 'restrict', 'return', 'short',
    'signed', 'sizeof', 'static', 'struct', 'switch',
    'typedef', 'union', 'unsigned', 'void', 'volatile',
    'while',
    '_Alignas', '_Alignof', '_Atomic', '_Bool',
    '_Complex', '_Generic', '_Imaginary',
    '_Noreturn', '_Static_assert', '_Thread_local'
]);
const CSHARP_KEYWORDS = new Set([
    'abstract', 'as', 'base', 'bool', 'break', 'byte',
    'case', 'catch', 'char', 'checked', 'class',
    'const', 'continue', 'decimal', 'default',
    'delegate', 'do', 'double', 'else', 'enum',
    'event', 'explicit', 'extern', 'false', 'finally',
    'fixed', 'float', 'for', 'foreach', 'goto',
    'if', 'implicit', 'in', 'int', 'interface',
    'internal', 'is', 'lock', 'long', 'namespace',
    'new', 'null', 'object', 'operator', 'out',
    'override', 'params', 'private', 'protected',
    'public', 'readonly', 'ref', 'return', 'sbyte',
    'sealed', 'short', 'sizeof', 'stackalloc',
    'static', 'string', 'struct', 'switch',
    'this', 'throw', 'true', 'try', 'typeof',
    'uint', 'ulong', 'unchecked', 'unsafe',
    'ushort', 'using', 'virtual', 'void',
    'volatile', 'while',
    'async', 'await', 'record', 'init',
    'required', 'file', 'global', 'nameof',
    'var', 'dynamic', 'partial', 'yield',
    'from', 'where', 'select', 'group',
    'orderby', 'join', 'let', 'into',
    'equals', 'by', 'ascending', 'descending'
]);
const BASH_KEYWORDS = new Set([
    'if', 'then', 'else', 'elif', 'fi',
    'case', 'esac', 'for', 'while',
    'until', 'do', 'done', 'in',
    'function', 'select', 'time',
    'coproc',
    'echo', 'printf', 'read', 'cd',
    'pwd', 'exit', 'export', 'unset',
    'alias', 'unalias', 'source',
    'exec', 'eval', 'test', 'shift',
    'trap', 'wait', 'jobs', 'kill',
    'bg', 'fg', 'history', 'type',
    'ulimit', 'umask', 'set',
    'true', 'false'
]);
const CMD_KEYWORDS = new Set([
    'echo', 'set', 'if', 'else',
    'for', 'in', 'do', 'goto',
    'call', 'exit', 'shift',
    'pause', 'start', 'title',
    'cls', 'rem',
    'dir', 'copy', 'move', 'del',
    'mkdir', 'rmdir', 'type',
    'ren', 'tasklist', 'taskkill',
    'ping', 'ipconfig', 'netstat',
    'shutdown'
]);
const POWERSHELL_KEYWORDS = new Set([
    'function', 'filter', 'param',
    'begin', 'process', 'end',
    'if', 'else', 'elseif',
    'switch', 'foreach', 'for',
    'while', 'do', 'until',
    'break', 'continue', 'return',
    'throw', 'trap', 'try',
    'catch', 'finally',
    '$true', '$false', '$null',
    'Write-Host', 'Write-Output',
    'Get-Item', 'Set-Item',
    'Get-ChildItem', 'Remove-Item',
    'Copy-Item', 'Move-Item',
    'Test-Path', 'Invoke-Command'
]);
const LANGUAGE_KEYWORDS = {
    css: CSS_KEYWORDS,
    html: HTML_KEYWORDS,
    javascript: JS_KEYWORDS,
    typescript: JS_KEYWORDS,
    js: JS_KEYWORDS,
    ts: JS_KEYWORDS,
    python: PYTHON_KEYWORDS,
    py: PYTHON_KEYWORDS,
    go: GO_KEYWORDS,
    golang: GO_KEYWORDS,
    cpp: CPP_KEYWORDS,
    'c++': CPP_KEYWORDS,
    rust: RUST_KEYWORDS,
    rs: RUST_KEYWORDS,
    c: C_KEYWORDS,
    h: C_KEYWORDS,
    csharp: CSHARP_KEYWORDS,
    cs: CSHARP_KEYWORDS,
    bash: BASH_KEYWORDS,
    sh: BASH_KEYWORDS,
    zsh: BASH_KEYWORDS,
    cmd: CMD_KEYWORDS,
    bat: CMD_KEYWORDS,
    powershell: POWERSHELL_KEYWORDS,
    ps1: POWERSHELL_KEYWORDS
};
// AunuBaileys v7 adaptation (P2c): the v7 WAProto exposes the AIRich
// enums at the top level (proto.AIRichResponseMessageType /
// proto.AIRichResponseContentItemsMetadata.ContentType), where v6
// nested them under proto.AIRichResponseMessage.* — resolve either
// location; the enum VALUES are identical in both trees.
const AIRichResponseMessageType = proto.AIRichResponseMessageType || proto.AIRichResponseMessage.AIRichResponseMessageType;
const AIRichResponseContentType = (proto.AIRichResponseContentItemsMetadata && proto.AIRichResponseContentItemsMetadata.ContentType) || proto.AIRichResponseMessage.AIRichResponseContentItemsMetadata.ContentType;
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
// AunuBaileys (1.0.71): normalise a map submessage
// (AIRichResponseMapMetadata, proto submessage type 7 —
// RichSubMessageType.MAP). Accepts the full metadata shape or the
// {latitude, longitude} / {center: {...}} shorthands; annotations
// keep the proto's {annotationNumber, latitude, longitude, title,
// body} shape. Written from OUR OWN WAProto definition —
// @shanks-dev/baileys 0.1.2 (the only version on npm; 0.1.4 does not
// exist) ships no addMap to copy, and its message-builder numbering
// (text 2, code 5, table 4, reels 9, image 1) lines up with ours.
export const buildAunuMapMetadata = (map = {}) => {
    const center = map.center || {};
    const centerLatitude = map.centerLatitude ?? center.latitude ?? map.latitude;
    const centerLongitude = map.centerLongitude ?? center.longitude ?? map.longitude;
    return {
        centerLatitude,
        centerLongitude,
        latitudeDelta: map.latitudeDelta,
        longitudeDelta: map.longitudeDelta,
        annotations: Array.isArray(map.annotations) ? map.annotations.map((a, index) => ({
            annotationNumber: a.annotationNumber ?? index + 1,
            latitude: a.latitude,
            longitude: a.longitude,
            title: a.title,
            body: a.body
        })) : undefined,
        showInfoList: map.showInfoList
    };
};
// AunuBaileys (1.0.71): normalise an inline-image URL to the proto's
// IAIRichResponseImageURL object ({imagePreviewUrl, imageHighResUrl,
// sourceUrl}). A bare string used to survive prepareRichResponseMessage
// (proto .create() does not validate) and then fail at encode/send
// time; objects pass through untouched.
export const buildAunuImageUrl = (value) => {
    if (typeof value === 'string') {
        return { imagePreviewUrl: value, imageHighResUrl: value, sourceUrl: value };
    }
    return value;
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
            case RichSubMessageType.MAP:
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
        messageType: AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
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
    let { alignment, code, contentText, disclaimerText, footerText, headerText, imageText, inlineImage, inlineVideo, items, language, latex, links, map, noHeading, posts, products, suggested, richResponse, table, tapLinkUrl, title } = content;
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
                        contentType: AIRichResponseContentType.CAROUSEL
                    }
                };
            }
            else if (submessage.inlineImage) {
                return {
                    messageType: RichSubMessageType.INLINE_IMAGE,
                    imageMetadata: {
                        imageUrl: buildAunuImageUrl(submessage.inlineImage),
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
            else if (submessage.map) {
                return {
                    messageType: RichSubMessageType.MAP,
                    mapMetadata: buildAunuMapMetadata(submessage.map)
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
                    contentType: AIRichResponseContentType.CAROUSEL
                }
            });
        }
        if (inlineImage) {
            submessages.push({
                messageType: RichSubMessageType.INLINE_IMAGE,
                imageMetadata: {
                    imageUrl: buildAunuImageUrl(inlineImage),
                    imageText,
                    alignment,
                    tapLinkUrl
                }
            });
        }
        if (map) {
            submessages.push({
                messageType: RichSubMessageType.MAP,
                mapMetadata: buildAunuMapMetadata(map)
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
        messageType: AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
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
//# sourceMappingURL=rich-message-utils.js.map
import { Boom } from '@hapi/boom';
import { jidDecode } from '../WABinary/index.js';
const wrapMarkers = (marker, inner) => {
    const start = inner.length - inner.trimStart().length;
    const end = inner.trimEnd().length;
    if (start >= end) {
        // empty or all-whitespace content: markers would not bind to
        // any text, so the content goes out exactly as given
        return inner;
    }
    return inner.slice(0, start) + marker + inner.slice(start, end) + marker + inner.slice(end);
};
export const renderWhatsApp = (nodes) => {
    const mentions = [];
    const seenMentions = new Set();
    const renderNodes = (list) => list.map(renderNode).join('');
    const renderNode = (node) => {
        if (!node || typeof node !== 'object') {
            throw new Boom('renderWhatsApp: every node must be an object', { statusCode: 400 });
        }
        switch (node.type) {
            case 'text': {
                if (typeof node.text !== 'string') {
                    throw new Boom('renderWhatsApp: text node requires a text string', { statusCode: 400 });
                }
                return node.text;
            }
            case 'bold':
            case 'italic': {
                if (!Array.isArray(node.children)) {
                    throw new Boom(`renderWhatsApp: ${node.type} node requires a children array`, { statusCode: 400 });
                }
                return wrapMarkers(node.type === 'bold' ? '*' : '_', renderNodes(node.children));
            }
            case 'code': {
                if (typeof node.text !== 'string') {
                    throw new Boom('renderWhatsApp: code node requires a text string', { statusCode: 400 });
                }
                return wrapMarkers('`', node.text);
            }
            case 'link': {
                if (typeof node.url !== 'string' || !node.url) {
                    throw new Boom('renderWhatsApp: link node requires a url string', { statusCode: 400 });
                }
                if (typeof node.label !== 'undefined' && typeof node.label !== 'string') {
                    throw new Boom('renderWhatsApp: link label must be a string', { statusCode: 400 });
                }
                return node.label && node.label !== node.url ? `${node.label} (${node.url})` : node.url;
            }
            case 'mention': {
                const decoded = typeof node.jid === 'string' ? jidDecode(node.jid) : undefined;
                if (!decoded?.user) {
                    throw new Boom(`renderWhatsApp: mention node requires a valid JID, got ${String(node.jid)}`, {
                        statusCode: 400
                    });
                }
                if (!seenMentions.has(node.jid)) {
                    seenMentions.add(node.jid);
                    mentions.push(node.jid);
                }
                return `@${decoded.user}`;
            }
            default:
                throw new Boom(`renderWhatsApp: unknown node type ${String(node.type)}`, {
                    statusCode: 400
                });
        }
    };
    const list = Array.isArray(nodes) ? nodes : [nodes];
    return { text: renderNodes(list), mentions };
};
//# sourceMappingURL=render-whatsapp.js.map
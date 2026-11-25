import { Boom } from '@hapi/boom'
import { jidDecode } from '../WABinary'

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
export type WhatsAppTextNode =
	| { type: 'text'; text: string }
	| { type: 'bold'; children: WhatsAppTextNode[] }
	| { type: 'italic'; children: WhatsAppTextNode[] }
	| { type: 'code'; text: string }
	| { type: 'link'; url: string; label?: string }
	| { type: 'mention'; jid: string }

export type RenderWhatsAppResult = {
	text: string
	/** Mentioned JIDs, deduplicated, in first-appearance order. */
	mentions: string[]
}

const wrapMarkers = (marker: string, inner: string): string => {
	const start = inner.length - inner.trimStart().length
	const end = inner.trimEnd().length
	if (start >= end) {
		// empty or all-whitespace content: markers would not bind to
		// any text, so the content goes out exactly as given
		return inner
	}

	return inner.slice(0, start) + marker + inner.slice(start, end) + marker + inner.slice(end)
}

export const renderWhatsApp = (nodes: WhatsAppTextNode | WhatsAppTextNode[]): RenderWhatsAppResult => {
	const mentions: string[] = []
	const seenMentions = new Set<string>()

	const renderNodes = (list: WhatsAppTextNode[]): string => list.map(renderNode).join('')

	const renderNode = (node: WhatsAppTextNode): string => {
		if (!node || typeof node !== 'object') {
			throw new Boom('renderWhatsApp: every node must be an object', { statusCode: 400 })
		}

		switch (node.type) {
			case 'text': {
				if (typeof node.text !== 'string') {
					throw new Boom('renderWhatsApp: text node requires a text string', { statusCode: 400 })
				}

				return node.text
			}

			case 'bold':
			case 'italic': {
				if (!Array.isArray(node.children)) {
					throw new Boom(`renderWhatsApp: ${node.type} node requires a children array`, { statusCode: 400 })
				}

				return wrapMarkers(node.type === 'bold' ? '*' : '_', renderNodes(node.children))
			}

			case 'code': {
				if (typeof node.text !== 'string') {
					throw new Boom('renderWhatsApp: code node requires a text string', { statusCode: 400 })
				}

				return wrapMarkers('`', node.text)
			}

			case 'link': {
				if (typeof node.url !== 'string' || !node.url) {
					throw new Boom('renderWhatsApp: link node requires a url string', { statusCode: 400 })
				}

				if (typeof node.label !== 'undefined' && typeof node.label !== 'string') {
					throw new Boom('renderWhatsApp: link label must be a string', { statusCode: 400 })
				}

				return node.label && node.label !== node.url ? `${node.label} (${node.url})` : node.url
			}

			case 'mention': {
				const decoded = typeof node.jid === 'string' ? jidDecode(node.jid) : undefined
				if (!decoded?.user) {
					throw new Boom(`renderWhatsApp: mention node requires a valid JID, got ${String(node.jid)}`, {
						statusCode: 400
					})
				}

				if (!seenMentions.has(node.jid)) {
					seenMentions.add(node.jid)
					mentions.push(node.jid)
				}

				return `@${decoded.user}`
			}

			default:
				throw new Boom(`renderWhatsApp: unknown node type ${String((node as { type?: unknown }).type)}`, {
					statusCode: 400
				})
		}
	}

	const list = Array.isArray(nodes) ? nodes : [nodes]
	return { text: renderNodes(list), mentions }
}

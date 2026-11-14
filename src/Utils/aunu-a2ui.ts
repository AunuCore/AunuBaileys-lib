// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
/**
 * AunuBaileys (1.0.71): A2UI widgets — a small declarative builder for
 * WhatsApp's Agent-to-UI widgets. Components (Text, Image, Video, Button,
 * Card, Column, Row) are registered bottom-up and compiled into the JSON
 * payload WhatsApp carries in `interactiveMessage.bloksWidget` (field 8).
 *
 * Only the wire shape is WhatsApp's — the component tree, the
 * `createSurface` envelope and the `im_a2ui` payload type. Everything
 * else here (ids, defaults, API) is AunuBaileys' own design.
 *
 *     const ui = new AunuA2UI();
 *     const title = ui.text('Halo', { variant: 'h1' });
 *     const btn = ui.button(ui.text('Tekan'), { action: { name: 'noop' } });
 *     ui.root([ui.card(ui.column([title, btn]))]);
 *     await sock.aunuSendA2UI(jid, ui, { text: 'Widget' });
 *
 * A send can succeed while the recipient's client renders nothing —
 * verify against the target client build before relying on it.
 */
import { randomUUID } from 'crypto'

const AUNU_A2UI_CATALOG_ID = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json'

export class AunuA2UI {
	constructor({ catalogId = AUNU_A2UI_CATALOG_ID, version = 'v0.9' } = {}) {
		this._version = version
		this._catalogId = catalogId
		this._items = []
		this._seenIds = new Set()
		this._seq = 0
		this._roots = []
		this._listCard = undefined
	}
	_add(kind, fields, id) {
		const finalId = id ?? `${kind.toLowerCase()}-${++this._seq}`
		if (this._seenIds.has(finalId)) {
			throw new Error(`A2UI component id "${finalId}" is already used`)
		}
		this._seenIds.add(finalId)
		this._items.push({ id: finalId, component: kind, ...fields })
		return finalId
	}
	text(text, { id, variant = 'body' } = {}) {
		return this._add('Text', { text: String(text ?? ''), variant }, id)
	}
	image(url, { id, variant, fit = 'cover' } = {}) {
		return this._add('Image', { url: String(url ?? ''), ...(variant ? { variant } : {}), fit }, id)
	}
	video(url, { id } = {}) {
		return this._add('Video', { url: String(url ?? '') }, id)
	}
	button(childId, { id, variant = 'primary', action } = {}) {
		if (!childId) {
			throw new TypeError('button(childId) needs the id of a child component (for example from .text())')
		}
		return this._add('Button', { child: childId, variant, ...(action ? { action } : {}) }, id)
	}
	card(childId, { id } = {}) {
		if (!childId) {
			throw new TypeError('card(childId) needs the id of a child component')
		}
		return this._add('Card', { child: childId }, id)
	}
	column(children = [], { id, justify, align } = {}) {
		if (!Array.isArray(children) || !children.length) {
			throw new TypeError('column(children) needs a non-empty array of child component ids')
		}
		return this._add(
			'Column',
			{ children: [...children], ...(justify ? { justify } : {}), ...(align ? { align } : {}) },
			id
		)
	}
	row(children = [], { id } = {}) {
		if (!Array.isArray(children) || !children.length) {
			throw new TypeError('row(children) needs a non-empty array of child component ids')
		}
		return this._add('Row', { children: [...children] }, id)
	}
	divider({ id } = {}) {
		return this._add('Divider', {}, id)
	}
	/** Names the top-level components. Required before `build()` unless `listCard` was used. */
	root(children) {
		if (!Array.isArray(children) || !children.length) {
			throw new TypeError('root(children) needs a non-empty array of top-level component ids')
		}
		this._roots = [...children]
		return this
	}
	/**
	 * Shortcut for the product-list widget, which uses its own payload
	 * shape instead of the component catalog. It replaces whatever the
	 * component methods built — `build()` returns this payload and
	 * ignores `root()`.
	 */
	listCard({ title, items, fallbackText, uuid = randomUUID() } = {}) {
		if (!title) {
			throw new TypeError('listCard requires a title')
		}
		if (!Array.isArray(items) || !items.length) {
			throw new TypeError('listCard requires a non-empty items array of { title, price?, assetId? }')
		}
		this._listCard = {
			uuid,
			data: JSON.stringify({
				type: 'list_card',
				title,
				fallback_text: fallbackText ?? '',
				items: items.map(item => ({
					asset_id: item.assetId ?? randomUUID().replace(/-/g, '').slice(0, 17),
					asset_type: item.assetType ?? 'PRODUCT_ITEM',
					title: item.title,
					trailing_label: item.price ?? item.trailingLabel ?? '',
					trailing_emphasis: item.emphasis ?? 'strong'
				}))
			}),
			type: 'im_a2ui',
			fallback: fallbackText ?? ''
		}
		return this
	}
	/** Compiles the tree into the `bloksWidget` payload. Called for you by `sendMessage`. */
	build({ uuid = randomUUID(), surfaceId, type = 'im_a2ui', wrapped = true } = {}) {
		if (this._listCard) {
			return this._listCard
		}
		if (!this._roots.length) {
			throw new Error('Call root([...ids]) before build()')
		}
		const root = { id: 'root', component: 'Column', children: [...this._roots] }
		const data = wrapped
			? {
					version: this._version,
					createSurface: {
						surfaceId: surfaceId ?? `aunu-widget=${uuid}`,
						catalogId: this._catalogId,
						components: [root, ...this._items]
					}
				}
			: { components: [root, ...this._items] }
		return { uuid, data: JSON.stringify(data), type }
	}
}
/** Accepts an `AunuA2UI` instance or an already-built payload, and returns the payload. */
export const buildAunuA2UIWidget = (widget, options = {}) => {
	const built = typeof widget?.build === 'function' ? widget.build(options) : widget
	if (!built || typeof built.data !== 'string') {
		throw new TypeError('a2ui must be an AunuA2UI instance or a built widget payload with a `data` string')
	}
	return built
}

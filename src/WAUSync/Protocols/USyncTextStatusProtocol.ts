import type { USyncQueryProtocol } from '../../Types/USync'
import { assertNodeErrorFree, type BinaryNode, getBinaryNodeChild } from '../../WABinary'

export class USyncTextStatusProtocol implements USyncQueryProtocol {
	name = 'text_status'

	getQueryElement(): BinaryNode {
		return {
			tag: 'text_status',
			attrs: {}
		}
	}

	getUserElement(): BinaryNode | null {
		return null
	}

	parser(node: BinaryNode) {
		if (node.tag !== 'text_status') {
			return null
		}

		assertNodeErrorFree(node)
		// AunuBaileys (2.3.0, HB-282 addendum): a missing
		// last_update_time used to fabricate setAt = epoch 1970 and a
		// non-numeric one an Invalid Date. Unknown stays unknown;
		// the 0 fallback is kept only for the expiry arithmetic.
		const parsedLastUpdate = node.attrs?.last_update_time ? +node.attrs.last_update_time : NaN
		const lastUpdateTimeSec = Number.isFinite(parsedLastUpdate) ? parsedLastUpdate : 0
		const ephemeralDurationSec = node.attrs?.ephemeral_duration_sec ? +node.attrs.ephemeral_duration_sec : 0
		const text = node.attrs?.text ?? null
		const emojiNode = getBinaryNodeChild(node, 'emoji')
		const emoji = emojiNode?.attrs?.content ?? null
		// expiry is lastUpdateTime + ephemeralDuration (both in ms); 0 means no expiry
		const expiresAt =
			Number.isFinite(parsedLastUpdate) && ephemeralDurationSec > 0
				? new Date((lastUpdateTimeSec + ephemeralDurationSec) * 1000)
				: null
		return {
			text,
			emoji,
			setAt: Number.isFinite(parsedLastUpdate) ? new Date(lastUpdateTimeSec * 1000) : undefined,
			expiresAt
		}
	}
}

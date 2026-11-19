import type { USyncQueryProtocol } from '../../Types/USync'
import { assertNodeErrorFree, type BinaryNode } from '../../WABinary'

export type DisappearingModeData = {
	duration: number
	setAt?: Date
}

export class USyncDisappearingModeProtocol implements USyncQueryProtocol {
	name = 'disappearing_mode'

	getQueryElement(): BinaryNode {
		return {
			tag: 'disappearing_mode',
			attrs: {}
		}
	}

	getUserElement(): null {
		return null
	}

	parser(node: BinaryNode): DisappearingModeData | undefined {
		if (node.tag === 'disappearing_mode') {
			assertNodeErrorFree(node)
			const duration: number = +node?.attrs.duration!
			// AunuBaileys (2.3.0, HB-282 addendum): same fabricated
			// epoch / Invalid Date as USyncStatusProtocol — unknown
			// `t` stays unknown.
			const tSeconds = node?.attrs.t !== undefined ? +node.attrs.t : NaN
			const setAt = Number.isFinite(tSeconds) ? new Date(tSeconds * 1000) : undefined

			return {
				duration,
				setAt
			}
		}
	}
}

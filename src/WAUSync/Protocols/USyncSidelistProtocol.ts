import type { USyncQueryProtocol } from '../../Types/USync'
import { assertNodeErrorFree, type BinaryNode } from '../../WABinary'
import type { USyncUser } from '../USyncUser'

export class USyncSidelistProtocol implements USyncQueryProtocol {
	name = 'sidelist'
	// When true, sends addressing_mode="lid" — required for
	// interop/LID-mode contacts
	useLidAddressing: boolean

	constructor(useLidAddressing = true) {
		this.useLidAddressing = useLidAddressing
	}

	getQueryElement(): BinaryNode {
		const attrs: { [k: string]: string } = {}
		if (this.useLidAddressing) {
			attrs.addressing_mode = 'lid'
		}

		return { tag: 'sidelist', attrs }
	}

	getUserElement(user: USyncUser): BinaryNode | null {
		if (user.sidelistDelete) {
			return { tag: 'sidelist', attrs: { type: 'delete' } }
		}

		return null
	}

	parser(node: BinaryNode) {
		if (node.tag !== 'sidelist' && node.tag !== 'side_list') {
			return null
		}

		assertNodeErrorFree(node)
		// Returns minimal parsed data; the full side_list is parsed in USyncQuery
		return { type: node.attrs?.type ?? null }
	}
}

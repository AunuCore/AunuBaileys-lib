import type { USyncQueryProtocol } from '../../Types/USync'
import { assertNodeErrorFree, type BinaryNode } from '../../WABinary'
import type { USyncUser } from '../USyncUser'

export class USyncPictureProtocol implements USyncQueryProtocol {
	name = 'picture'
	// "image" for full resolution, "preview" for a thumbnail
	type: string

	constructor(type = 'image') {
		this.type = type
	}

	getQueryElement(): BinaryNode {
		return {
			tag: 'picture',
			attrs: { type: this.type }
		}
	}

	getUserElement(user: USyncUser): BinaryNode | null {
		const attrs: { [k: string]: string } = {}
		if (user.pictureId != null) {
			attrs.id = String(user.pictureId)
		}

		return Object.keys(attrs).length > 0 ? { tag: 'picture', attrs } : null
	}

	parser(node: BinaryNode) {
		if (node.tag !== 'picture') {
			return null
		}

		assertNodeErrorFree(node)
		const id = node.attrs?.id ?? null
		const directPath = node.attrs?.direct_path ?? null
		const hash = node.attrs?.hash ?? null
		if (!id && !directPath) {
			return null
		}

		return { id, directPath, hash }
	}
}

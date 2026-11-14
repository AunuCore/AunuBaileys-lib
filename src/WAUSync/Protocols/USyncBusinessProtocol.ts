import type { USyncQueryProtocol } from '../../Types/USync'
import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildren } from '../../WABinary'
import type { USyncUser } from '../USyncUser'

export class USyncBusinessProtocol implements USyncQueryProtocol {
	name = 'business'
	profileVersion: string | null

	constructor(profileVersion: string | null = '2') {
		this.profileVersion = profileVersion
	}

	getQueryElement(): BinaryNode {
		return {
			tag: 'business',
			attrs: {},
			content: [
				{ tag: 'verified_name', attrs: {} },
				// pass a falsy profileVersion to ask for the verified name only
				...(this.profileVersion ? [{ tag: 'profile', attrs: { v: this.profileVersion } }] : [])
			]
		}
	}

	getUserElement(user: USyncUser): BinaryNode | null {
		const children: BinaryNode[] = []
		if (user.verifiedNameSerial) {
			children.push({ tag: 'verified_name', attrs: { serial: user.verifiedNameSerial } })
		}

		if (user.businessProfileTag) {
			children.push({ tag: 'profile', attrs: { tag: user.businessProfileTag } })
		}

		return children.length > 0 ? { tag: 'business', attrs: {}, content: children } : null
	}

	parser(node: BinaryNode) {
		if (node.tag !== 'business') {
			return null
		}

		// a non-business contact answers with an <error/> child; that is
		// "no business profile", not a query failure, so it must not abort
		// the whole usync result
		if (getBinaryNodeChild(node, 'error')) {
			return null
		}

		const verifiedNameNode = getBinaryNodeChild(node, 'verified_name')
		const profileNode = getBinaryNodeChild(node, 'profile')
		// Business hours: profile may contain a business_hours child with
		// business_hours_config children
		let businessHours: { timezone: string | null; config: any[] } | undefined = undefined
		if (profileNode) {
			const businessHoursNode = getBinaryNodeChild(profileNode, 'business_hours')
			if (businessHoursNode) {
				const configs = getBinaryNodeChildren(businessHoursNode, 'business_hours_config')
				businessHours = {
					timezone: businessHoursNode.attrs?.timezone ?? null,
					config: configs.map(({ attrs }) => ({
						dayOfWeek: attrs?.day_of_week ?? null,
						openTime: attrs?.open_time ?? null,
						closeTime: attrs?.close_time ?? null,
						mode: attrs?.mode ?? null
					}))
				}
			}
		}

		// Business address from profile child node
		const addressNode = profileNode ? getBinaryNodeChild(profileNode, 'address') : null
		const businessAddress = addressNode?.content
			? Buffer.isBuffer(addressNode.content)
				? addressNode.content.toString()
				: String(addressNode.content)
			: (profileNode?.attrs?.address ?? null)
		// Catalog status from profile attrs
		const catalogStatus = profileNode
			? {
					exists: profileNode.attrs?.catalog_exists === 'true' || (profileNode.attrs?.catalog_exists as any) === true,
					sendAll: profileNode.attrs?.catalog_send_all === 'true' || (profileNode.attrs?.catalog_send_all as any) === true
				}
			: null
		// Cart flags from profile attrs
		const cartEnabled =
			profileNode?.attrs?.cart_enabled !== undefined
				? profileNode.attrs.cart_enabled === 'true' || (profileNode.attrs.cart_enabled as any) === true
				: null
		const webCartEnabled =
			profileNode?.attrs?.web_cart_enabled !== undefined
				? profileNode.attrs.web_cart_enabled === 'true' || (profileNode.attrs.web_cart_enabled as any) === true
				: null
		const webCartOnOff = profileNode?.attrs?.web_cart_on_off ?? null
		// Commerce experience from profile attrs
		const commerceExperience = profileNode?.attrs?.commerce_experience ?? null
		return {
			verifiedName: verifiedNameNode?.content ?? null,
			verifiedLevel: verifiedNameNode?.attrs?.verified_level ?? null,
			verifiedNameLevel: verifiedNameNode?.attrs?.verified_level ?? null,
			profileTag: profileNode?.attrs?.tag ?? null,
			pnJid: node.attrs?.pn_jid ?? null,
			businessHours: businessHours ?? null,
			businessAddress,
			catalogStatus,
			cartEnabled,
			webCartEnabled,
			webCartOnOff,
			commerceExperience
		}
	}
}

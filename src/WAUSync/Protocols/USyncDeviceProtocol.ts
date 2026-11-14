import type { USyncQueryProtocol } from '../../Types/USync'
import { assertNodeErrorFree, type BinaryNode, getBinaryNodeChild } from '../../WABinary'
//import { USyncUser } from '../USyncUser'

export type KeyIndexData = {
	timestamp: number
	signedKeyIndex?: Uint8Array
	expectedTimestamp?: number
}

export type DeviceListData = {
	id: number
	keyIndex?: number
	isHosted?: boolean
}

export type ParsedDeviceInfo = {
	deviceList?: DeviceListData[]
	keyIndex?: KeyIndexData
}

export class USyncDeviceProtocol implements USyncQueryProtocol {
	name = 'devices'

	getQueryElement(): BinaryNode {
		return {
			tag: 'devices',
			attrs: {
				version: '2'
			}
		}
	}

	getUserElement(/* user: USyncUser */): BinaryNode | null {
		//TODO: Implement device phashing, ts and expectedTs
		//TODO: if all are not present, return null <- current behavior
		//TODO: otherwise return a node w tag 'devices' w those as attrs
		return null
	}

	parser(node: BinaryNode): ParsedDeviceInfo {
		const deviceList: DeviceListData[] = []
		let keyIndex: KeyIndexData | undefined = undefined

		if (node.tag === 'devices') {
			assertNodeErrorFree(node)
			const deviceListNode = getBinaryNodeChild(node, 'device-list')
			const keyIndexNode = getBinaryNodeChild(node, 'key-index-list')

			if (Array.isArray(deviceListNode?.content)) {
				for (const { tag, attrs } of deviceListNode.content) {
					if (tag !== 'device') {
						continue
					}

					// AunuBaileys (HB-272, P4): a <device> without an id
					// attribute parsed as NaN, and extractDeviceJids'
					// keyIndex clause let it through — jidEncode then
					// dropped the device suffix entirely, collapsing
					// the entry onto the bare (device 0) JID at send
					// time. A device with no finite id does not exist.
					const id = +attrs.id!
					if (!Number.isFinite(id)) {
						continue
					}

					const keyIndex = +attrs['key-index']!
					deviceList.push({
						id,
						keyIndex,
						isHosted: !!(attrs['is_hosted'] && attrs['is_hosted'] === 'true')
					})
				}
			}

			if (keyIndexNode?.tag === 'key-index-list') {
				keyIndex = {
					timestamp: +keyIndexNode.attrs['ts']!,
					signedKeyIndex: keyIndexNode?.content as Uint8Array,
					expectedTimestamp: keyIndexNode.attrs['expected_ts'] ? +keyIndexNode.attrs['expected_ts'] : undefined
				}
			}
		}

		return {
			deviceList,
			keyIndex
		}
	}
}

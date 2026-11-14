import type { USyncQueryProtocol } from '../Types/USync'
import { type BinaryNode, getBinaryNodeChild } from '../WABinary'
import { USyncBotProfileProtocol } from './Protocols/UsyncBotProfileProtocol'
import { USyncLIDProtocol } from './Protocols/UsyncLIDProtocol'
import {
	USyncBusinessProtocol,
	USyncContactProtocol,
	USyncDeviceProtocol,
	USyncDisappearingModeProtocol,
	USyncFeatureProtocol,
	USyncPictureProtocol,
	USyncSidelistProtocol,
	USyncStatusProtocol,
	USyncTextStatusProtocol,
	USyncUsernameProtocol
} from './Protocols'
import { USyncUser } from './USyncUser'

export type USyncQueryResultList = { [protocol: string]: unknown; id: string }

export type USyncQueryResult = {
	list: USyncQueryResultList[]
	sideList: USyncQueryResultList[]
}

export class USyncQuery {
	protocols: USyncQueryProtocol[]
	users: USyncUser[]
	context: string
	mode: string

	constructor() {
		this.protocols = []
		this.users = []
		this.context = 'interactive'
		this.mode = 'query'
	}

	withMode(mode: string) {
		this.mode = mode
		return this
	}

	withContext(context: string) {
		this.context = context
		return this
	}

	withUser(user: USyncUser) {
		this.users.push(user)
		return this
	}

	parseUSyncQueryResult(result: BinaryNode | undefined): USyncQueryResult | undefined {
		if (result?.attrs.type !== 'result') {
			return
		}

		const protocolMap = Object.fromEntries(
			this.protocols.map(protocol => {
				return [protocol.name, protocol.parser]
			})
		)

		const queryResult: USyncQueryResult = {
			// TODO: implement errors etc.
			list: [],
			sideList: []
		}

		const usyncNode = getBinaryNodeChild(result, 'usync')

		//TODO: implement error backoff, refresh etc.
		//TODO: see if there are any errors in the result node
		//const resultNode = getBinaryNodeChild(usyncNode, 'result')

		const listNode = usyncNode ? getBinaryNodeChild(usyncNode, 'list') : undefined

		if (listNode?.content && Array.isArray(listNode.content)) {
			queryResult.list = listNode.content.reduce((acc: USyncQueryResultList[], node) => {
				const id = node?.attrs.jid
				if (id) {
					const data = Array.isArray(node?.content)
						? Object.fromEntries(
								node.content
									.map(content => {
										const protocol = content.tag
										const parser = protocolMap[protocol]
										if (parser) {
											try {
												return [protocol, parser(content)]
											} catch (err: any) {
												// a blocked-code parser error should surface as a flag, not crash the query
												const errCode = err?.data ?? err?.output?.payload?.data
												if (errCode === 401 || errCode === 403 || errCode === 405) {
													return ['isBlockedByContact', true]
												}

												// AunuBaileys (1.0.87, HB-175, re-applied P3b): any OTHER per-user
												// parser error — the protocol node carried an <error> child with
												// e.g. a 404 — used to abort the parse of the ENTIRE batch: one
												// user's error cost every other user's devices / contacts. This
												// user simply has no data for this protocol (the null is dropped
												// by the filter below); the rest of the batch continues.
												return [protocol, null]
											}
										} else {
											return [protocol, null]
										}
									})
									.filter(([, b]) => b !== null) as [string, unknown][]
							)
						: {}
					acc.push({ ...data, id })
				}

				return acc
			}, [])
		}

		//TODO: implement side list
		//const sideListNode = getBinaryNodeChild(usyncNode, 'side_list')
		return queryResult
	}

	withDeviceProtocol() {
		this.protocols.push(new USyncDeviceProtocol())
		return this
	}

	withContactProtocol() {
		this.protocols.push(new USyncContactProtocol())
		return this
	}

	withStatusProtocol() {
		this.protocols.push(new USyncStatusProtocol())
		return this
	}

	withDisappearingModeProtocol() {
		this.protocols.push(new USyncDisappearingModeProtocol())
		return this
	}

	withBotProfileProtocol() {
		this.protocols.push(new USyncBotProfileProtocol())
		return this
	}

	withLIDProtocol() {
		this.protocols.push(new USyncLIDProtocol())
		return this
	}

	withUsernameProtocol() {
		this.protocols.push(new USyncUsernameProtocol())
		return this
	}

	withBusinessProtocol(profileVersion?: string) {
		this.protocols.push(new USyncBusinessProtocol(profileVersion))
		return this
	}

	/** @param type 'image' for full resolution, 'preview' for a thumbnail */
	withPictureProtocol(type?: string) {
		this.protocols.push(new USyncPictureProtocol(type))
		return this
	}

	withTextStatusProtocol() {
		this.protocols.push(new USyncTextStatusProtocol())
		return this
	}

	/** alias: the text-status protocol is the contact's "about" */
	withAboutProtocol() {
		return this.withTextStatusProtocol()
	}

	withSidelistProtocol(useLidAddressing?: boolean) {
		this.protocols.push(new USyncSidelistProtocol(useLidAddressing))
		return this
	}

	/** alias for the 'side_list' spelling used in result nodes */
	withSideListProtocol(useLidAddressing?: boolean) {
		return this.withSidelistProtocol(useLidAddressing)
	}

	withFeatureProtocol(features?: string[]) {
		this.protocols.push(new USyncFeatureProtocol(features))
		return this
	}
}

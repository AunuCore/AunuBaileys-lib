import { promises as fs } from 'fs'
import { Boom } from '@hapi/boom'
import type { GetCatalogOptions, ProductCreate, ProductUpdate, SocketConfig, WAMediaUpload } from '../Types'
import type { UpdateBussinesProfileProps } from '../Types/Bussines'
import { getRawMediaUploadData } from '../Utils'
import {
	parseCatalogNode,
	parseCollectionsNode,
	parseOrderDetailsNode,
	parseProductNode,
	toProductNode,
	uploadingNecessaryImagesOfProduct
} from '../Utils/business'
import { type BinaryNode, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary'
import { getBinaryNodeChild } from '../WABinary/generic-utils'
import { sanitizeMediaTimeoutMs } from '../Utils/messages-media'
import { makeMessagesRecvSocket } from './messages-recv'

export const makeBusinessSocket = (config: SocketConfig) => {
	const sock = makeMessagesRecvSocket(config)
	const { authState, query, waUploadToServer } = sock

	const updateBussinesProfile = async (args: UpdateBussinesProfileProps) => {
		const node: BinaryNode[] = []
		const simpleFields: (keyof UpdateBussinesProfileProps)[] = ['address', 'email', 'description']

		node.push(
			...simpleFields
				.filter(key => args[key] !== undefined && args[key] !== null)
				.map(key => ({
					tag: key,
					attrs: {},
					content: args[key] as string
				}))
		)

		if (args.websites !== undefined) {
			node.push(
				...args.websites.map(website => ({
					tag: 'website',
					attrs: {},
					content: website
				}))
			)
		}

		if (args.hours !== undefined) {
			node.push({
				tag: 'business_hours',
				attrs: { timezone: args.hours.timezone },
				content: args.hours.days.map(dayConfig => {
					const base = {
						tag: 'business_hours_config',
						attrs: {
							day_of_week: dayConfig.day,
							mode: dayConfig.mode
						}
					} as const

					if (dayConfig.mode === 'specific_hours') {
						return {
							...base,
							attrs: {
								...base.attrs,
								open_time: dayConfig.openTimeInMinutes,
								close_time: dayConfig.closeTimeInMinutes
							}
						}
					}

					return base
				})
			})
		}

		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: {
						v: '3',
						mutation_type: 'delta'
					},
					content: node
				}
			]
		})

		return result
	}

	const updateCoverPhoto = async (photo: WAMediaUpload) => {
		// AunuBaileys (2.6.0, HB-2026-1112-50 addendum): the raw
		// download used to be called with NO opts — the host's
		// maxContentLength and AbortSignal were ignored, so a stalled
		// remote URL hung the cover-photo update forever. Forward
		// the host's fetch options, with a 120 s default timeout
		// (the sanitizer's fallback, mirroring the newsletter branch
		// in prepareWAMessageMedia) when the host set no signal.
		const { fileSha256, filePath } = await getRawMediaUploadData(photo, 'biz-cover-photo', config.logger, {
			...config.options,
			signal: config.options?.signal ?? AbortSignal.timeout(sanitizeMediaTimeoutMs(undefined))
		})
		const fileSha256B64 = fileSha256.toString('base64')

		// AunuBaileys (2.1.0, sweep, HB-2026-1112-10 class): try/finally
		// like the newsletter branch — a failed upload used to leak the
		// full-size tmp file.
		let fbid: number | undefined
		try {
			const { meta_hmac, fbid: uploadedFbid, ts } = await waUploadToServer(filePath, {
				fileEncSha256B64: fileSha256B64,
				mediaType: 'biz-cover-photo'
			})
			fbid = uploadedFbid

			// AunuBaileys (2.9.0, W14/H6/D18): the upload result type
			// marks meta_hmac/fbid/ts optional — a host can answer a
			// successful upload without them, and the IQ below used
			// to be built through non-null assertions, sending
			// id: "undefined" / ts: "undefined" / a missing token.
			// Refuse before any IQ goes out.
			if (meta_hmac == null || uploadedFbid == null || ts == null) {
				throw new Boom(
					'Cover photo upload response is incomplete: missing meta_hmac, fbid or ts — refusing to send the cover_photo IQ',
					{ statusCode: 502 }
				)
			}

			await query({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'set',
					xmlns: 'w:biz'
				},
				content: [
					{
						tag: 'business_profile',
						attrs: {
							v: '3',
							mutation_type: 'delta'
						},
						content: [
							{
								tag: 'cover_photo',
								attrs: { id: String(fbid), op: 'update', token: meta_hmac!, ts: String(ts) }
							}
						]
					}
				]
			})
		} finally {
			await fs.unlink(filePath).catch(() => {})
		}

		return fbid!
	}

	const removeCoverPhoto = async (id: string) => {
		return await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: {
						v: '3',
						mutation_type: 'delta'
					},
					content: [
						{
							tag: 'cover_photo',
							attrs: { op: 'delete', id }
						}
					]
				}
			]
		})
	}

	const getCatalog = async ({ jid, limit, cursor }: GetCatalogOptions) => {
		jid = jid || authState.creds.me?.id
		jid = jidNormalizedUser(jid)

		const queryParamNodes: BinaryNode[] = [
			{
				tag: 'limit',
				attrs: {},
				content: Buffer.from((limit || 10).toString())
			},
			{
				tag: 'width',
				attrs: {},
				content: Buffer.from('100')
			},
			{
				tag: 'height',
				attrs: {},
				content: Buffer.from('100')
			}
		]

		if (cursor) {
			queryParamNodes.push({
				tag: 'after',
				attrs: {},
				content: cursor
			})
		}

		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog',
					attrs: {
						jid,
						allow_shop_source: 'true'
					},
					content: queryParamNodes
				}
			]
		})
		return parseCatalogNode(result)
	}

	const getCollections = async (jid?: string, limit = 51) => {
		jid = jid || authState.creds.me?.id
		jid = jidNormalizedUser(jid)
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'w:biz:catalog',
				smax_id: '35'
			},
			content: [
				{
					tag: 'collections',
					attrs: {
						biz_jid: jid
					},
					content: [
						{
							tag: 'collection_limit',
							attrs: {},
							content: Buffer.from(limit.toString())
						},
						{
							tag: 'item_limit',
							attrs: {},
							content: Buffer.from(limit.toString())
						},
						{
							tag: 'width',
							attrs: {},
							content: Buffer.from('100')
						},
						{
							tag: 'height',
							attrs: {},
							content: Buffer.from('100')
						}
					]
				}
			]
		})

		return parseCollectionsNode(result)
	}

	const getOrderDetails = async (orderId: string, tokenBase64: string) => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'fb:thrift_iq',
				smax_id: '5'
			},
			content: [
				{
					tag: 'order',
					attrs: {
						op: 'get',
						id: orderId
					},
					content: [
						{
							tag: 'image_dimensions',
							attrs: {},
							content: [
								{
									tag: 'width',
									attrs: {},
									content: Buffer.from('100')
								},
								{
									tag: 'height',
									attrs: {},
									content: Buffer.from('100')
								}
							]
						},
						{
							tag: 'token',
							attrs: {},
							content: Buffer.from(tokenBase64)
						}
					]
				}
			]
		})

		return parseOrderDetailsNode(result)
	}

	const productUpdate = async (productId: string, update: ProductUpdate) => {
		update = await uploadingNecessaryImagesOfProduct(update, waUploadToServer)
		const editNode = toProductNode(productId, update)

		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog_edit',
					attrs: { v: '1' },
					content: [
						editNode,
						{
							tag: 'width',
							attrs: {},
							content: '100'
						},
						{
							tag: 'height',
							attrs: {},
							content: '100'
						}
					]
				}
			]
		})

		const productCatalogEditNode = getBinaryNodeChild(result, 'product_catalog_edit')
		const productNode = getBinaryNodeChild(productCatalogEditNode, 'product')

		return parseProductNode(productNode!)
	}

	const productCreate = async (create: ProductCreate) => {
		// ensure isHidden is defined
		create.isHidden = !!create.isHidden
		create = await uploadingNecessaryImagesOfProduct(create, waUploadToServer)
		const createNode = toProductNode(undefined, create)

		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog_add',
					attrs: { v: '1' },
					content: [
						createNode,
						{
							tag: 'width',
							attrs: {},
							content: '100'
						},
						{
							tag: 'height',
							attrs: {},
							content: '100'
						}
					]
				}
			]
		})

		const productCatalogAddNode = getBinaryNodeChild(result, 'product_catalog_add')
		const productNode = getBinaryNodeChild(productCatalogAddNode, 'product')

		return parseProductNode(productNode!)
	}

	const productDelete = async (productIds: string[]) => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog_delete',
					attrs: { v: '1' },
					content: productIds.map(id => ({
						tag: 'product',
						attrs: {},
						content: [
							{
								tag: 'id',
								attrs: {},
								content: Buffer.from(id)
							}
						]
					}))
				}
			]
		})

		const productCatalogDelNode = getBinaryNodeChild(result, 'product_catalog_delete')
		return {
			deleted: +(productCatalogDelNode?.attrs.deleted_count || 0)
		}
	}

	return {
		...sock,
		logger: config.logger,
		getOrderDetails,
		getCatalog,
		getCollections,
		productCreate,
		productDelete,
		productUpdate,
		updateBussinesProfile,
		updateCoverPhoto,
		removeCoverPhoto
	}
}

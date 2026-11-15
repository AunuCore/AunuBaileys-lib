import { Boom } from '@hapi/boom'
import type { BinaryNode } from '../WABinary'
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary'

const wMexQuery = (
	variables: Record<string, unknown>,
	queryId: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
) => {
	return query({
		tag: 'iq',
		attrs: {
			id: generateMessageTag(),
			type: 'get',
			to: S_WHATSAPP_NET,
			xmlns: 'w:mex'
		},
		content: [
			{
				tag: 'query',
				attrs: { query_id: queryId },
				content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
			}
		]
	})
}

export const executeWMexQuery = async <T>(
	variables: Record<string, unknown>,
	queryId: string,
	dataPath: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
): Promise<T> => {
	const result = await wMexQuery(variables, queryId, query, generateMessageTag)
	const child = getBinaryNodeChild(result, 'result')
	if (child?.content) {
		// AunuBaileys (2.1.0, sweep): a non-JSON MEX body used to escape
		// as a raw SyntaxError, and a non-array `errors` died on .map —
		// both are server-shape failures, so they surface as Boom instead.
		let data: {
			errors?: Array<{ message?: string; extensions?: { error_code?: unknown } }>
			data?: Record<string, unknown>
		}
		try {
			data = JSON.parse(child.content.toString())
		} catch {
			throw new Boom('Failed to parse MEX response as JSON', { statusCode: 502, data: result })
		}

		if (Array.isArray(data.errors) && data.errors.length > 0) {
			const errorMessages = data.errors.map(err => err.message || 'Unknown error').join(', ')
			// length > 0 was just checked, so [0] exists — the `!` states that invariant.
			const firstError = data.errors[0]!
			// AunuBaileys (1.0.87, HB-211, re-applied P3): the server's
			// error_code is wire data \u2014 a non-numeric or out-of-range
			// value makes `new Boom` itself throw (verified empirically
			// against the installed @hapi/boom: a string statusCode
			// throws "First argument must be a number"). Sanitise like
			// HB-42: only a numeric HTTP code survives, else 500.
			const rawErrorCode = Number(firstError.extensions?.error_code)
			const errorCode = Number.isInteger(rawErrorCode) && rawErrorCode >= 400 && rawErrorCode <= 599 ? rawErrorCode : 500
			throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError })
		}

		const response = dataPath ? data?.data?.[dataPath] : data?.data
		if (typeof response !== 'undefined') {
			return response as T
		}
	}

	const action = (dataPath || '').startsWith('xwa2_')
		? dataPath.substring(5).replace(/_/g, ' ')
		: dataPath?.replace(/_/g, ' ')
	throw new Boom(`Failed to ${action}, unexpected response structure.`, { statusCode: 400, data: result })
}

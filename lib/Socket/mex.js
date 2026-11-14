import { Boom } from '@hapi/boom';
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary/index.js';
const wMexQuery = (variables, queryId, query, generateMessageTag) => {
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
    });
};
export const executeWMexQuery = async (variables, queryId, dataPath, query, generateMessageTag) => {
    const result = await wMexQuery(variables, queryId, query, generateMessageTag);
    const child = getBinaryNodeChild(result, 'result');
    if (child?.content) {
        // AunuBaileys (1.0.87, HB-211): a <result> that is not JSON
        // (including a child-node array body, which stringifies to
        // "[object Object]") used to reject with a raw SyntaxError
        // the host could not classify.
        let data;
        try {
            data = JSON.parse(child.content.toString());
        }
        catch (err) {
            throw new Boom('GraphQL server error: unparseable response', { statusCode: 400, data: result });
        }
        if (data.errors && data.errors.length > 0) {
            const errorMessages = data.errors.map((err) => err.message || 'Unknown error').join(', ');
            const firstError = data.errors[0];
            // AunuBaileys (1.0.87, HB-211): the server's error_code
            // went into the Boom constructor unsanitised — a string
            // code ('RATE_LIMITED') or an out-of-range one (200)
            // made `new Boom` itself throw a non-Boom TypeError,
            // and the server's actual error message was lost with
            // it. Same sanitation as HB-42: only a numeric HTTP
            // error code survives, everything else becomes 400.
            const rawErrorCode = firstError.extensions?.error_code;
            const errorCode = typeof rawErrorCode === 'number' && rawErrorCode >= 400 && rawErrorCode <= 599 ? rawErrorCode : 400;
            throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError });
        }
        const response = dataPath ? data?.data?.[dataPath] : data?.data;
        if (typeof response !== 'undefined') {
            return response;
        }
    }
    const action = (dataPath || '').startsWith('xwa2_')
        ? dataPath.substring(5).replace(/_/g, ' ')
        : dataPath?.replace(/_/g, ' ');
    throw new Boom(`Failed to ${action}, unexpected response structure.`, { statusCode: 400, data: result });
};
//# sourceMappingURL=mex.js.map
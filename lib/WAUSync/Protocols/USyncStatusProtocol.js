import { assertNodeErrorFree } from '../../WABinary/index.js';
export class USyncStatusProtocol {
    constructor() {
        this.name = 'status';
    }
    getQueryElement() {
        return {
            tag: 'status',
            attrs: {}
        };
    }
    getUserElement() {
        return null;
    }
    parser(node) {
        if (node.tag === 'status') {
            assertNodeErrorFree(node);
            let status = node?.content?.toString() ?? null;
            // AunuBaileys (2.3.0, HB-282 addendum): a missing `t`
            // used to fabricate the 1970 epoch via `|| 0` and a
            // non-numeric `t` produced an Invalid Date — hosts got a
            // confident-looking wrong timestamp. No/invalid `t`
            // means the time is simply unknown.
            const tSeconds = node?.attrs.t !== undefined ? +node.attrs.t : NaN;
            const setAt = Number.isFinite(tSeconds) ? new Date(tSeconds * 1000) : undefined;
            if (!status) {
                if (node.attrs?.code && +node.attrs.code === 401) {
                    status = '';
                }
                else {
                    status = null;
                }
            }
            else if (typeof status === 'string' && status.length === 0) {
                status = null;
            }
            return {
                status,
                setAt
            };
        }
    }
}
//# sourceMappingURL=USyncStatusProtocol.js.map
import { assertNodeErrorFree } from '../../WABinary/index.js';
export class USyncDisappearingModeProtocol {
    constructor() {
        this.name = 'disappearing_mode';
    }
    getQueryElement() {
        return {
            tag: 'disappearing_mode',
            attrs: {}
        };
    }
    getUserElement() {
        return null;
    }
    parser(node) {
        if (node.tag === 'disappearing_mode') {
            assertNodeErrorFree(node);
            const duration = +node?.attrs.duration;
            // AunuBaileys (2.3.0, HB-282 addendum): same fabricated
            // epoch / Invalid Date as USyncStatusProtocol — unknown
            // `t` stays unknown.
            const tSeconds = node?.attrs.t !== undefined ? +node.attrs.t : NaN;
            const setAt = Number.isFinite(tSeconds) ? new Date(tSeconds * 1000) : undefined;
            return {
                duration,
                setAt
            };
        }
    }
}
//# sourceMappingURL=USyncDisappearingModeProtocol.js.map
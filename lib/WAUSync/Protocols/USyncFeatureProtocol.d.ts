import type { USyncQueryProtocol } from '../../Types/USync.js';
import { type BinaryNode } from '../../WABinary/index.js';
export declare const USYNC_FEATURES: string[];
export declare class USyncFeatureProtocol implements USyncQueryProtocol {
    name: string;
    features: string[];
    /**
     * @param features feature names to query (defaults to all known)
     */
    constructor(features?: string[]);
    getQueryElement(): BinaryNode;
    getUserElement(): BinaryNode | null;
    parser(node: BinaryNode): {
        [key: string]: string;
    } | {
        errorCode: number | undefined;
        errorText: string | undefined;
    } | null;
}
//# sourceMappingURL=USyncFeatureProtocol.d.ts.map
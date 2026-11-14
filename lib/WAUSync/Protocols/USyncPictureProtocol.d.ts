import type { USyncQueryProtocol } from '../../Types/USync.js';
import { type BinaryNode } from '../../WABinary/index.js';
import type { USyncUser } from '../USyncUser.js';
export declare class USyncPictureProtocol implements USyncQueryProtocol {
    name: string;
    type: string;
    constructor(type?: string);
    getQueryElement(): BinaryNode;
    getUserElement(user: USyncUser): BinaryNode | null;
    parser(node: BinaryNode): {
        id: string | null;
        directPath: string | null;
        hash: string | null;
    } | null;
}
//# sourceMappingURL=USyncPictureProtocol.d.ts.map
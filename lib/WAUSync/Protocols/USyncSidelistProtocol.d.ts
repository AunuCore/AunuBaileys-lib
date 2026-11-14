import type { USyncQueryProtocol } from '../../Types/USync.js';
import { type BinaryNode } from '../../WABinary/index.js';
import type { USyncUser } from '../USyncUser.js';
export declare class USyncSidelistProtocol implements USyncQueryProtocol {
    name: string;
    useLidAddressing: boolean;
    constructor(useLidAddressing?: boolean);
    getQueryElement(): BinaryNode;
    getUserElement(user: USyncUser): BinaryNode | null;
    parser(node: BinaryNode): {
        type: string | null;
    } | null;
}
//# sourceMappingURL=USyncSidelistProtocol.d.ts.map
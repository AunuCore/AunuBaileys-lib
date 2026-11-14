import type { USyncQueryProtocol } from '../../Types/USync.js';
import { type BinaryNode } from '../../WABinary/index.js';
import type { USyncUser } from '../USyncUser.js';
export declare class USyncBusinessProtocol implements USyncQueryProtocol {
    name: string;
    profileVersion: string | null;
    constructor(profileVersion?: string | null);
    getQueryElement(): BinaryNode;
    getUserElement(user: USyncUser): BinaryNode | null;
    parser(node: BinaryNode): {
        verifiedName: string | Uint8Array<ArrayBufferLike> | BinaryNode[] | null;
        verifiedLevel: string | null;
        verifiedNameLevel: string | null;
        profileTag: string | null;
        pnJid: string | null;
        businessHours: {
            timezone: string | null;
            config: any[];
        } | null;
        businessAddress: string | null;
        catalogStatus: {
            exists: boolean;
            sendAll: boolean;
        } | null;
        cartEnabled: boolean | null;
        webCartEnabled: boolean | null;
        webCartOnOff: string | null;
        commerceExperience: string | null;
    } | null;
}
//# sourceMappingURL=USyncBusinessProtocol.d.ts.map
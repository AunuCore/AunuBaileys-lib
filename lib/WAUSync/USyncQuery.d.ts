import type { USyncQueryProtocol } from '../Types/USync.js';
import { type BinaryNode } from '../WABinary/index.js';
import { USyncUser } from './USyncUser.js';
export type USyncQueryResultList = {
    [protocol: string]: unknown;
    id: string;
};
export type USyncQueryResult = {
    list: USyncQueryResultList[];
    sideList: USyncQueryResultList[];
};
export declare class USyncQuery {
    protocols: USyncQueryProtocol[];
    users: USyncUser[];
    context: string;
    mode: string;
    constructor();
    withMode(mode: string): this;
    withContext(context: string): this;
    withUser(user: USyncUser): this;
    parseUSyncQueryResult(result: BinaryNode | undefined): USyncQueryResult | undefined;
    withDeviceProtocol(): this;
    withContactProtocol(): this;
    withStatusProtocol(): this;
    withDisappearingModeProtocol(): this;
    withBotProfileProtocol(): this;
    withLIDProtocol(): this;
    withUsernameProtocol(): this;
    withBusinessProtocol(profileVersion?: string): this;
    /** @param type 'image' for full resolution, 'preview' for a thumbnail */
    withPictureProtocol(type?: string): this;
    withTextStatusProtocol(): this;
    /** alias: the text-status protocol is the contact's "about" */
    withAboutProtocol(): this;
    withSidelistProtocol(useLidAddressing?: boolean): this;
    /** alias for the 'side_list' spelling used in result nodes */
    withSideListProtocol(useLidAddressing?: boolean): this;
    withFeatureProtocol(features?: string[]): this;
}
//# sourceMappingURL=USyncQuery.d.ts.map
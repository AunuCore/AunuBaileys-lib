import type { proto } from '../../WAProto/index.js';
export declare const tokenizeCode: (code: string, language?: string) => {
    highlightType: number;
    codeContent: string;
}[];
export declare const toUnified: (submessages: any[], uuid?: string) => any;
export declare const buildFoaHtmlSection: (html: string, trustedSources?: string[]) => any;
export declare const prepareHtmlMessage: (content: { html?: string; trustedSources?: string[] }) => any;
export declare const buildRichHtmlScreen: (options: any) => any;
export declare const prepareRichHtmlMessage: (options: any) => any;
export declare const prepareRichResponseMessage: (content: any) => any;
export declare const wrapToBotForwardedMessage: (richResponseMessage: proto.AIRichResponseMessage) => any;

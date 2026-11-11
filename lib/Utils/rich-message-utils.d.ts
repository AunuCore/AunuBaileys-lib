import type { proto } from '../../WAProto/index.js';
export declare const tokenizeCode: (code: string, language?: string) => {
    highlightType: number;
    codeContent: string;
}[];
export declare const toUnified: (submessages: any[], uuid?: string) => any;
export declare const prepareRichResponseMessage: (content: any) => any;
export declare const wrapToBotForwardedMessage: (richResponseMessage: proto.AIRichResponseMessage) => any;

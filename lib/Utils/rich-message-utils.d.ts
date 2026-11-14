export declare const tokenizeCode: (code: any, language?: string) => {
    highlightType: number;
    codeContent: string | undefined;
}[];
export declare const buildAunuMapMetadata: (map?: {}) => {
    centerLatitude: any;
    centerLongitude: any;
    latitudeDelta: any;
    longitudeDelta: any;
    annotations: any;
    showInfoList: any;
};
export declare const buildAunuImageUrl: (value: any) => any;
export declare const toUnified: (submessages: any, uuid: any) => {
    response_id: any;
    sections: any;
};
export declare const buildFoaHtmlSection: (html: any, trustedSources?: never[]) => {
    __typename: string;
    view_model: {
        __typename: string;
        primitive: {
            __typename: string;
            trusted_sources: never[];
            payload: string;
        };
    };
};
export declare const prepareHtmlMessage: (content?: {}) => {
    richResponseMessage: any;
};
export declare const buildRichHtmlScreen: (options?: {}) => {
    title: any;
    embeddedScreen: {
        title: any;
        content: {
            __typename: string;
            tabs: {
                id: any;
                tab_header: any;
                sections: {
                    __typename: string;
                    view_model: {
                        __typename: string;
                        primitive: {
                            __typename: string;
                            payload: string;
                            url: any;
                            trusted_sources: any;
                        };
                    };
                }[];
                step_entries: never[];
            }[];
        }[];
    };
};
export declare const prepareRichHtmlMessage: (options?: {}) => {
    richResponseMessage: any;
};
export declare const prepareRichResponseMessage: (content: any) => {
    richResponseMessage: any;
};
export declare const wrapToBotForwardedMessage: (richResponseMessage: any) => {
    richResponseMessage: any;
};
//# sourceMappingURL=rich-message-utils.d.ts.map
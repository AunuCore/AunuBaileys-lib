export declare const clampAutoJoinLimit: (value: any) => number;
export declare const runAutoJoinChannels: (sock: any, channels: any, options?: {}) => Promise<{
    followed: never[];
    alreadyFollowing: never[];
    failed: never[];
    dropped: any[];
    invalid: never[];
}>;
export declare const attachAunuAutoJoin: (sock: any, config?: {}) => void;
//# sourceMappingURL=aunu-autojoin.d.ts.map
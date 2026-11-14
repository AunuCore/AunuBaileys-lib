export declare const makeSessionWatchdog: (sock: any, options?: {}) => {
    markInbound: () => void;
    noteInbound: () => void;
    check: () => boolean;
    start: () => /*elided*/ any;
    stop: () => /*elided*/ any;
    getState: () => {
        lastInboundAt: number;
        quietForMs: number;
        running: boolean;
        firedForEpisode: boolean;
    };
};
export declare const attachSessionWatchdog: (sock: any, options: any) => {
    markInbound: () => void;
    noteInbound: () => void;
    check: () => boolean;
    start: () => /*elided*/ any;
    stop: () => /*elided*/ any;
    getState: () => {
        lastInboundAt: number;
        quietForMs: number;
        running: boolean;
        firedForEpisode: boolean;
    };
};
//# sourceMappingURL=session-watchdog.d.ts.map
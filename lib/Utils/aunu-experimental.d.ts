/** EXPERIMENTAL — see aunu-experimental.js. Semantics may change in any release. */
export declare const encodeWatermark: (payload: string) => string;
export declare const appendWatermark: (text: string, payload: string) => string;
export declare const extractWatermark: (text: string) => string | null;
export declare const stripWatermark: (text: string) => string;
export interface TypingDurationOptions {
    /** Characters per second while "typing". Default 5. */
    cps?: number;
    /** Lower clamp in ms. Default 700. */
    minMs?: number;
    /** Upper clamp in ms. Default 8000. */
    maxMs?: number;
    /** Set false for a deterministic duration. Default true (±20%). */
    jitter?: boolean;
}
export declare const computeTypingDuration: (text: string, options?: TypingDurationOptions) => number;

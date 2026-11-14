/**
 * AunuBaileys (1.0.71): scam-signal flagging — pure, flag-only rules for
 * typical scam messages (OTP / seed-phrase lures, guaranteed profit,
 * claim fees, prize bait, ...). Nothing is blocked, reported or deleted
 * by this module alone; the caller decides what a flagged message means.
 * Add or remove rules to fit the deployment's language and area.
 */
export declare const AUNU_SCAM_SIGNAL_RULES: {
    id: string;
    label: string;
    weight: number;
    pattern: RegExp;
}[];
/**
 * Scores `text` against the rules. Returns `{ score, matched, flagged }`;
 * `flagged` is true once the score reaches `threshold` (default 2, so a
 * single weight-2 rule — OTP, seed phrase, guaranteed profit — flags on
 * its own, while weight-1 hints need a second one). Non-string input
 * scores zero. All patterns are non-global, so repeated calls are safe.
 */
export declare const flagScamSignals: (text: any, { rules, threshold }?: {
    rules?: {
        id: string;
        label: string;
        weight: number;
        pattern: RegExp;
    }[] | undefined;
    threshold?: number | undefined;
}) => {
    score: number;
    matched: {
        id: string;
        label: string;
        weight: number;
    }[];
    flagged: boolean;
};
//# sourceMappingURL=aunu-scam-signals.d.ts.map
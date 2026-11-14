// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
/**
 * AunuBaileys (1.0.71): scam-signal flagging — pure, flag-only rules for
 * typical scam messages (OTP / seed-phrase lures, guaranteed profit,
 * claim fees, prize bait, ...). Nothing is blocked, reported or deleted
 * by this module alone; the caller decides what a flagged message means.
 * Add or remove rules to fit the deployment's language and area.
 */
export const AUNU_SCAM_SIGNAL_RULES = [
    {
        id: 'otp',
        label: 'asks for an OTP / verification code',
        weight: 2,
        pattern: /\b(?:send|share|give|forward|tell(?: me)?)\b[^.\n]{0,40}\b(?:otp|one[- ]time (?:pass)?code|verification code|6[- ]digit code|security code)\b/i
    },
    {
        id: 'seed-phrase',
        label: 'asks for a seed phrase / private key',
        weight: 2,
        pattern: /\b(?:seed phrase|recovery phrase|private key|wallet phrase|mnemonic phrase)\b/i
    },
    {
        id: 'guaranteed-profit',
        label: 'promises guaranteed / risk-free profit',
        weight: 2,
        pattern: /\b(?:guaranteed|assured|risk[- ]free)\s+(?:profit|returns?|income|payout|earnings?)\b/i
    },
    {
        id: 'double-money',
        label: 'promises to multiply deposited money',
        weight: 2,
        pattern: /\b(?:double|triple|10x)\s+(?:your\s+)?(?:money|investment|deposit|balance)\b/i
    },
    {
        id: 'claim-fee',
        label: 'asks for a fee to release a prize / payment',
        weight: 2,
        pattern: /\b(?:pay|send|deposit|transfer)\b[^.\n]{0,40}\b(?:fee|tax|charges?|processing)\b[^.\n]{0,50}\b(?:claim|release|withdraw|receive|unlock)\b/i
    },
    {
        id: 'prize',
        label: 'prize / lottery winner message',
        weight: 1,
        pattern: /\b(?:you(?:'ve| have)? won|lucky draw|lottery|congratulations)\b[^.\n]{0,60}\b(?:prize|gift|reward|cash|iphone|bonus)\b/i
    },
    {
        id: 'daily-income',
        label: 'easy daily income offer',
        weight: 1,
        pattern: /\b(?:earn|make)\s+(?:up to\s+)?(?:\$|rs\.?|usd|lkr)?\s?\d[\d,]*\+?\s*(?:per day|daily|a day|every day|per week|weekly)\b/i
    },
    {
        id: 'task-job',
        label: 'paid-for-likes / tasks job offer',
        weight: 1,
        pattern: /\b(?:like|follow|subscribe|rate)\b[^.\n]{0,40}\b(?:earn|paid|payment|commission|salary)\b/i
    },
    {
        id: 'account-alert',
        label: 'fake account suspended / verify alert',
        weight: 1,
        pattern: /\b(?:account|card|bank|whatsapp)\b[^.\n]{0,30}\b(?:suspended|blocked|locked|expired|verification)\b/i
    },
    {
        id: 'urgent-money',
        label: 'urgent request to send money',
        weight: 1,
        pattern: /\b(?:urgent(?:ly)?|emergency)\b[^.\n]{0,50}\b(?:send|transfer)\b[^.\n]{0,30}\b(?:money|cash|funds|payment)\b/i
    },
    {
        id: 'short-link',
        label: 'shortened link',
        weight: 1,
        pattern: /\b(?:bit\.ly|tinyurl\.com|cutt\.ly|rb\.gy|is\.gd|shorturl\.at)\/\S+/i
    },
    {
        id: 'group-invite',
        label: 'pushes a group invite link',
        weight: 1,
        pattern: /chat\.whatsapp\.com\/\S+/i
    }
];
/**
 * Scores `text` against the rules. Returns `{ score, matched, flagged }`;
 * `flagged` is true once the score reaches `threshold` (default 2, so a
 * single weight-2 rule — OTP, seed phrase, guaranteed profit — flags on
 * its own, while weight-1 hints need a second one). Non-string input
 * scores zero. All patterns are non-global, so repeated calls are safe.
 */
export const flagScamSignals = (text, { rules = AUNU_SCAM_SIGNAL_RULES, threshold = 2 } = {}) => {
    if (typeof text !== 'string' || !text) {
        return { score: 0, matched: [], flagged: false };
    }
    const matched = [];
    for (const rule of rules) {
        let hit = false;
        try {
            hit = rule.pattern.test(text);
        }
        catch {
            hit = false;
        }
        if (hit) {
            matched.push({ id: rule.id, label: rule.label, weight: rule.weight });
        }
    }
    const score = matched.reduce((sum, item) => sum + item.weight, 0);
    return { score, matched, flagged: score >= threshold };
};
//# sourceMappingURL=aunu-scam-signals.js.map
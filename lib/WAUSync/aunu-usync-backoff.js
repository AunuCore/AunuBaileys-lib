/**
 * AunuBaileys (1.0.71): per-protocol USync backoff — pure helper, no socket.
 *
 * A server-reported error on a usync protocol can carry a backoff
 * (seconds); later usync queries touching that protocol should wait it
 * out before firing — EXCEPT time-critical device lookups made while
 * sending a message or placing a call, which must never wait. Our
 * USyncQuery.parseUSyncQueryResult already surfaces the server value as
 * queryResult.errors[protocol].errorBackoff (seconds).
 *
 * Wired (1.0.72) into the single choke point, executeUSyncQuery in
 * lib/Socket/usync.js, exactly as:
 *   await waitForBackoff(usyncQuery);            // before query(iq)
 *   const parsed = usyncQuery.parseUSyncQueryResult(result);
 *   recordBackoffFromResult(parsed);             // after the parse
 *   return parsed;
 * Time-critical device lookups never wait: waitForBackoff itself
 * skips 'interactive' queries and any query carrying the 'devices'
 * protocol in a 'message'/'voip' context (see shouldSkipProtocol).
 * Server-reported values are additionally clamped to MAX_BACKOFF_MS
 * (60s) — a backoff hint must never park the bot for hours.
 * Backoff is kept as an expiry timestamp (not a pending promise), so an
 * expired entry costs nothing and the map never grows past the small
 * fixed set of protocol names.
 */

const backoffUntilMs = new Map();
// AunuBaileys (1.0.72): a server-reported backoff is a HINT, not an
// order — without a cap, a hostile or buggy response could park every
// usync query for a day. 60s is far above any legitimate retry hint
// for an interactive protocol like this.
export const MAX_BACKOFF_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Set a backoff for a protocol by name, in milliseconds.
 * @param {string} protocolName
 * @param {number} ms
 */
export const setProtocolBackoffMs = (protocolName, ms) => {
    if (!protocolName || !Number.isFinite(ms) || ms <= 0) {
        return;
    }
    backoffUntilMs.set(protocolName, Date.now() + Math.min(ms, MAX_BACKOFF_MS));
};

/**
 * Record a server-reported failure for a protocol. The backoff is in
 * SECONDS, matching the `backoff` attr on the usync <error/> node.
 * Non-positive / non-finite values record nothing.
 * @param {string} protocolName
 * @param {number} backoffSeconds
 */
export const recordFailure = (protocolName, backoffSeconds) => {
    if (!protocolName || !Number.isFinite(backoffSeconds) || backoffSeconds <= 0) {
        return;
    }
    backoffUntilMs.set(protocolName, Date.now() + Math.min(backoffSeconds * 1000, MAX_BACKOFF_MS));
};

/**
 * Record every server backoff surfaced by a parsed USync result
 * (queryResult.errors[protocol].errorBackoff, seconds).
 * @param {object} queryResult result of USyncQuery.parseUSyncQueryResult
 * @returns {string[]} protocol names a backoff was recorded for
 */
export const recordBackoffFromResult = (queryResult) => {
    const recorded = [];
    const errors = queryResult?.errors || {};
    for (const [protocolName, err] of Object.entries(errors)) {
        if (Number.isFinite(err?.errorBackoff) && err.errorBackoff > 0) {
            recordFailure(protocolName, err.errorBackoff);
            recorded.push(protocolName);
        }
    }
    return recorded;
};

/** Milliseconds of backoff still remaining for a protocol (0 = none). */
export const getBackoffRemainingMs = (protocolName) => {
    const until = backoffUntilMs.get(protocolName);
    if (!until) {
        return 0;
    }
    return Math.max(0, until - Date.now());
};

/** Drop any backoff for a protocol (tests / manual reset). */
export const clearProtocolBackoff = (protocolName) => {
    backoffUntilMs.delete(protocolName);
};

/**
 * True when waiting must be skipped for this protocol in this context:
 * device lookups made while sending a message or placing a call are
 * time-critical and never wait out a backoff.
 * @param {string} protocolName
 * @param {string} [context] USyncQuery context ('interactive' | 'message' | 'voip' | ...)
 */
export const shouldSkipProtocol = (protocolName, context) => {
    return protocolName === 'devices' && (context === 'message' || context === 'voip');
};

/**
 * Wait out any active backoff for the query's protocols.
 * No-op for 'interactive' queries, and for queries that carry a
 * 'devices' protocol in a 'message'/'voip' context (the whole query
 * is time-critical then, not just the devices leg).
 * @param {object} query { protocols: Array<{name: string}>, context?: string }
 */
export const waitForBackoff = async (query) => {
    if (!query || !Array.isArray(query.protocols)) {
        return;
    }
    if (query.context === 'interactive') {
        return;
    }
    if (query.protocols.some((p) => shouldSkipProtocol(p?.name, query.context))) {
        return;
    }
    const waits = [];
    for (const p of query.protocols) {
        const remaining = getBackoffRemainingMs(p?.name);
        if (remaining > 0) {
            waits.push(sleep(remaining));
        }
    }
    await Promise.all(waits);
};

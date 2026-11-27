import type { AnyMessageContent } from '../Types/index.js';
/**
 * AunuBaileys (2.8.0, D-1107): beta-message dispatcher.
 *
 * Recorded from the pontalabs delta in the heartbeat ledger
 * (run-1328): a small set of content keys the official beta client
 * dispatches specially, a validator that rejects a beta content
 * missing its load-bearing field with Boom 400, and a denylist of
 * content classes that must never be routed through the beta path.
 * Every proto type dispatched here already exists in our WAProto;
 * the value is the dispatch + validation, not a new wire surface.
 * (The companion proto delta from the same donor —
 * Message.newsletterFollowerInviteMessage = 108 — is NOT included:
 * WAProto is generated and the field cannot be added by hand.)
 */
export declare const BETA_CONTENT_KEYS: readonly ["music", "eventInvite", "requestLocation", "requestLocationUpdate", "instantImage", "instantVideo", "audioSticker", "beta"];
export type BetaContentKey = (typeof BETA_CONTENT_KEYS)[number];
export declare const BETA_BLOCKED_KEYS: readonly ["payment", "split", "vpc", "rootsecret", "rootkey", "botplatformregistration", "acp2", "botgroupparticipant", "newsletteradminprofile", "newsletterscheduled"];
/** The beta content key a message content carries, if any. */
export declare const detectBetaKey: (content: unknown) => BetaContentKey | undefined;
/**
 * Validate a beta message content and return it unchanged, ready
 * for sock.sendMessage. Throws Boom 400 for a blocked content
 * class, for content carrying no (or several) beta keys, for a
 * non-object beta value, and for a beta content missing the field
 * it cannot act without (music.songUri, eventInvite.eventId).
 */
export declare const buildBetaMessage: <T extends AnyMessageContent>(content: T) => T;
export declare const isBetaContentKey: (key: string) => key is BetaContentKey;
//# sourceMappingURL=beta-messages.d.ts.map
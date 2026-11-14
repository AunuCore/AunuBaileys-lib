import { readFileSync, renameSync, writeFileSync } from 'fs'
import type { WAMessage } from '../Types/index.js'
import { isLidUser, isPnUser, jidNormalizedUser } from '../WABinary/jid-utils.js'

export interface LIDStoreOptions {
	/** Maximum PN<->LID pairs kept; least-recently-used pairs are evicted. Default 5000. */
	maxEntries?: number
	/** Fired when a genuinely NEW or changed PN<->LID pair is learned. */
	onPairLearned?: (pair: { pn: string; lid: string }) => void
	logger?: { warn?: (obj: any, msg?: string) => void }
}

type LearnableKey = {
	senderPn?: string
	senderLid?: string
	participantPn?: string
	participantLid?: string
	remoteJid?: string
	fromMe?: boolean
	[key: string]: any
}

export interface LIDStore {
	/** Store one PN/LID pair. Returns false when either JID is not a user PN JID / LID JID. */
	addPair(pnJid: string, lidJid: string, opts?: { silent?: boolean }): boolean
	/** Learn pairs from a message key (senderPn/senderLid, participantPn/participantLid). Returns pairs learned. */
	learnFromKey(key: LearnableKey | undefined | null): number
	/** Learn pairs from one message. Returns pairs learned. */
	learnFromMessage(msg: WAMessage | undefined | null): number
	/** Learn pairs from a `messages.upsert` payload. Returns pairs learned. */
	learnFromUpsert(upsert: { messages?: WAMessage[] } | undefined | null): number
	getLIDForPN(pnJid: string): string | undefined
	getPNForLID(lidJid: string): string | undefined
	/** The alternate identity form of a known JID (PN for a known LID, LID for a known PN); undefined when unknown or not a user JID. */
	getAltJid(jid: string): string | undefined
	hasPN(pnJid: string): boolean
	hasLID(lidJid: string): boolean
	deletePair(jid: string): boolean
	clear(): void
	readonly size: number
	toJSON(): Record<string, string>
	saveToFile(path: string): void
	/** Returns the number of pairs loaded; 0 when the file is missing or invalid. */
	loadFromFile(path: string): number
}

/**
 * AunuBaileys LID identity store.
 *
 * WhatsApp is migrating identities from phone-number JIDs
 * (`<number>@s.whatsapp.net`) to LIDs (`<id>@lid`). Incoming message
 * stanzas already carry both forms (`sender_pn`/`sender_lid`,
 * `participant_pn`/`participant_lid`), so this store learns the
 * PN <-> LID pairs from live traffic and answers bidirectional
 * lookups locally — no server round-trip, no extra IQ queries.
 *
 * The socket attaches an auto-learning instance as `sock.aunuLid`.
 * A standalone store can also be created with `makeLIDStore()` and
 * fed manually via `learnFromMessage` / `addPair`.
 */
export const makeLIDStore = (options: LIDStoreOptions = {}): LIDStore => {
	// AunuBaileys (1.0.80, HB-190 + addendum HB-145): `?? 5000`
	// let NaN through (the eviction comparison `size > NaN` is
	// always false — the store grew without bound) and let
	// negatives through (evictIfNeeded's while loop then spun
	// forever on an empty map: `size > -1` stays true while
	// delete(undefined) is a no-op — a wedged process, no error).
	// Sanitise at the boundary: finite values are floored and
	// clamped at 0 (0 = store nothing, which terminates),
	// non-finite values fall back to the default 5000.
	const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(0, Math.floor(options.maxEntries!)) : 5000
	// AunuBaileys (1.0.71): optional listener fired when a genuinely
	// NEW or changed PN<->LID pair is learned (re-learning an already
	// known pair does not fire). The socket wires it to 'lid-mapping.update'.
	const onPairLearned = options.onPairLearned
	const pnToLid = new Map<string, string>()
	const lidToPn = new Map<string, string>()
	const touch = (map: Map<string, string>, key: string, value: string) => {
		// refresh recency for LRU eviction
		map.delete(key)
		map.set(key, value)
	}
	const evictIfNeeded = () => {
		while (pnToLid.size > maxEntries) {
			// AunuBaileys (1.0.80, HB-190 defence in depth): with a
			// sanitised maxEntries (>= 0) this loop always
			// terminates, but never trust a loop whose only exit is
			// a size comparison — bail out if the map is somehow
			// already empty (the iterator's `done`, not the key's
			// value, is the empty signal).
			const oldest = pnToLid.keys().next()
			if (oldest.done) {
				break
			}

			const oldestPn = oldest.value
			const lid = pnToLid.get(oldestPn)
			pnToLid.delete(oldestPn)
			if (lid) {
				lidToPn.delete(lid)
			}
		}
	}
	const addPair = (pnJid: string, lidJid: string, opts: { silent?: boolean } = {}): boolean => {
		if (!pnJid || !lidJid) {
			return false
		}

		const pn = jidNormalizedUser(pnJid)
		const lid = jidNormalizedUser(lidJid)
		if (!isPnUser(pn) || !isLidUser(lid)) {
			return false
		}

		// keep both directions consistent if either side was remapped
		const prevLid = pnToLid.get(pn)
		if (prevLid && prevLid !== lid) {
			lidToPn.delete(prevLid)
		}

		const prevPn = lidToPn.get(lid)
		if (prevPn && prevPn !== pn) {
			pnToLid.delete(prevPn)
		}

		const isNewPair = pnToLid.get(pn) !== lid || lidToPn.get(lid) !== pn
		touch(pnToLid, pn, lid)
		touch(lidToPn, lid, pn)
		evictIfNeeded()
		if (isNewPair && !opts.silent) {
			try {
				onPairLearned?.({ pn, lid })
			} catch {
				// a listener must never break identity learning
			}
		}

		return true
	}
	const learnFromKey = (key: LearnableKey | undefined | null): number => {
		if (!key) {
			return 0
		}

		let learned = 0
		if (key.senderPn && key.senderLid) {
			learned += addPair(key.senderPn, key.senderLid) ? 1 : 0
		}

		if (key.participantPn && key.participantLid) {
			learned += addPair(key.participantPn, key.participantLid) ? 1 : 0
		}

		// a DM chat partner: remoteJid may be the PN while the stanza
		// only carried the sender LID (or the reverse)
		if (key.remoteJid && key.senderLid && isPnUser(key.remoteJid) && !key.fromMe) {
			learned += addPair(key.remoteJid, key.senderLid) ? 1 : 0
		}

		return learned
	}
	const learnFromMessage = (msg: WAMessage | undefined | null): number => learnFromKey(msg?.key as LearnableKey)
	const learnFromUpsert = (upsert: { messages?: WAMessage[] } | undefined | null): number => {
		let learned = 0
		for (const msg of upsert?.messages ?? []) {
			learned += learnFromMessage(msg)
		}

		return learned
	}
	const store: LIDStore = {
		addPair,
		learnFromKey,
		learnFromMessage,
		learnFromUpsert,
		getLIDForPN: pnJid => (pnJid ? pnToLid.get(jidNormalizedUser(pnJid)) : undefined),
		getPNForLID: lidJid => (lidJid ? lidToPn.get(jidNormalizedUser(lidJid)) : undefined),
		// the other identity form of a known JID: PN for a known LID,
		// LID for a known PN; undefined for unknown or non-user JIDs
		getAltJid: jid => {
			if (!jid) {
				return undefined
			}

			const norm = jidNormalizedUser(jid)
			if (isLidUser(norm)) {
				return lidToPn.get(norm)
			}

			if (isPnUser(norm)) {
				return pnToLid.get(norm)
			}

			return undefined
		},
		hasPN: pnJid => (pnJid ? pnToLid.has(jidNormalizedUser(pnJid)) : false),
		hasLID: lidJid => (lidJid ? lidToPn.has(jidNormalizedUser(lidJid)) : false),
		deletePair: jid => {
			if (!jid) {
				return false
			}

			const norm = jidNormalizedUser(jid)
			const lid = pnToLid.get(norm)
			if (lid) {
				pnToLid.delete(norm)
				lidToPn.delete(lid)
				return true
			}

			const pn = lidToPn.get(norm)
			if (pn) {
				lidToPn.delete(norm)
				pnToLid.delete(pn)
				return true
			}

			return false
		},
		clear: () => {
			pnToLid.clear()
			lidToPn.clear()
		},
		get size() {
			return pnToLid.size
		},
		toJSON: () => Object.fromEntries(pnToLid),
		saveToFile: path => {
			// AunuBaileys (1.0.70): atomic tmp+rename — a crash mid-write
			// used to leave a truncated store file behind.
			const tmpPath = `${path}.tmp-${process.pid}`
			// AunuBaileys (1.0.84, HB-120): 0600, like the auth
			// files (HB-116) — this file maps phone numbers to
			// LIDs and must not land world-readable.
			writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(pnToLid)), { mode: 0o600 })
			renameSync(tmpPath, path)
		},
		loadFromFile: path => {
			try {
				const data = JSON.parse(readFileSync(path, 'utf-8'))
				let loaded = 0
				for (const [pn, lid] of Object.entries(data)) {
					// silent: restoring a persisted store is not learning
					loaded += addPair(pn, lid as string, { silent: true }) ? 1 : 0
				}

				return loaded
			} catch (err: any) {
				// AunuBaileys (1.0.70): a load failure used to be
				// swallowed silently — say so, the pairs are re-learned
				// from traffic anyway.
				options.logger?.warn?.({ err: err?.message || String(err) }, 'aunu: failed to load LID store file; starting empty')
				return 0
			}
		}
	}
	return store
}

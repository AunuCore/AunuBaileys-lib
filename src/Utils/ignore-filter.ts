// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
/**
 * AunuBaileys: the inbound stanza ignore filter behind
 * sock.ignoreKey() — behaviour learned from the @violetix/baileys
 * dissection. Matching stanzas are dropped BEFORE any handler runs:
 * no decryption, no persistence, no event. Messages are still acked
 * by the caller so the server stops redelivering them.
 *
 * A rule is either a predicate `(info) => boolean` or an object with
 * any of { category, remoteJid, participant, id, fromMe } — every
 * given field must match. `participant` matches ANY of the stanza's
 * participant forms (PN, LID, and the alt attributes), so a rule
 * written against a phone-number JID still catches the same person
 * arriving under their LID. Traffic in the 'peer' category
 * (own-device sync, app-state key shares) is NEVER dropped: an
 * over-broad rule must not be able to filter away a key share.
 */
export const stanzaInfo = (category, node, ownIds = []) => {
	const attrs = node?.attrs || {}
	const participants = [
		attrs.participant,
		attrs.participant_lid,
		attrs.participant_pn,
		attrs.sender_lid,
		attrs.sender_pn
	].filter(Boolean)
	const remoteJid = attrs.from || ''
	return {
		category,
		remoteJid,
		participant: participants[0] || '',
		participants,
		id: attrs.id || '',
		fromMe: !!remoteJid && ownIds.includes(remoteJid),
		node
	}
}
const ruleMatches = (rule, info) => {
	if (typeof rule === 'function') {
		try {
			return !!rule(info)
		} catch {
			return false // a broken predicate must not break the receive path
		}
	}
	if (!rule || typeof rule !== 'object') return false
	if (rule.category !== undefined && rule.category !== info.category) return false
	if (rule.remoteJid !== undefined && rule.remoteJid !== info.remoteJid) return false
	if (rule.id !== undefined && rule.id !== info.id) return false
	if (rule.fromMe !== undefined && rule.fromMe !== info.fromMe) return false
	if (rule.participant !== undefined && !info.participants.includes(rule.participant)) return false
	return true
}
export const createIgnoreFilter = () => {
	const rules = new Set()
	return {
		/** Register a rule; returns the function that removes it. */
		add: rule => {
			rules.add(rule)
			return () => {
				rules.delete(rule)
			}
		},
		clear: () => rules.clear(),
		get size() {
			return rules.size
		},
		shouldDrop: (category, node, ownIds) => {
			if (!rules.size) return false
			if (node?.attrs?.category === 'peer') return false
			const info = stanzaInfo(category, node, ownIds)
			for (const rule of rules) {
				if (ruleMatches(rule, info)) return true
			}
			return false
		}
	}
}

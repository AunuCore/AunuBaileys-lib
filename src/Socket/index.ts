import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { UserFacingSocketConfig } from '../Types'
import { AunuHandler } from '../Utils/aunu-handler'
import { attachAunuAutoJoin } from '../Utils/aunu-autojoin'
import { makeLIDStore } from '../Utils/lid-store'
import { attachSessionWatchdog } from '../Utils/session-watchdog'
import { attachAunuExperimental } from './aunu-experimental'
import { makeCommunitiesSocket } from './communities'
import { makeGraphQLSocket } from './graphql'
import { makeInteropSocket } from './interop'
import { makeManagedAccountSocket } from './managed-account'
import { makePrivacySocket } from './privacy'
import { makeRegistrationSocket } from './registration'

// export the last socket layer
const makeWASocket = (config: UserFacingSocketConfig) => {
	const newConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config
	}

	// AunuBaileys (1.0.75, HB-104): transactionOpts is merged per-field —
	// the shallow spread above replaced the whole default object, so a
	// host passing a PARTIAL transactionOpts silently lost the other
	// field's default (and, before the auth-utils fallback, every
	// key-store commit with it).
	newConfig.transactionOpts = {
		...DEFAULT_CONNECTION_CONFIG.transactionOpts,
		...(config?.transactionOpts ?? {})
	}

	// AunuBaileys (1.0.80, HB-139 + HB-174 + addendum HB-139,
	// re-applied P3): the numeric connection config was spread raw
	// above \u2014 an explicit undefined/NaN from the host (classically
	// `Number(env.X)` of an unset variable) silently replaced the
	// defaults, and every failure mode is silent: promiseTimeout(NaN)
	// never settles, a NaN/0/negative keepAliveIntervalMs collapses
	// setInterval to 1 ms, and a NaN/Infinity maxMsgRetryCount breaks
	// both retry gates at once. Sanitise once, here at the boundary:
	// timeouts/intervals must be positive finite (else the documented
	// default), the retry count must be finite (else the default),
	// and qrTimeout must be positive finite or absent. NOTE the
	// HB-199 lesson: values are never coerced \u2014 a non-number input
	// (e.g. the string '5abc') is not finite and falls back whole.
	const positiveFiniteOr = (value: unknown, fallback: number) =>
		typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
	newConfig.connectTimeoutMs = positiveFiniteOr(newConfig.connectTimeoutMs, DEFAULT_CONNECTION_CONFIG.connectTimeoutMs ?? 20_000)
	newConfig.defaultQueryTimeoutMs = positiveFiniteOr(
		newConfig.defaultQueryTimeoutMs,
		DEFAULT_CONNECTION_CONFIG.defaultQueryTimeoutMs ?? 60_000
	)
	newConfig.keepAliveIntervalMs = positiveFiniteOr(newConfig.keepAliveIntervalMs, DEFAULT_CONNECTION_CONFIG.keepAliveIntervalMs ?? 25_000)
	newConfig.maxMsgRetryCount =
		typeof newConfig.maxMsgRetryCount === 'number' && Number.isFinite(newConfig.maxMsgRetryCount)
			? newConfig.maxMsgRetryCount
			: (DEFAULT_CONNECTION_CONFIG.maxMsgRetryCount ?? 5)
	if (
		newConfig.qrTimeout !== undefined &&
		!(typeof newConfig.qrTimeout === 'number' && Number.isFinite(newConfig.qrTimeout) && newConfig.qrTimeout > 0)
	) {
		newConfig.qrTimeout = undefined
	}

	// If the user hasn't provided their own history sync function,
	// let's create a default one that respects the syncFullHistory flag.
	if (config.shouldSyncHistoryMessage === undefined) {
		newConfig.shouldSyncHistoryMessage = () => !!newConfig.syncFullHistory
	}

	// AunuBaileys (1.0.71): theme D layers, same nesting order as the
	// donor's index.js — graphql outermost so its token acquisition can
	// use the registration layer's wwwGetNonce/wwwExchangeNonce.
	const sock = makeGraphQLSocket(
		makeManagedAccountSocket(
			makeRegistrationSocket(makePrivacySocket(makeInteropSocket(makeCommunitiesSocket(newConfig))))
		)
	)
	attachAunuExperimental(sock)

	// AunuBaileys (1.0.71): deaf-session watchdog is opt-in only —
	// config.sessionWatchdog (object = options, true = defaults).
	// It only reports; it never reconnects.
	if (newConfig.sessionWatchdog) {
		const watchdog = attachSessionWatchdog(
			sock,
			newConfig.sessionWatchdog === true ? undefined : newConfig.sessionWatchdog
		)
		;(sock as any).aunuSessionWatchdog = watchdog
		// AunuBaileys (1.0.75, HB-105): stop() existed but was never
		// called anywhere in the lib — the interval is unref'd yet its
		// closure holds ev + sock, so every ended socket with the
		// watchdog enabled leaked one 30s timer and its whole socket
		// graph for the life of the process, one per reconnect cycle.
		// Register stop() as a socket-end handler, the same pattern as
		// stopOfflineDrain (HB-66). stop() is idempotent (safe on the
		// double-end path), and sockets without a watchdog never reach
		// this branch.
		sock.registerSocketEndHandler?.(() => watchdog.stop())
	}

	;(sock as any).aunuHandler = new AunuHandler(sock)
	attachAunuAutoJoin(sock, newConfig)

	if (!sock.aunuLid) {
		;(sock as any).aunuLid = makeLIDStore()
	}

	sock.ev.on('messages.upsert', (upsert: any) => {
		try {
			sock.aunuLid.learnFromUpsert(upsert)
		} catch {
			// identity learning must never break message handling
		}

		// AunuBaileys: when live traffic teaches us a PN <-> LID pair, move
		// any stored PN session onto the LID address (best-effort; the
		// decrypt heals remain the fallback).
		try {
			for (const msg of upsert?.messages ?? []) {
				const key = msg?.key ?? {}
				const pairs: [string, string][] = []
				if (key.senderPn && key.senderLid) {
					pairs.push([key.senderPn, key.senderLid])
				}

				if (key.participantPn && key.participantLid) {
					pairs.push([key.participantPn, key.participantLid])
				}

				if (key.remoteJid && key.senderLid && !key.fromMe) {
					pairs.push([key.remoteJid, key.senderLid])
				}

				for (const [pn, lid] of pairs) {
					;(sock.signalRepository as any)?.migrateSession?.(pn, lid)?.catch?.(() => {})
				}

				// AunuBaileys P2b (LID reconciliation): pairs learned by our
				// layer are also written best-effort into the native v7
				// LIDMappingStore (signalRepository.lidMapping), so the
				// upstream signal paths see the same identities. Our
				// sock.aunuLid stays the authoritative public surface.
				if (pairs.length) {
					;(sock.signalRepository as any)?.lidMapping
						?.storeLIDPNMappings?.(pairs.map(([pn, lid]) => ({ pn, lid })))
						?.catch?.(() => {})
				}

				// AunuBaileys P2b (LID reconciliation): when our store does
				// not know a PN yet, consult the native store asynchronously
				// and adopt its answer (the native API is async-only, so it
				// cannot serve aunuLid's synchronous lookups directly).
				const remoteJid = key.remoteJid as string | undefined
				if (remoteJid && !key.fromMe && !sock.aunuLid.getLIDForPN(remoteJid)) {
					;(sock.signalRepository as any)?.lidMapping
						?.getLIDForPN?.(remoteJid)
						?.then((lid: string | null) => {
							if (lid) {
								sock.aunuLid.addPair(remoteJid, lid, { silent: true })
							}
						})
						?.catch?.(() => {})
				}
			}
		} catch {
			// session migration must never break message handling
		}
	})

	sock.ev.on('connection.update', (update: any) => {
		// AunuBaileys: migrate the account's OWN session to its LID
		// address once the connection opens with both identities known.
		try {
			if (update.connection === 'open') {
				const me = (sock as any).authState?.creds?.me
				if (me?.id && me?.lid) {
					;(sock.signalRepository as any)?.migrateSession?.(me.id, me.lid)?.catch?.(() => {})
				}
			}
		} catch {
			// session migration must never break connection handling
		}
	})

	return sock
}

export default makeWASocket

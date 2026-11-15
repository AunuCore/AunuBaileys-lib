// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
// AunuBaileys (1.0.71): deaf-session watchdog (Synapse-VE pattern).
// Detects a session that looks alive but is deaf: the WebSocket is open
// (and, when the host supplies one, the ping/health check passes) yet no
// inbound message has arrived for quietAfterMs. It only REPORTS — it
// never reconnects, never ends the socket, and never sends anything.
// It emits both:
//   - 'session.watchdog'  { quietForMs, lastInboundAt, at }
//   - 'connection.update' { sessionWatchdog: { quietForMs, lastInboundAt, at } }
// once per quiet episode (re-armed by the next inbound message).
// Inbound traffic is observed on the event buffer ('messages.upsert' /
// 'messages.update') AND — since 1.0.76 — on the raw WebSocket frame
// stream when sock.ws is reachable (buffered delivery is deferred during
// long syncs, which used to read as a false deaf session); hosts can
// also call watchdog.markInbound() directly. Wiring is opt-in: lib/Socket/index.js
// attaches it only when config.sessionWatchdog is set (object = options,
// true = defaults). The interval timer is unref'd so it never keeps a
// process alive on its own.
export const makeSessionWatchdog = (sock, options = {}) => {
	if (!sock?.ev || typeof sock.ev.on !== 'function' || typeof sock.ev.emit !== 'function') {
		throw new Error('makeSessionWatchdog needs a socket with an event emitter (sock.ev)')
	}
	const {
		quietAfterMs: quietAfterMsRaw = 10 * 60 * 1000,
		checkIntervalMs: checkIntervalMsRaw = 30 * 1000,
		isConnected = () => (sock.ws ? !!sock.ws.isOpen : true),
		isHealthy = () => true,
		autoStart = true
	} = options
	// AunuBaileys (2.0.5, HB-328): the destructuring defaults only cover
	// `undefined` — a NaN (or zero/negative/non-numeric) value passed
	// straight through: quietForMs < NaN is always false, so the
	// watchdog fired a false deaf alert on its first tick, and
	// setInterval(NaN) is coerced to 1 ms, spinning the timer.
	// Sanitise at the boundary with explicit finite checks, the same
	// pattern as the 1.0.80 numeric-config sanitisation.
	const quietAfterMs =
		Number.isFinite(quietAfterMsRaw) && quietAfterMsRaw > 0 ? quietAfterMsRaw : 10 * 60 * 1000
	const checkIntervalMs =
		Number.isFinite(checkIntervalMsRaw) && checkIntervalMsRaw > 0 ? checkIntervalMsRaw : 30 * 1000
	const ev = sock.ev
	let lastInboundAt = Date.now()
	let timer = null
	let firedForEpisode = false
	const markInbound = () => {
		lastInboundAt = Date.now()
		firedForEpisode = false
	}
	const check = () => {
		let connected = true
		let healthy = true
		try {
			connected = !!isConnected()
		} catch {
			connected = false
		}
		try {
			healthy = !!isHealthy()
		} catch {
			healthy = false
		}
		if (!connected || !healthy) {
			return false
		}
		const quietForMs = Date.now() - lastInboundAt
		if (quietForMs < quietAfterMs || firedForEpisode) {
			return false
		}
		firedForEpisode = true
		const detail = { quietForMs, lastInboundAt, at: Date.now() }
		ev.emit('session.watchdog', detail)
		ev.emit('connection.update', { sessionWatchdog: detail })
		return true
	}
	const onConnectionUpdate = update => {
		// A fresh open means a fresh session — the quiet clock restarts.
		if (update?.connection === 'open') {
			markInbound()
		}
	}
	const start = () => {
		if (timer) {
			return watchdog
		}
		// AunuBaileys (2.1.0, HB-322): stop() removes all listeners, so start() must re-attach them — otherwise the watchdog kept firing false deaf alerts while traffic flowed.
		attachListeners()
		timer = setInterval(check, checkIntervalMs)
		if (typeof timer.unref === 'function') {
			timer.unref()
		}
		return watchdog
	}
	const stop = () => {
		if (timer) {
			clearInterval(timer)
			timer = null
		}
		ev.off?.('messages.upsert', markInbound)
		ev.off?.('messages.update', markInbound)
		ev.off?.('connection.update', onConnectionUpdate)
		if (rawWs) {
			rawWs.off?.('message', markInbound)
			if (!rawWs.off && typeof rawWs.removeListener === 'function') {
				rawWs.removeListener('message', markInbound)
			}
		}
		listenersAttached = false
		return watchdog
	}
	const getState = () => ({
		lastInboundAt,
		quietForMs: Date.now() - lastInboundAt,
		running: !!timer,
		firedForEpisode
	})
	const rawWs = sock.ws && typeof sock.ws.on === 'function' ? sock.ws : null
	let listenersAttached = false
	const attachListeners = () => {
		if (listenersAttached) {
			return
		}
		listenersAttached = true
		ev.on('messages.upsert', markInbound)
		ev.on('messages.update', markInbound)
		ev.on('connection.update', onConnectionUpdate)
		// AunuBaileys (1.0.76): Hunt-ronde-3 — ALSO observe the raw WebSocket
		// frame stream when available. messages.upsert/update travel through
		// the event buffer, which DEFERS delivery to listeners while a
		// buffered function runs (app-state resync, history processing): real
		// inbound messages then fail to re-arm the watchdog for the whole
		// buffering window and a long sync reads as a deaf session — a false
		// alert. Raw frames are never buffered, and for a deaf-session
		// detector any inbound frame (message, receipt, IQ, keep-alive reply)
		// is the truer liveness signal anyway. Detached again in stop().
		if (rawWs) {
			rawWs.on('message', markInbound)
		}
	}
	attachListeners()
	const watchdog = {
		markInbound,
		noteInbound: markInbound,
		check,
		start,
		stop,
		getState
	}
	if (autoStart) {
		start()
	}
	return watchdog
}
export const attachSessionWatchdog = (sock, options) => makeSessionWatchdog(sock, options)

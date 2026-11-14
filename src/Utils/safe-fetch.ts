// AunuBaileys (1.0.85): hardened HTTP(S) GET for everything the library
// fetches on behalf of a REMOTE PAGE — link previews and their
// thumbnails. The URL (and every redirect target) is attacker-
// controlled there: a chat peer can put any URL in a message, and the
// socket generates a preview for outgoing text automatically. The old
// path handed the fetch to link-preview-js, which resolved and
// connected wherever the URL pointed — loopback, RFC1918 and the
// 169.254 cloud-metadata address included (SSRF; the link-preview-js
// advisories GHSA-4gp8-rjrq-ch6q / GHSA-cpjf-6666-r8fx are the same
// class), and read the body with no size bound and no overall
// timeout (HB-205). This module therefore:
//   * resolves DNS itself and rejects non-public addresses AT
//     CONNECT TIME, via a guarded lookup: the address that was
//     validated is the address the socket connects to, so DNS
//     rebinding (the answer changing between "check" and "use") is
//     impossible by construction;
//   * checks IP-literal hosts (IPv4 in any notation the URL parser
//     produces, IPv6, IPv4-mapped / NAT64 / 6to4 embeddings);
//   * follows redirects manually, re-validating every hop, with a
//     hop limit, and always refuses an https -> http downgrade;
//   * bounds the response size (after decompression), the total
//     time and the per-hop idle time.
// Design follows the pattern proven by xdc-baileys' safe-fetch
// (reviewed statically in heartbeat run-0110); the redirect policy
// differs on purpose: redirects are followed across hosts ('any',
// max 5), because that is what this tree has always done via
// undici — the SSRF protection comes from validating every hop's
// address, not from pinning the host.
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net, { type LookupFunction } from 'node:net'
import zlib from 'node:zlib'

export class SafeFetchError extends Error {
	code: string
	host?: string
	address?: string
	statusCode?: number
	limit?: number

	constructor(code: string, message: string, extra: Record<string, any> = {}) {
		super(message)
		this.name = 'SafeFetchError'
		this.code = code
		Object.assign(this, extra)
	}
}

export const SAFE_FETCH_DEFAULTS = Object.freeze({
	timeout: 3000,
	maxRedirects: 5,
	maxBytes: 1024 * 1024
})

// ------------------------------------------------------------------
// address policy
const parseIPv4 = (s: string): number[] | null => {
	if (typeof s !== 'string' || !net.isIPv4(s)) {
		return null
	}

	return s.split('.').map(Number)
}

const parseIPv6 = (input: string): number[] | null => {
	if (typeof input !== 'string') {
		return null
	}

	let s = input.trim().toLowerCase()
	if (s.startsWith('[') && s.endsWith(']')) {
		s = s.slice(1, -1)
	}

	s = s.split('%')[0]!
	if (!net.isIPv6(s)) {
		return null
	}

	if (s.includes('.')) {
		const cut = s.lastIndexOf(':')
		const v4 = parseIPv4(s.slice(cut + 1))
		if (!v4) {
			return null
		}

		s = s.slice(0, cut + 1) + ((v4[0]! << 8) | v4[1]!).toString(16) + ':' + ((v4[2]! << 8) | v4[3]!).toString(16)
	}

	const parts = s.split('::')
	if (parts.length > 2) {
		return null
	}

	const left = parts[0] ? parts[0].split(':') : []
	const right = parts.length === 2 && parts[1] ? parts[1].split(':') : []
	let groups: string[]
	if (parts.length === 2) {
		const fill = 8 - left.length - right.length
		if (fill < 0) {
			return null
		}

		groups = [...left, ...Array(fill).fill('0'), ...right]
	} else {
		groups = left
	}

	if (groups.length !== 8) {
		return null
	}

	const bytes: number[] = []
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(g)) {
			return null
		}

		const n = parseInt(g, 16)
		bytes.push(n >> 8, n & 255)
	}

	return bytes
}

const isBlockedV4 = ([a, b, c]: number[]): boolean =>
	a === 0 || // 0.0.0.0/8 "this network"
	a === 10 || // private
	a === 127 || // loopback
	(a === 100 && b! >= 64 && b! <= 127) || // CGNAT 100.64.0.0/10
	(a === 169 && b === 254) || // link-local, cloud metadata
	(a === 172 && b! >= 16 && b! <= 31) || // private
	(a === 192 && b === 0 && c === 0) || // IETF protocol assignments
	(a === 192 && b === 0 && c === 2) || // TEST-NET-1
	(a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
	(a === 192 && b === 168) || // private
	(a === 198 && (b === 18 || b === 19)) || // benchmarking
	(a === 198 && b === 51 && c === 100) || // TEST-NET-2
	(a === 203 && b === 0 && c === 113) || // TEST-NET-3
	a! >= 224 // multicast, reserved, broadcast

const isBlockedV6 = (x: number[]): boolean => {
	const zero = (from: number, to: number) => x.slice(from, to).every(v => v === 0)
	if (zero(0, 10) && x[10] === 0xff && x[11] === 0xff) {
		return isBlockedV4(x.slice(12)) // ::ffff:a.b.c.d
	}

	if (zero(0, 12)) {
		return true // ::, ::1, ::a.b.c.d
	}

	if (x[0] === 0x00 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b) {
		if (zero(4, 12)) {
			return isBlockedV4(x.slice(12)) // 64:ff9b::/96 NAT64
		}

		if (x[4] === 0x00 && x[5] === 0x01) {
			return true // 64:ff9b:1::/48 local-use
		}
	}

	if (x[0] === 0x20 && x[1] === 0x02) {
		return isBlockedV4(x.slice(2, 6)) // 2002::/16 6to4
	}

	if (x[0] === 0x20 && x[1] === 0x01 && (x[2]! & 0xfe) === 0) {
		return true // 2001::/23 (Teredo, benchmarking, ORCHID)
	}

	if (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0x0d && x[3] === 0xb8) {
		return true // 2001:db8::/32 documentation
	}

	if (x[0] === 0x3f && x[1] === 0xff && (x[2]! & 0xf0) === 0) {
		return true // 3fff::/20 documentation
	}

	if (x[0] === 0x01 && zero(1, 8)) {
		return true // 100::/64 discard-only
	}

	if (x[0] === 0x5f) {
		return true // 5f00::/16 SRv6 SIDs
	}

	if ((x[0]! & 0xfe) === 0xfc) {
		return true // fc00::/7 unique-local
	}

	if (x[0] === 0xfe && (x[1]! & 0xc0) >= 0x80) {
		return true // fe80::/10 link-local, fec0::/10 site-local
	}

	if (x[0] === 0xff) {
		return true // multicast
	}

	return false
}

/** true when `address` must never be contacted. Unparseable input is blocked (fail closed). */
export const isBlockedAddress = (address: string): boolean => {
	const v4 = parseIPv4(address)
	if (v4) {
		return isBlockedV4(v4)
	}

	const v6 = parseIPv6(address)
	if (v6) {
		return isBlockedV6(v6)
	}

	return true
}

const blockedError = (host: string, address: string) =>
	new SafeFetchError('ERR_SSRF_BLOCKED', `refusing to connect to non-public address (${host} -> ${address})`, { host, address })

/**
 * dns.lookup-compatible function used as the socket's `lookup`. Fails
 * closed: if ANY resolved address is non-public the whole lookup is
 * rejected, so a mixed answer cannot smuggle one in.
 */
export const createGuardedLookup = (
	{ lookup = dns.lookup, isBlocked = isBlockedAddress }: { lookup?: any; isBlocked?: (address: string) => boolean } = {}
): LookupFunction =>
	((hostname: string, options: any, callback: any) => {
		if (typeof options === 'function') {
			callback = options
			options = {}
		}

		const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) }
		lookup(hostname, { ...opts, all: true }, (err: any, addresses: any) => {
			if (err) {
				return callback(err)
			}

			const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIPv6(addresses) ? 6 : 4 }]
			if (!list.length) {
				return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }))
			}

			for (const { address } of list) {
				if (isBlocked(address)) {
					return callback(blockedError(hostname, address))
				}
			}

			if ((opts as any).all) {
				return callback(null, list)
			}

			callback(null, list[0].address, list[0].family)
		})
	}) as LookupFunction

// ------------------------------------------------------------------
// helpers
const hostOf = (url: URL) => (url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname)

const sameSite = (a: URL, b: URL) => {
	const x = a.hostname.toLowerCase()
	const y = b.hostname.toLowerCase()
	return x === y || x === 'www.' + y || 'www.' + x === y
}

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

const normalizeUrl = (input: string | URL): URL => {
	let url: URL
	try {
		url = input instanceof URL ? new URL(input.href) : new URL(String(input))
	} catch {
		throw new SafeFetchError('ERR_INVALID_URL', 'invalid URL')
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new SafeFetchError('ERR_INVALID_URL', `unsupported protocol ${url.protocol}`)
	}

	if (url.username || url.password) {
		throw new SafeFetchError('ERR_INVALID_URL', 'URLs with embedded credentials are not allowed')
	}

	return url
}

const DECODERS: { [encoding: string]: () => any } = {
	gzip: zlib.createGunzip,
	'x-gzip': zlib.createGunzip,
	deflate: zlib.createInflate,
	br: zlib.createBrotliDecompress
}

const lowerHeaders = (h: { [k: string]: any } = {}): { [k: string]: any } => {
	const out: { [k: string]: any } = {}
	for (const [k, v] of Object.entries(h)) {
		if (v !== undefined && v !== null) {
			out[k.toLowerCase()] = v
		}
	}

	return out
}

// ------------------------------------------------------------------
// transport + body reader
type Hop = { status: number; headers: { [k: string]: any }; stream: any; decoded: boolean }

const nodeTransport =
	({ lookup, timeout }: { lookup: LookupFunction; timeout: number }) =>
	(url: URL, headers: { [k: string]: any }, signal: AbortSignal): Promise<Hop> =>
		new Promise((resolve, reject) => {
			const mod = url.protocol === 'https:' ? https : http
			const req = mod.request(
				url,
				{
					method: 'GET',
					headers,
					lookup,
					signal,
					agent: false,
					timeout,
					maxHeaderSize: 16 * 1024
				},
				res => resolve({ status: res.statusCode!, headers: res.headers, stream: res, decoded: false })
			)
			req.on('timeout', () => req.destroy(new SafeFetchError('ERR_TIMEOUT', 'request timed out')))
			req.on('error', reject)
			req.end()
		})

const readBody = async (hop: Hop, { maxBytes, onLimit, signal }: { maxBytes: number; onLimit: 'throw' | 'truncate'; signal: AbortSignal }) => {
	const encoding = String(hop.headers['content-encoding'] || '')
		.toLowerCase()
		.trim()
	let source = hop.stream
	let decoder: any
	if (!hop.decoded && encoding && encoding !== 'identity') {
		const make = DECODERS[encoding]
		if (!make) {
			hop.stream.destroy()
			throw new SafeFetchError('ERR_UNSUPPORTED_ENCODING', `unsupported content-encoding ${encoding}`)
		}

		decoder = make()
		hop.stream.on('error', (e: Error) => decoder.destroy(e))
		source = hop.stream.pipe(decoder)
	}

	const declared = Number(hop.headers['content-length'])
	if (onLimit === 'throw' && !encoding && Number.isFinite(declared) && declared > maxBytes) {
		hop.stream.destroy()
		throw new SafeFetchError('ERR_RESPONSE_TOO_LARGE', `response larger than ${maxBytes} bytes`, { limit: maxBytes })
	}

	const stop = () => {
		decoder?.destroy()
		hop.stream.destroy()
	}
	const onAbort = () => hop.stream.destroy(new SafeFetchError('ERR_TIMEOUT', 'request timed out'))
	signal.addEventListener('abort', onAbort, { once: true })
	const chunks: Buffer[] = []
	let total = 0
	let truncated = false
	try {
		for await (const chunk of source) {
			const buf = chunk as Buffer
			total += buf.length
			if (total > maxBytes) {
				if (onLimit === 'truncate') {
					chunks.push(buf.subarray(0, buf.length - (total - maxBytes)))
					truncated = true
					break
				}

				throw new SafeFetchError('ERR_RESPONSE_TOO_LARGE', `response larger than ${maxBytes} bytes`, { limit: maxBytes })
			}

			chunks.push(buf)
		}
	} finally {
		signal.removeEventListener('abort', onAbort)
		stop()
	}

	return { body: Buffer.concat(chunks), truncated }
}

// ------------------------------------------------------------------
// public API
export type SafeHttpGetOptions = {
	/** idle/connect timeout per hop in ms (default 3000) */
	timeout?: number
	/** hard deadline for the whole call incl. redirects (default 3 x timeout) */
	totalTimeout?: number
	/** response cap in bytes, applied after decompression (default 1 MiB) */
	maxBytes?: number
	/** 'throw' (default) or 'truncate' when the cap is hit */
	onLimit?: 'throw' | 'truncate'
	/** default 5 */
	maxRedirects?: number
	/** 'any' (default) | 'same-host' | 'none'. Every hop is address-checked either way. */
	redirects?: 'any' | 'same-host' | 'none'
	headers?: Record<string, string>
	/** return false to skip downloading the body */
	shouldReadBody?: (status: number, headers: Record<string, string>) => boolean
	/** explicit opt-out of the address policy (default false) */
	allowPrivateNetworks?: boolean
	/** injection points (host hooks, tests) */
	lookup?: LookupFunction
	isBlocked?: (address: string) => boolean
}

export type SafeHttpGetResult = {
	url: string
	status: number
	headers: Record<string, string>
	body: Buffer
	truncated: boolean
	redirects: number
}

/**
 * GET `input` and return { url, status, headers, body, truncated, redirects }.
 *
 * options:
 *   timeout            idle/connect timeout per hop in ms (default 3000)
 *   totalTimeout       hard deadline for the whole call incl. redirects (default 3 x timeout)
 *   maxBytes           response cap in bytes, applied after decompression (default 1 MiB)
 *   onLimit            'throw' (default) or 'truncate' when the cap is hit
 *   maxRedirects       default 5
 *   redirects          'any' (default) | 'same-host' | 'none'. Every hop is
 *                      address-checked either way. https -> http downgrades
 *                      are always refused.
 *   headers            request headers
 *   shouldReadBody     (status, headers) => boolean; return false to skip the body
 *   allowPrivateNetworks  explicit opt-out of the address policy (default false)
 *   lookup / isBlocked    injection points (host hooks, tests)
 */
export async function safeHttpGet(input: string | URL, options: SafeHttpGetOptions = {}): Promise<SafeHttpGetResult> {
	const {
		timeout = SAFE_FETCH_DEFAULTS.timeout,
		maxBytes = SAFE_FETCH_DEFAULTS.maxBytes,
		onLimit = 'throw',
		maxRedirects = SAFE_FETCH_DEFAULTS.maxRedirects,
		redirects = 'any',
		headers: userHeaders,
		shouldReadBody,
		allowPrivateNetworks = false,
		lookup: customLookup
	} = options
	const baseLookup: any = customLookup ?? dns.lookup
	const totalTimeout = options.totalTimeout ?? timeout * 3
	const isBlocked = allowPrivateNetworks ? () => false : (options.isBlocked ?? isBlockedAddress)
	const transport = nodeTransport({ lookup: createGuardedLookup({ lookup: baseLookup, isBlocked }), timeout })
	const controller = new AbortController()
	const deadline = setTimeout(() => controller.abort(), totalTimeout)
	;(deadline as any).unref?.()
	let url = normalizeUrl(input)
	const origin = url
	let headers: { [k: string]: any } = {
		'user-agent': 'node',
		accept: '*/*',
		'accept-encoding': 'gzip, deflate, br',
		...lowerHeaders(userHeaders)
	}
	try {
		for (let hops = 0; ; hops++) {
			const host = hostOf(url)
			if (net.isIP(host) && isBlocked(host)) {
				throw blockedError(host, host)
			}

			let hop: Hop
			try {
				hop = await transport(url, headers, controller.signal)
			} catch (e: any) {
				if (e instanceof SafeFetchError) {
					throw e
				}

				if (controller.signal.aborted || e?.name === 'AbortError') {
					throw new SafeFetchError('ERR_TIMEOUT', 'request timed out')
				}

				// dns.lookup errors surface our SafeFetchError through
				// the socket as the same object
				throw e?.cause instanceof SafeFetchError ? e.cause : e
			}

			const hopHeaders = lowerHeaders(hop.headers)
			hop.headers = hopHeaders
			if (hop.status >= 300 && hop.status < 400 && hopHeaders.location) {
				hop.stream.destroy()
				if (redirects === 'none') {
					throw new SafeFetchError('ERR_REDIRECT_NOT_ALLOWED', 'redirects are not allowed')
				}

				if (hops >= maxRedirects) {
					throw new SafeFetchError('ERR_TOO_MANY_REDIRECTS', `more than ${maxRedirects} redirects`)
				}

				let next: URL
				try {
					next = normalizeUrl(new URL(String(hopHeaders.location), url))
				} catch (e) {
					throw e instanceof SafeFetchError ? e : new SafeFetchError('ERR_INVALID_URL', 'invalid redirect target')
				}

				if (url.protocol === 'https:' && next.protocol === 'http:') {
					throw new SafeFetchError('ERR_REDIRECT_NOT_ALLOWED', 'https to http downgrade refused')
				}

				if (redirects === 'same-host' && !sameSite(origin, next)) {
					throw new SafeFetchError('ERR_REDIRECT_NOT_ALLOWED', 'redirect to a different host refused')
				}

				if (next.host !== url.host) {
					headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !SENSITIVE_HEADERS.includes(k)))
				}

				url = next
				continue
			}

			if (hop.status < 200 || hop.status >= 300) {
				hop.stream.destroy()
				throw new SafeFetchError('ERR_HTTP_STATUS', `request failed with status ${hop.status}`, { statusCode: hop.status })
			}

			if (shouldReadBody && !shouldReadBody(hop.status, hopHeaders)) {
				hop.stream.destroy()
				return { url: url.href, status: hop.status, headers: hopHeaders, body: Buffer.alloc(0), truncated: false, redirects: hops }
			}

			const { body, truncated } = await readBody(hop, { maxBytes, onLimit, signal: controller.signal })
			return { url: url.href, status: hop.status, headers: hopHeaders, body, truncated, redirects: hops }
		}
	} catch (e: any) {
		if (controller.signal.aborted && !(e instanceof SafeFetchError && e.code !== 'ERR_TIMEOUT')) {
			throw new SafeFetchError('ERR_TIMEOUT', 'request timed out')
		}

		throw e
	} finally {
		clearTimeout(deadline)
	}
}

// ------------------------------------------------------------------
// image sanity (pixel bombs)
/** Reads width/height from PNG, GIF, JPEG and WebP headers without decoding. null if unknown. */
export const readImageDimensions = (buf: Buffer): { width: number; height: number } | null => {
	if (!Buffer.isBuffer(buf) || buf.length < 12) {
		return null
	}

	if (buf.readUInt32BE(0) === 0x89504e47 && buf.length >= 24) {
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
	}

	if (buf.toString('latin1', 0, 3) === 'GIF' && buf.length >= 10) {
		return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
	}

	if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP' && buf.length >= 30) {
		const kind = buf.toString('latin1', 12, 16)
		if (kind === 'VP8X') {
			return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
		}

		if (kind === 'VP8L') {
			const b = buf.readUInt32LE(21)
			return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }
		}

		if (kind === 'VP8 ') {
			return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
		}

		return null
	}

	if (buf[0] === 0xff && buf[1] === 0xd8) {
		let i = 2
		while (i + 9 < buf.length) {
			if (buf[i] !== 0xff) {
				i++
				continue
			}

			const marker = buf[i + 1]!
			if (marker === 0xff) {
				i++
				continue
			}

			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
			}

			if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
				i += 2
				continue
			}

			i += 2 + buf.readUInt16BE(i + 2)
		}
	}

	return null
}

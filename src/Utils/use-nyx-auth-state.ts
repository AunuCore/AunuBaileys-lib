import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { AuthenticationState } from '../Types'
import type { ILogger } from './logger'
import { BufferJSON } from './generics'
import { isValidCredsShape, useMultiFileAuthState } from './use-multi-file-auth-state'

// AunuBaileys (2.6.0, useNyxAuthState — opt-in variant, NEVER a
// replacement for useMultiFileAuthState): the default store loses
// the session when creds.json is corrupt or missing (the loader
// treats it as absent and starts fresh creds, so the user must
// re-pair). This variant keeps a last-known-good copy
// (creds.json.bak) and restores it automatically, quarantines a
// corrupt creds.json (.corrupt-<timestamp>) instead of deleting
// it, and adds export/import of the whole session folder. Key
// storage delegates to the base store, so it inherits the
// HB-2026-1112-38 cross-file atomicity fix; the .bak update is
// best-effort and never fails a save.

const CREDS_FILE = 'creds.json'
const BACKUP_FILE = 'creds.json.bak'

// AunuBaileys (2.6.0, HB-477): the recovery gate is the SAME strict
// gate the base loader applies at load (isValidCredsShape, shared —
// never a second copy that can drift from it). The light check this
// file used to carry only looked at key-pair shapes + a finite
// registrationId + an advSecretKey string, so creds that fail the
// strict gate (a 63-byte signature, a 31-byte advSecretKey, a string
// 'false' registered flag, …) were left in place — no quarantine, no
// .bak restore — while the base loader then discarded them for fresh
// creds anyway: session lost although a valid .bak existed, and the
// failure repeated every boot. The parse MUST use the BufferJSON
// reviver: on disk, key material is { type: 'Buffer', data: '<base64>' },
// and the strict gate measures decoded lengths — a raw parse would
// see plain objects and reject every valid file. A reviver throw
// (invalid base64 / bad byte values) means corrupt, same as
// unparseable JSON.
const parseCredsShape = (raw: string): boolean => {
	try {
		return isValidCredsShape(JSON.parse(raw, BufferJSON.reviver))
	} catch {
		return false
	}
}

// Runs BEFORE the base loader reads creds.json: a valid creds
// file is untouched; a missing or corrupt/invalid one is restored
// from creds.json.bak when the backup is valid, and a
// present-but-invalid creds.json is quarantined first so the
// corrupt bytes survive for forensics. When both are bad the
// base loader starts fresh creds, exactly like the default store.
const recoverCreds = async (folder: string, logger?: ILogger): Promise<void> => {
	const credsPath = join(folder, CREDS_FILE)
	const bakPath = join(folder, BACKUP_FILE)

	let credsRaw: string | null = null
	try {
		credsRaw = await readFile(credsPath, 'utf-8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			logger?.warn(
				{ err: (error as Error)?.message || String(error) },
				'aunu: nyx could not read creds.json; treating as missing'
			)
		}
	}

	if (credsRaw !== null && parseCredsShape(credsRaw)) {
		return
	}

	if (credsRaw !== null) {
		const quarantine = join(folder, `${CREDS_FILE}.corrupt-${Date.now()}`)
		try {
			await rename(credsPath, quarantine)
			logger?.warn({ file: quarantine }, 'aunu: nyx quarantined a corrupt creds.json')
		} catch (error) {
			logger?.warn(
				{ err: (error as Error)?.message || String(error) },
				'aunu: nyx could not quarantine a corrupt creds.json'
			)
		}
	}

	let bakRaw: string | null = null
	try {
		bakRaw = await readFile(bakPath, 'utf-8')
	} catch {
		bakRaw = null
	}

	if (bakRaw === null) {
		return
	}

	if (!parseCredsShape(bakRaw)) {
		logger?.warn('aunu: nyx backup creds.json.bak is also invalid — starting fresh')
		return
	}

	const tmpPath = join(folder, `${CREDS_FILE}.tmp-nyx-${process.pid}-${randomBytes(4).toString('hex')}`)
	try {
		await writeFile(tmpPath, bakRaw, { mode: 0o600 })
		await rename(tmpPath, credsPath)
		logger?.info('aunu: nyx restored creds.json from creds.json.bak')
	} catch (error) {
		await unlink(tmpPath).catch(() => {})
		logger?.warn(
			{ err: (error as Error)?.message || String(error) },
			'aunu: nyx could not restore creds.json from backup'
		)
	}
}

export const useNyxAuthState = async (
	folder: string,
	logger?: ILogger
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
	await recoverCreds(folder, logger)
	const base = await useMultiFileAuthState(folder, logger)

	const saveCreds = async () => {
		await base.saveCreds()
		// Best-effort last-known-good backup: a failed backup
		// must never fail the save itself. The tmp name carries a
		// random suffix so concurrent saves cannot clobber each
		// other's tmp file; the rename is atomic and the content
		// is always one complete creds.json snapshot.
		try {
			const credsRaw = await readFile(join(folder, CREDS_FILE), 'utf-8')
			const tmpPath = join(folder, `${BACKUP_FILE}.tmp-nyx-${process.pid}-${randomBytes(4).toString('hex')}`)
			try {
				await writeFile(tmpPath, credsRaw, { mode: 0o600 })
				await rename(tmpPath, join(folder, BACKUP_FILE))
			} catch (error) {
				await unlink(tmpPath).catch(() => {})
				throw error
			}
		} catch (error) {
			logger?.warn(
				{ err: (error as Error)?.message || String(error) },
				'aunu: nyx could not update creds.json.bak; the save itself succeeded'
			)
		}
	}

	return { state: base.state, saveCreds }
}

const BACKUP_FORMAT = 'aunubaileys-nyx-backup'
const BACKUP_VERSION = 1

type SessionBackupBundle = {
	format: string
	version: number
	files: Record<string, string>
}

/**
 * Pack a session folder into one portable Buffer: every file in
 * the folder (except tmp + quarantined files) as base64. With a
 * password the bundle is gzipped and AES-256-GCM encrypted with a
 * scrypt-derived key (random salt/IV per export); without one it
 * is plain JSON. The plain form contains live session keys — treat
 * it like a private key.
 */
export const exportSessionBackup = async (folder: string, opts?: { password?: string }): Promise<Buffer> => {
	const entries = await readdir(folder)
	const files: Record<string, string> = {}
	for (const name of entries) {
		if (name.includes('.tmp-') || name.includes('.corrupt-')) {
			continue
		}

		const full = join(folder, name)
		const info = await stat(full).catch(() => undefined)
		if (!info || !info.isFile()) {
			continue
		}

		files[name] = (await readFile(full)).toString('base64')
	}

	const bundle: SessionBackupBundle = { format: BACKUP_FORMAT, version: BACKUP_VERSION, files }
	const plain = Buffer.from(JSON.stringify(bundle), 'utf-8')
	if (!opts?.password) {
		return plain
	}

	const salt = randomBytes(16)
	const iv = randomBytes(12)
	const key = scryptSync(opts.password, salt, 32)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const compressed = gzipSync(plain)
	const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()])
	const envelope = {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		encrypted: true,
		kdf: 'scrypt',
		salt: salt.toString('base64'),
		iv: iv.toString('base64'),
		authTag: cipher.getAuthTag().toString('base64'),
		data: encrypted.toString('base64')
	}
	return Buffer.from(JSON.stringify(envelope), 'utf-8')
}

const isSafeBackupName = (name: string): boolean => {
	if (!name || name === '.' || name === '..') {
		return false
	}

	if (name.includes('/') || name.includes('\\') || name.startsWith('/')) {
		return false
	}

	return true
}

// AunuBaileys (2.6.0, HB-478): Buffer.from(x, 'base64') never
// throws and silently drops characters outside the alphabet, so a
// garbage payload used to decode into junk and overwrite a good file
// without any error. Require strict canonical base64: only alphabet
// characters plus at most two '=' at the end, a length that is a
// multiple of 4, and a re-encode that reproduces the input
// byte-for-byte (this also rejects non-canonical trailing bits).
const isStrictBase64 = (value: string): boolean => {
	if (value.length % 4 !== 0) {
		return false
	}

	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
		return false
	}

	return Buffer.from(value, 'base64').toString('base64') === value
}

/**
 * Restore a backup produced by exportSessionBackup into a folder:
 * the bundle is fully validated first (format, version, safe file
 * names, strict base64 payloads, and a creds.json that passes the
 * shared strict creds gate; a wrong password fails the GCM auth-tag
 * check), then every file is staged to tmp and renamed into place.
 * A failure during the rename rolls every already-replaced file back
 * to its previous bytes, so a failed import leaves the folder exactly
 * as it was. Files the bundle does not carry are left alone.
 */
export const importSessionBackup = async (folder: string, backup: Buffer, opts?: { password?: string }): Promise<void> => {
	const parsed = JSON.parse(backup.toString('utf-8')) as Record<string, unknown>

	let bundle: SessionBackupBundle
	if (parsed.encrypted === true) {
		if (!opts?.password) {
			throw new Error('aunu: nyx backup is password-encrypted; a password is required')
		}

		// AunuBaileys (2.7.0, HB-478 facet 3): validate the envelope
		// BEFORE any crypto — a missing/non-string field used to hit
		// Buffer.from as a raw TypeError, and a short iv/authTag/salt
		// produced a GCM error byte-identical to a wrong password, so
		// a corrupt/truncated envelope was indistinguishable from a
		// bad password. All four fields must be strict base64 with
		// the exact sizes exportSessionBackup writes (salt >= 16
		// bytes, iv 12 bytes, authTag 16 bytes, data non-empty);
		// anything else is a malformed envelope, reported as such.
		const envelopeFields: Record<string, unknown> = {
			salt: parsed.salt,
			iv: parsed.iv,
			authTag: parsed.authTag,
			data: parsed.data
		}
		for (const field of Object.keys(envelopeFields)) {
			const value = envelopeFields[field]
			if (typeof value !== 'string' || !isStrictBase64(value)) {
				throw new Error(`aunu: nyx backup envelope is malformed: field ${field} is missing or not valid base64`)
			}
		}

		const salt = Buffer.from(parsed.salt as string, 'base64')
		const iv = Buffer.from(parsed.iv as string, 'base64')
		const authTag = Buffer.from(parsed.authTag as string, 'base64')
		const data = Buffer.from(parsed.data as string, 'base64')
		if (salt.length < 16 || iv.length !== 12 || authTag.length !== 16 || data.length === 0) {
			throw new Error(
				'aunu: nyx backup envelope is malformed: salt must be at least 16 bytes, iv exactly 12 bytes, authTag exactly 16 bytes and data non-empty'
			)
		}
		const key = scryptSync(opts.password, salt, 32)
		const decipher = createDecipheriv('aes-256-gcm', key, iv)
		decipher.setAuthTag(authTag)
		const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
		bundle = JSON.parse(gunzipSync(decrypted).toString('utf-8')) as SessionBackupBundle
	} else {
		bundle = parsed as unknown as SessionBackupBundle
	}

	if (
		bundle.format !== BACKUP_FORMAT ||
		bundle.version !== BACKUP_VERSION ||
		!bundle.files ||
		typeof bundle.files !== 'object' ||
		Array.isArray(bundle.files)
	) {
		throw new Error('aunu: nyx backup is not a recognised AunuBaileys session backup')
	}

	const names = Object.keys(bundle.files).sort()
	for (const name of names) {
		const payload = bundle.files[name]
		if (!isSafeBackupName(name) || typeof payload !== 'string') {
			throw new Error(`aunu: nyx backup carries an unsafe file entry: ${name}`)
		}

		// AunuBaileys (2.6.0, HB-478): validate the payload BEFORE
		// staging — a garbage entry must refuse the whole bundle,
		// not overwrite a good file with decoded junk.
		if (!isStrictBase64(payload)) {
			throw new Error(`aunu: nyx backup carries an invalid base64 payload: ${name}`)
		}

		// AunuBaileys (2.7.0, HB-478 facet 4): strict base64 alone is
		// not a content gate — '' is strict base64 (0 bytes), 'AAAA'
		// decodes to NUL bytes and 'bnVsbA==' to JSON null, and only
		// creds.json had a content gate, so such payloads for a key
		// file imported silently and overwrote a good session file
		// with empty/garbage bytes the loader then read as missing.
		// Every file the store writes is JSON, so reject a payload
		// whose decoded bytes are empty or do not parse as JSON
		// (a JSON null is not a usable store file either) for EVERY
		// entry, not just creds.json.
		const decodedPayload = Buffer.from(payload, 'base64')
		if (decodedPayload.length === 0) {
			throw new Error(`aunu: nyx backup carries an empty payload: ${name}`)
		}

		let parsedPayload: unknown
		try {
			parsedPayload = JSON.parse(decodedPayload.toString('utf-8'))
		} catch {
			throw new Error(`aunu: nyx backup carries a non-JSON payload: ${name}`)
		}

		if (parsedPayload === null || typeof parsedPayload !== 'object') {
			throw new Error(`aunu: nyx backup carries a non-JSON payload: ${name}`)
		}
	}

	// AunuBaileys (2.6.0, HB-478): well-formed base64 can still be
	// junk bytes — a creds.json that fails the shared strict gate
	// would be discarded by the base loader at the next boot, so
	// refuse the bundle now instead of overwriting good creds with
	// a session that can never load. parseCredsShape parses with the
	// BufferJSON reviver, so the gate measures decoded key lengths.
	const credsPayload = bundle.files[CREDS_FILE]
	if (typeof credsPayload === 'string') {
		const decoded = Buffer.from(credsPayload, 'base64').toString('utf-8')
		if (!parseCredsShape(decoded)) {
			throw new Error('aunu: nyx backup carries a creds.json that fails the strict creds shape check')
		}
	}

	await mkdir(folder, { recursive: true, mode: 0o700 })

	// Stage every file first, then rename them all into place —
	// a failure during staging leaves the live folder untouched.
	const staged: { name: string; tmpPath: string }[] = []
	try {
		for (const name of names) {
			const contents = Buffer.from(bundle.files[name] as string, 'base64')
			const tmpPath = join(folder, `${name}.tmp-import-${process.pid}-${randomBytes(4).toString('hex')}`)
			await writeFile(tmpPath, contents, { mode: 0o600 })
			staged.push({ name, tmpPath })
		}
	} catch (error) {
		for (const { tmpPath } of staged) {
			await unlink(tmpPath).catch(() => {})
		}

		throw error
	}

	// AunuBaileys (2.6.0, HB-478): the rename loop used to replace
	// files one by one with no way back — a failure on the Nth rename
	// left files 1..N-1 already replaced, a mixed generation no
	// session ever had. Snapshot every target's current bytes first
	// (the HB-2026-1112-38 rollback pattern) and roll them all back
	// when one rename fails, so a failed import leaves the folder
	// exactly as it was. A target that does not exist rolls back to
	// absent (unlinked); a non-file target (e.g. a directory) can
	// never be replaced by rename, so it needs no snapshot. A
	// snapshot read error aborts before any rename.
	const snapshots = new Map<string, Buffer | null>()
	const renamed: { name: string; tmpPath: string }[] = []
	try {
		for (const name of names) {
			const target = join(folder, name)
			const info = await stat(target).catch(() => undefined)
			if (!info) {
				snapshots.set(name, null)
			} else if (info.isFile()) {
				snapshots.set(name, await readFile(target))
			}
		}

		for (const { name, tmpPath } of staged) {
			await rename(tmpPath, join(folder, name))
			renamed.push({ name, tmpPath })
		}
	} catch (error) {
		// Roll back in reverse order, best-effort: a failed rollback
		// must never mask the original error. The snapshot bytes go
		// back through tmp+rename, never a direct overwrite, so a
		// crash mid-rollback cannot leave a truncated file behind.
		for (const { name } of renamed.reverse()) {
			const snapshot = snapshots.get(name)
			if (snapshot === null) {
				await unlink(join(folder, name)).catch(() => {})
			} else if (snapshot !== undefined) {
				const rollbackTmp = join(folder, `${name}.tmp-import-rollback-${process.pid}-${randomBytes(4).toString('hex')}`)
				try {
					await writeFile(rollbackTmp, snapshot, { mode: 0o600 })
					await rename(rollbackTmp, join(folder, name))
				} catch {
					await unlink(rollbackTmp).catch(() => {})
				}
			}
		}

		// Any staged file that never landed is still a tmp file.
		for (const { tmpPath } of staged) {
			await unlink(tmpPath).catch(() => {})
		}

		throw error
	}
}

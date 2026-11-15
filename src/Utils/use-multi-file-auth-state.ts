import { Mutex } from './mutex'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import type { ILogger } from './logger'
import { join } from 'path'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'

// We need to lock files due to the fact that we are using async functions to read and write files
// https://github.com/WhiskeySockets/Baileys/issues/794
// https://github.com/nodejs/node/issues/26338
// Use a Map to store mutexes for each file path
const fileLocks = new Map<string, Mutex>()

// Get or create a mutex for a specific file path
const MAX_FILE_LOCKS = 1000

const getFileLock = (path: string): Mutex => {
	let mutex = fileLocks.get(path)
	if (!mutex) {
		mutex = new Mutex()
		fileLocks.set(path, mutex)
		// AunuBaileys (2.1.0, HB-296, donor v6): one Mutex per auth file forever grew this map without bound — evict the oldest UNLOCKED entry past the cap (a locked one is in use and must stay).
		if (fileLocks.size > MAX_FILE_LOCKS) {
			for (const [key, m] of fileLocks) {
				if (key !== path && !m.isLocked()) {
					fileLocks.delete(key)
					break
				}
			}
		}
	}

	return mutex
}

/**
 * stores the full authentication state in a single folder.
 * Far more efficient than singlefileauthstate
 *
 * Again, I wouldn't endorse this for any production level use other than perhaps a bot.
 * Would recommend writing an auth state for use with a proper SQL or No-SQL DB
 * */
// AunuBaileys (HB-151, re-applied P3): the shape a complete creds
// state must have at load (see the load site below).
const isCredsKeyPair = (kp: any) =>
	!!kp &&
	typeof kp === 'object' &&
	(Buffer.isBuffer(kp.private) || typeof kp.private === 'string') &&
	(Buffer.isBuffer(kp.public) || typeof kp.public === 'string')
const isValidCredsShape = (creds: any) =>
	!!creds &&
	typeof creds === 'object' &&
	!Array.isArray(creds) &&
	isCredsKeyPair(creds.noiseKey) &&
	isCredsKeyPair(creds.signedIdentityKey) &&
	isCredsKeyPair(creds.signedPreKey?.keyPair) &&
	(Buffer.isBuffer(creds.signedPreKey?.signature) || typeof creds.signedPreKey?.signature === 'string') &&
	Number.isFinite(creds.signedPreKey?.keyId) &&
	Number.isFinite(creds.registrationId) &&
	typeof creds.advSecretKey === 'string' &&
	creds.advSecretKey.length > 0 &&
	isCredsKeyPair(creds.pairingEphemeralKeyPair)

export const useMultiFileAuthState = async (
	folder: string,
	logger?: ILogger
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const writeData = async (data: any, file: string) => {
		const filePath = join(folder, fixFileName(file)!)
		const mutex = getFileLock(filePath)

		return mutex.acquire().then(async release => {
			try {
				// AunuBaileys (2.1.0, HB-303, donor v6): atomic tmp+rename — a crash mid-write used to leave a truncated auth file behind (a lost WhatsApp identity). Write the tmp file 0600; the rename carries the mode onto the target, so pre-existing looser files also self-heal to 0600 on their next save.
				const tmpPath = `${filePath}.tmp-${process.pid}`
				await writeFile(tmpPath, JSON.stringify(data, BufferJSON.replacer), { mode: 0o600 })
				await rename(tmpPath, filePath)
			} catch (err) {
				// AunuBaileys (2.1.0, HB-318, donor v6): a failed persist (full disk, permissions) must be visible where it happens — it otherwise surfaces one boot later as a random logout. Still thrown.
				logger?.error({ file, err: (err as Error)?.message || String(err) }, 'aunu: failed to persist auth file')
				throw err
			} finally {
				release()
			}
		})
	}

	const readData = async (file: string) => {
		try {
			const filePath = join(folder, fixFileName(file)!)
			const mutex = getFileLock(filePath)

			return await mutex.acquire().then(async release => {
				try {
					const data = await readFile(filePath, { encoding: 'utf-8' })
					return JSON.parse(data, BufferJSON.reviver)
				} finally {
					release()
				}
			})
		} catch (error) {
			// AunuBaileys (2.1.0, HB-318, donor v6): a missing file is a normal first run and stays silent; anything else (corrupt JSON, unreadable file) means stored state is being silently discarded — say so, loudly.
			if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
				logger?.error({ file, err: (error as Error)?.message || String(error) }, 'aunu: auth file unreadable or corrupt — treating as missing')
			}
			return null
		}
	}

	const removeData = async (file: string) => {
		try {
			const filePath = join(folder, fixFileName(file)!)
			const mutex = getFileLock(filePath)

			return mutex.acquire().then(async release => {
				try {
					await unlink(filePath)
				} catch {
				} finally {
					release()
				}
			})
		} catch {}
	}

	const folderInfo = await stat(folder).catch(() => {})
	if (folderInfo) {
		if (!folderInfo.isDirectory()) {
			throw new Error(
				`found something that is not a directory at ${folder}, either delete it or specify a different location`
			)
		}
	} else {
		await mkdir(folder, { recursive: true })
	}

	const fixFileName = (file?: string) => file?.replace(/\//g, '__')?.replace(/:/g, '-')

	const storedCreds: any = await readData('creds.json')
	// AunuBaileys (1.0.79, HB-151 + 1.0.88 HB-80 addendum, re-applied
	// P3): a creds.json that parses to {} / a partial object used to be
	// accepted as a complete auth state (it is truthy) and every
	// downstream consumer then failed in its own misleading way.
	// Validate the shape at this one load choke point; a
	// present-but-invalid creds is discarded, exactly like corrupt
	// JSON. Key material follows the HB-98 test (Buffer or base64
	// string); ids must be finite numbers.
	const creds: AuthenticationCreds = isValidCredsShape(storedCreds)
		? storedCreds
		: (() => {
				// AunuBaileys (2.1.0, HB-318, donor v6): a present-but-invalid creds.json used to be discarded silently — say so, loudly.
				if (storedCreds) {
					logger?.error(
						{ file: 'creds.json' },
						'aunu: creds.json does not have the shape of a complete auth state — discarding it and starting fresh; restore a full backup or pair again'
					)
				}
				return initAuthCreds()
			})()

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					await Promise.all(
						ids.map(async id => {
							let value = await readData(`${type}-${id}.json`)
							if (type === 'app-state-sync-key' && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value)
							}

							data[id] = value
						})
					)

					return data
				},
				set: async data => {
					const tasks: Promise<void>[] = []
					for (const category in data) {
						for (const id in data[category as keyof SignalDataTypeMap]) {
							const value = data[category as keyof SignalDataTypeMap]![id]
							const file = `${category}-${id}.json`
							tasks.push(value ? writeData(value, file) : removeData(file))
						}
					}

					await Promise.all(tasks)
				}
			}
		},
		saveCreds: async () => {
			return writeData(creds, 'creds.json')
		}
	}
}

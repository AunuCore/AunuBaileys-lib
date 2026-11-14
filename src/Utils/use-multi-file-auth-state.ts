import { Mutex } from './mutex'
import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
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
const getFileLock = (path: string): Mutex => {
	let mutex = fileLocks.get(path)
	if (!mutex) {
		mutex = new Mutex()
		fileLocks.set(path, mutex)
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
	folder: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const writeData = async (data: any, file: string) => {
		const filePath = join(folder, fixFileName(file)!)
		const mutex = getFileLock(filePath)

		return mutex.acquire().then(async release => {
			try {
				// AunuBaileys (HB-116, re-applied P3): auth files hold
				// credential material \u2014 write them owner-only (0600),
				// never with the process-default mode.
				await writeFile(filePath, JSON.stringify(data, BufferJSON.replacer), { mode: 0o600 })
				// mode only applies at creation \u2014 chmod so a pre-existing
				// looser file self-heals to 0600 on its next save (v6 parity).
				await chmod(filePath, 0o600).catch(() => {})
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
	const creds: AuthenticationCreds = isValidCredsShape(storedCreds) ? storedCreds : initAuthCreds()

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

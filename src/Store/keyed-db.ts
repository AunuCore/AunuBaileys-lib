/**
 * AunuBaileys (P9, 2.0.0): internal replacement for the
 * `@adiwajshing/keyed-db` package, ported behaviour-for-behaviour
 * from its published 0.2.4 build (the only version this tree ever
 * resolved).
 *
 * The in-memory store's public surface — and downstream bots like
 * Tenka that read `store.chats` / `store.labelAssociations` directly
 * — depend on the exact semantics ported here, including the sharp
 * edges:
 * - `_insertSingle` throws `duplicate ID being inserted: <id>` and
 *   `duplicate key: <key>, of inserting: <id>, present: <id>`; the
 *   store's HB-274/HB-278 isolation handlers catch exactly those.
 * - `update` deletes the dict entry and splices the array BEFORE
 *   re-inserting under the new sort key, so a colliding re-insert
 *   leaves the value OUT of the DB — the HB-278 handler-side
 *   snapshot/restore in make-in-memory-store.ts exists because of
 *   this order and stays the safety net; it is NOT 'fixed' here.
 * - `upsert` returns only the values that replaced an existing entry,
 *   `insertIfAbsent` returns only the values actually inserted.
 *
 * Equivalence with the npm package is proven by the P9 differential
 * harness, which runs identical operation sequences (including the
 * HB-274/HB-278 collision cases) against both implementations and
 * compares the resulting array order, dict contents and return values
 * after every step.
 */

export type PaginationMode = 'before' | 'after'

/** Order-by key extractor + comparator (the package's `Comparable`) */
export interface Comparable<ObjectType, KeyType> {
	/** Order By KeyType */
	key: (v: ObjectType) => KeyType
	/** Compare Keys here */
	compare: (a: KeyType, b: KeyType) => number
}

/** Identifier function for object */
export type Identifiable<T> = (v: T) => string

/**
 * Binary search — ported verbatim from the package.
 * @param array the array to search in
 * @param predicate return a value of < 0 if the item you're looking for should come before, 0 if it is the item you're looking for
 */
const binarySearch = <T>(array: T[], predicate: (item: T) => number): number => {
	let low = 0
	let high = array.length
	// base cases to allow entering a sorted collection in O(N)
	if (array.length === 0) {
		return low
	}

	if (predicate(array[low]!) < 0) {
		return low - 1
	} else if (predicate(array[low]!) === 0) {
		return low
	}

	const maxPred = predicate(array[high - 1]!)
	if (maxPred > 0) {
		return high
	} else if (maxPred === 0) {
		return high - 1
	}

	while (low !== high) {
		const mid = low + Math.floor((high - low) / 2)
		const pred = predicate(array[mid]!)
		if (pred < 0) {
			high = mid
		} else if (pred > 0) {
			low = mid + 1
		} else {
			return mid
		}
	}

	return low
}

export class KeyedDB<T, K> {
	array: T[] = []
	dict: { [id: string]: T } = {}
	private readonly key: Comparable<T, K>
	private readonly idGetter: Identifiable<T>

	/**
	 * @param key Return the unique key used to sort items
	 * @param id The unique ID for the items
	 */
	constructor(key: Comparable<T, K>, id?: Identifiable<T>) {
		this.key = key
		this.idGetter = id || (v => String(this.key.key(v)))
	}

	get length(): number {
		return this.array.length
	}

	get first(): T | undefined {
		return this.array[0]
	}

	get last(): T | undefined {
		return this.array[this.array.length - 1]
	}

	toJSON(): T[] {
		return this.array
	}

	/**
	 * Inserts items into the DB in klogN time.
	 * Where k is the number of items being inserted.
	 */
	insert(...values: T[]): void {
		values.forEach(v => this._insertSingle(v))
	}

	/**
	 * Upserts items into the DB in 2klogN time.
	 * If a duplicate is found, it is deleted first and then the new one is inserted
	 * @returns list of updated values
	 */
	upsert(...values: T[]): T[] {
		const updates: T[] = []
		values.forEach(v => {
			if (!v) {
				return
			}

			const deleted = this.deleteById(this.idGetter(v), false)
			this._insertSingle(v)
			// add to updates
			if (deleted) {
				updates.push(v)
			}
		})
		return updates
	}

	/**
	 * Inserts items only if they are not present in the DB
	 * @returns list of all the inserted values
	 */
	insertIfAbsent(...values: T[]): T[] {
		const insertions: T[] = []
		values.forEach(v => {
			if (!v) {
				return
			}

			// if ID is present
			const presentValue = this.get(this.idGetter(v))
			if (presentValue) {
				return
			}

			// if key is present
			const presentKey = this.firstIndex(v)
			if (this.array[presentKey] && this.key.key(this.array[presentKey]!) === this.key.key(v)) {
				return
			}

			this.insert(v)
			insertions.push(v)
		})
		return insertions
	}

	/**
	 * Deletes an item indexed by the ID
	 */
	deleteById(id: string, assertPresent = true): T | undefined {
		const value = this.get(id)
		if (!value) {
			if (assertPresent) {
				throw new Error('Value not found')
			} else {
				return undefined
			}
		}

		return this.delete(value) ?? undefined
	}

	delete(value: T): T | null {
		const index = this.firstIndex(value)
		if (index < 0 || index >= this.array.length || this.key.key(value) !== this.key.key(this.array[index]!)) {
			return null
		}

		delete this.dict[this.idGetter(value)]
		return this.array.splice(index, 1)[0]!
	}

	slice(start?: number, end?: number): KeyedDB<T, K> {
		const db = new KeyedDB<T, K>(this.key, this.idGetter)
		db.array = this.array.slice(start, end)
		db.array.forEach(item => (db.dict[this.idGetter(item)] = item))
		return db
	}

	/** Clears the DB */
	clear(): void {
		this.array = []
		this.dict = {}
	}

	get(id: string): T | undefined {
		return this.dict[id]
	}

	all(): T[] {
		return this.array
	}

	/**
	 * Updates a value specified by the ID
	 * and adjusts its position in the DB after an update if required
	 */
	update(id: string, update: (value: T) => void): 1 | 2 | undefined {
		const value = this.get(id)
		if (value) {
			const idx = this.firstIndex(value)
			if (idx >= 0 && idx < this.array.length && this.idGetter(this.array[idx]!) === id) {
				const oldKey = this.key.key(value)
				update(value)
				const newKey = this.key.key(value)
				if (newKey !== oldKey) {
					delete this.dict[id]
					this.array.splice(idx, 1)
					this._insertSingle(value)
					return 2
				}

				return 1
			}
		}

		return undefined
	}

	/**
	 * @deprecated see `update`
	 */
	updateKey(value: T, update: (value: T) => void): 1 | 2 | undefined {
		return this.update(this.idGetter(value), update)
	}

	filter(predicate: (value: T, index: number) => boolean): KeyedDB<T, K> {
		const db = new KeyedDB<T, K>(this.key, this.idGetter)
		db.array = this.array.filter((value, index) => {
			if (predicate(value, index)) {
				db.dict[this.idGetter(value)] = value
				return true
			}

			return false
		})
		return db
	}

	/**
	 * Get the values of the data in a paginated manner
	 * @param value the value itself beyond which the content is to be retreived
	 * @param limit max number of items to retreive
	 * @param predicate optional filter
	 * @param mode whether to get the content `before` the cursor or `after` the cursor; default=`after`
	 */
	paginatedByValue(
		value: T | null,
		limit: number,
		predicate?: (value: T, index: number) => boolean,
		mode: PaginationMode = 'after'
	): T[] {
		return this.paginated(value && this.key.key(value), limit, predicate, mode)
	}

	/**
	 * Get the values of the data in a paginated manner
	 * @param cursor the cursor beyond which the content is to be retreived
	 * @param limit max number of items to retreive
	 * @param predicate optional filter
	 * @param mode whether to get the content `before` the cursor or `after` the cursor; default=`after`
	 */
	paginated(
		cursor: K | null | undefined,
		limit: number,
		predicate?: (value: T, index: number) => boolean,
		mode: PaginationMode = 'after'
	): T[] {
		let index = mode === 'after' ? 0 : this.array.length
		if (cursor !== null && typeof cursor !== 'undefined') {
			index = binarySearch(this.array, v => this.key.compare(cursor, this.key.key(v)))
			if (index < 0) {
				index = 0
			}

			if (this.array[index] && this.key.key(this.array[index]!) === cursor) {
				index += mode === 'after' ? 1 : 0
			}
		}

		return this.filtered(index, limit, mode, predicate)
	}

	private _insertSingle(value: T): void {
		if (!value) {
			throw new Error('falsey value')
		}

		const valueID = this.idGetter(value)
		if (this.get(valueID)) {
			throw new Error('duplicate ID being inserted: ' + valueID)
		}

		if (this.array.length > 0) {
			const index = this.firstIndex(value)
			if (index >= this.array.length) {
				this.array.push(value)
			} else if (index < 0) {
				this.array.unshift(value)
			} else if (this.key.key(value) !== this.key.key(this.array[index]!)) {
				this.array.splice(index, 0, value)
			} else {
				throw new Error(
					`duplicate key: ${this.key.key(value)}, of inserting: ${valueID}, present: ${this.idGetter(this.array[index]!)}`
				)
			}
		} else {
			this.array.push(value)
		}

		this.dict[valueID] = value
	}

	private filtered(
		start: number,
		count: number,
		mode: PaginationMode,
		predicate?: (value: T, index: number) => boolean
	): T[] {
		let arr: T[]
		if (mode === 'after') {
			if (predicate) {
				arr = []
				for (const item of this.array.slice(start)) {
					if (predicate(item, start + arr.length)) {
						arr.push(item)
					}

					if (arr.length >= count) {
						break
					}
				}
			} else {
				arr = this.array.slice(start, start + count)
			}
		} else {
			if (predicate) {
				arr = []
				for (let i = start - 1; i >= 0; i--) {
					const item = this.array[i]!
					if (predicate(item, start + arr.length)) {
						arr.unshift(item)
					}

					if (arr.length >= count) {
						break
					}
				}
			} else {
				arr = this.array.slice(Math.max(start - count, 0), start)
			}
		}

		return arr
	}

	private firstIndex(value: T): number {
		const valueKey = this.key.key(value)
		return binarySearch(this.array, v => this.key.compare(valueKey, this.key.key(v)))
	}
}

export default KeyedDB

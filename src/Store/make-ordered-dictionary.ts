function makeOrderedDictionary<T>(idGetter: (item: T) => string) {
	const array: T[] = []
	const dict: { [id: string]: T } = {}

	const get = (id: string) => dict[id]

	const update = (item: T) => {
		const id = idGetter(item)
		const idx = array.findIndex(i => idGetter(i) === id)
		if (idx >= 0) {
			array[idx] = item
			dict[id] = item
		}

		return false
	}

	const upsert = (item: T, mode: 'append' | 'prepend') => {
		const id = idGetter(item)
		if (get(id)) {
			update(item)
		} else {
			if (mode === 'append') {
				array.push(item)
			} else {
				array.splice(0, 0, item)
			}

			dict[id] = item
		}
	}

	const remove = (item: T) => {
		const id = idGetter(item)
		const idx = array.findIndex(i => idGetter(i) === id)
		if (idx >= 0) {
			array.splice(idx, 1)
			delete dict[id]
			return true
		}

		return false
	}

	return {
		array,
		get,
		upsert,
		update,
		remove,
		updateAssign: (id: string, update: Partial<T>) => {
			const item = get(id)
			if (item) {
				// AunuBaileys (2.2.0, HB-370): an update must never
				// change the entry's identity — the old code assigned
				// blindly and re-keyed the dict under whatever the
				// update carried (a REVOKE update carrying the
				// protocol message's key moved the stored message to
				// the wrong id). If the assign would change the id,
				// restore the item untouched and report no update.
				const snapshot = { ...(item as object) }
				Object.assign(item as object, update)
				if (idGetter(item) !== id) {
					for (const k of Object.keys(item as object)) {
						delete (item as Record<string, unknown>)[k]
					}

					Object.assign(item as object, snapshot)
					return false
				}

				delete dict[id]
				dict[idGetter(item)] = item
				return true
			}

			return false
		},
		clear: () => {
			array.splice(0, array.length)
			Object.keys(dict).forEach(key => {
				delete dict[key]
			})
		},
		filter: (contain: (item: T) => boolean) => {
			let i = 0
			while (i < array.length) {
				if (!contain(array[i]!)) {
					delete dict[idGetter(array[i]!)]
					array.splice(i, 1)
				} else {
					i += 1
				}
			}
		},
		toJSON: () => array,
		fromJSON: (newItems: T[]) => {
			array.splice(0, array.length, ...newItems)
		}
	}
}

export default makeOrderedDictionary

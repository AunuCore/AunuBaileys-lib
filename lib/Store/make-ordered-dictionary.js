function makeOrderedDictionary(idGetter) {
    const array = [];
    // AunuBaileys (2.8.0, HB-507): ids arrive verbatim from peer
    // protocol messages, so '__proto__' is a reachable id. On a plain
    // object, get('__proto__') returned Object.prototype itself and
    // updateAssign then Object.assign-ed onto it — polluting every
    // object in the process. A null-prototype dict makes '__proto__',
    // 'constructor' and 'prototype' ordinary own keys.
    const dict = Object.create(null);
    const get = (id) => dict[id];
    const update = (item) => {
        const id = idGetter(item);
        const idx = array.findIndex(i => idGetter(i) === id);
        if (idx >= 0) {
            array[idx] = item;
            dict[id] = item;
        }
        return false;
    };
    const upsert = (item, mode) => {
        const id = idGetter(item);
        if (get(id)) {
            update(item);
        }
        else {
            if (mode === 'append') {
                array.push(item);
            }
            else {
                array.splice(0, 0, item);
            }
            dict[id] = item;
        }
    };
    const remove = (item) => {
        const id = idGetter(item);
        const idx = array.findIndex(i => idGetter(i) === id);
        if (idx >= 0) {
            array.splice(idx, 1);
            delete dict[id];
            return true;
        }
        return false;
    };
    return {
        array,
        get,
        upsert,
        update,
        remove,
        updateAssign: (id, update) => {
            const item = get(id);
            if (item) {
                // AunuBaileys (2.2.0, HB-370): an update must never
                // change the entry's identity — the old code assigned
                // blindly and re-keyed the dict under whatever the
                // update carried (a REVOKE update carrying the
                // protocol message's key moved the stored message to
                // the wrong id). If the assign would change the id,
                // restore the item untouched and report no update.
                const snapshot = { ...item };
                Object.assign(item, update);
                if (idGetter(item) !== id) {
                    for (const k of Object.keys(item)) {
                        delete item[k];
                    }
                    Object.assign(item, snapshot);
                    return false;
                }
                delete dict[id];
                dict[idGetter(item)] = item;
                return true;
            }
            return false;
        },
        clear: () => {
            array.splice(0, array.length);
            Object.keys(dict).forEach(key => {
                delete dict[key];
            });
        },
        filter: (contain) => {
            let i = 0;
            while (i < array.length) {
                if (!contain(array[i])) {
                    delete dict[idGetter(array[i])];
                    array.splice(i, 1);
                }
                else {
                    i += 1;
                }
            }
        },
        toJSON: () => array,
        fromJSON: (newItems) => {
            array.splice(0, array.length, ...newItems);
        }
    };
}
export default makeOrderedDictionary;
//# sourceMappingURL=make-ordered-dictionary.js.map
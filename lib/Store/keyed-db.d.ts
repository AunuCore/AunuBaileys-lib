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
export type PaginationMode = 'before' | 'after';
/** Order-by key extractor + comparator (the package's `Comparable`) */
export interface Comparable<ObjectType, KeyType> {
    /** Order By KeyType */
    key: (v: ObjectType) => KeyType;
    /** Compare Keys here */
    compare: (a: KeyType, b: KeyType) => number;
}
/** Identifier function for object */
export type Identifiable<T> = (v: T) => string;
export declare class KeyedDB<T, K> {
    array: T[];
    dict: {
        [id: string]: T;
    };
    private readonly key;
    private readonly idGetter;
    /**
     * @param key Return the unique key used to sort items
     * @param id The unique ID for the items
     */
    constructor(key: Comparable<T, K>, id?: Identifiable<T>);
    get length(): number;
    get first(): T | undefined;
    get last(): T | undefined;
    toJSON(): T[];
    /**
     * Inserts items into the DB in klogN time.
     * Where k is the number of items being inserted.
     */
    insert(...values: T[]): void;
    /**
     * Upserts items into the DB in 2klogN time.
     * If a duplicate is found, it is deleted first and then the new one is inserted
     * @returns list of updated values
     */
    upsert(...values: T[]): T[];
    /**
     * Inserts items only if they are not present in the DB
     * @returns list of all the inserted values
     */
    insertIfAbsent(...values: T[]): T[];
    /**
     * Deletes an item indexed by the ID
     */
    deleteById(id: string, assertPresent?: boolean): T | undefined;
    delete(value: T): T | null;
    slice(start?: number, end?: number): KeyedDB<T, K>;
    /** Clears the DB */
    clear(): void;
    get(id: string): T | undefined;
    all(): T[];
    /**
     * Updates a value specified by the ID
     * and adjusts its position in the DB after an update if required
     */
    update(id: string, update: (value: T) => void): 1 | 2 | undefined;
    /**
     * @deprecated see `update`
     */
    updateKey(value: T, update: (value: T) => void): 1 | 2 | undefined;
    filter(predicate: (value: T, index: number) => boolean): KeyedDB<T, K>;
    /**
     * Get the values of the data in a paginated manner
     * @param value the value itself beyond which the content is to be retreived
     * @param limit max number of items to retreive
     * @param predicate optional filter
     * @param mode whether to get the content `before` the cursor or `after` the cursor; default=`after`
     */
    paginatedByValue(value: T | null, limit: number, predicate?: (value: T, index: number) => boolean, mode?: PaginationMode): T[];
    /**
     * Get the values of the data in a paginated manner
     * @param cursor the cursor beyond which the content is to be retreived
     * @param limit max number of items to retreive
     * @param predicate optional filter
     * @param mode whether to get the content `before` the cursor or `after` the cursor; default=`after`
     */
    paginated(cursor: K | null | undefined, limit: number, predicate?: (value: T, index: number) => boolean, mode?: PaginationMode): T[];
    private _insertSingle;
    private filtered;
    private firstIndex;
}
export default KeyedDB;
//# sourceMappingURL=keyed-db.d.ts.map
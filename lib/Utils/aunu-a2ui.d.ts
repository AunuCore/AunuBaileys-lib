export declare class AunuA2UI {
    constructor({ catalogId, version }?: {
        catalogId?: string | undefined;
        version?: string | undefined;
    });
    _add(kind: any, fields: any, id: any): any;
    text(text: any, { id, variant }?: {
        variant?: string | undefined;
    }): any;
    image(url: any, { id, variant, fit }?: {
        fit?: string | undefined;
    }): any;
    video(url: any, { id }?: {}): any;
    button(childId: any, { id, variant, action }?: {
        variant?: string | undefined;
    }): any;
    card(childId: any, { id }?: {}): any;
    column(children?: never[], { id, justify, align }?: {}): any;
    row(children?: never[], { id }?: {}): any;
    divider({ id }?: {}): any;
    /** Names the top-level components. Required before `build()` unless `listCard` was used. */
    root(children: any): this;
    /**
     * Shortcut for the product-list widget, which uses its own payload
     * shape instead of the component catalog. It replaces whatever the
     * component methods built — `build()` returns this payload and
     * ignores `root()`.
     */
    listCard({ title, items, fallbackText, uuid }?: {
        uuid?: `${string}-${string}-${string}-${string}-${string}` | undefined;
    }): this;
    /** Compiles the tree into the `bloksWidget` payload. Called for you by `sendMessage`. */
    build({ uuid, surfaceId, type, wrapped }?: {
        uuid?: `${string}-${string}-${string}-${string}-${string}` | undefined;
        type?: string | undefined;
        wrapped?: boolean | undefined;
    }): any;
}
/** Accepts an `AunuA2UI` instance or an already-built payload, and returns the payload. */
export declare const buildAunuA2UIWidget: (widget: any, options?: {}) => any;
//# sourceMappingURL=aunu-a2ui.d.ts.map
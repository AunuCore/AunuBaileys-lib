/**
 * AunuBaileys: the offline stanza queue. Upstream's inline processor
 * awaited each handler with no per-node guard: one throwing node
 * aborted the whole drain, dropped the rest of the backlog, and left
 * the processor wedged (its busy flag never reset), so every later
 * offline node was silently swallowed for the rest of the session.
 * Here a failing node is reported and the queue moves on; the busy
 * flag always resets; the event loop gets a breath every few nodes.
 * (Failure class also fixed downstream by raiden-baileys.)
 */
export declare const createOfflineNodeQueue: ({ onError, isOpen, yieldEvery }?: {
    onError?: (err: any, context: string) => void;
    isOpen?: () => boolean;
    yieldEvery?: number;
}) => {
    enqueue: (type: string, node: any) => void;
    register: (type: string, handler: (node: any) => Promise<void> | void) => Map<string, (node: any) => Promise<void> | void>;
    readonly size: number;
    readonly processing: boolean;
};
//# sourceMappingURL=offline-queue.d.ts.map
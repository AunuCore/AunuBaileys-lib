import EventEmitter from 'events';
/**
 * Captures events from a baileys event emitter & stores them in a file
 * @param ev The event emitter to read events from
 * @param filename File to save to
 */
export declare const captureEventStream: (ev: any, filename: any) => void;
/**
 * Read event file and emit events from there
 * @param filename filename containing event data
 * @param delayIntervalMs delay between each event emit
 */
export declare const readAndEmitEventStream: (filename: any, delayIntervalMs?: number) => {
    ev: EventEmitter<[never]>;
    task: Promise<void>;
};
//# sourceMappingURL=baileys-event-stream.d.ts.map
// @ts-nocheck
// AunuBaileys P2c port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
import EventEmitter from 'events';
import { createReadStream } from 'fs';
import { rename, writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { delay } from './generics.js';
import { makeMutex } from './make-mutex.js';
/**
 * Captures events from a baileys event emitter & stores them in a file
 * @param ev The event emitter to read events from
 * @param filename File to save to
 */
export const captureEventStream = (ev, filename) => {
    const oldEmit = ev.emit;
    // write mutex so data is appended in order
    const writeMutex = makeMutex();
    // AunuBaileys (1.0.84, HB-247): a creds.update payload is the
    // full credential material (private noise / identity /
    // signed-pre-key bytes, the adv secret). The capture below
    // redacts it to the NAMES of the fields that changed, creates
    // the file 0600, and rotates it to `<filename>.1` once per
    // 10 MiB so a long-running debug capture cannot grow (or
    // leak) without bound.
    let capturedBytes = 0;
    const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
    // monkey patch eventemitter to capture all events
    ev.emit = function (...args) {
        const result = oldEmit.apply(ev, args);
        let content;
        try {
            const data = args[0] === 'creds.update' && args[1] && typeof args[1] === 'object'
                ? { redacted: 'creds.update payload withheld (credential material)', updatedFields: Object.keys(args[1]) }
                : args[1];
            content = JSON.stringify({ timestamp: Date.now(), event: args[0], data }) + '\n';
        }
        catch {
            // AunuBaileys (1.0.84, HB-129 addendum): an
            // unserialisable (circular) payload used to throw
            // synchronously out of the patched emit — into
            // whatever lib code had emitted the event — because
            // the stringify ran before oldEmit. Serialisation now
            // happens after the real emit, and a payload that
            // cannot be serialised is simply not captured.
            return result;
        }
        // AunuBaileys (1.0.84, HB-129): the mutex promise used to
        // be discarded — a failed write (deleted directory, full
        // disk, permissions) rejected with no handler attached
        // and crashed the host process (Node >= 15 default). A
        // debug capture must never take the host down with it.
        writeMutex.mutex(async () => {
            capturedBytes += Buffer.byteLength(content);
            if (capturedBytes > MAX_CAPTURE_BYTES) {
                capturedBytes = Buffer.byteLength(content);
                await rename(filename, `${filename}.1`).catch(() => { });
            }
            await writeFile(filename, content, { flag: 'a', mode: 0o600 });
        }).catch(() => { });
        return result;
    };
};
/**
 * Read event file and emit events from there
 * @param filename filename containing event data
 * @param delayIntervalMs delay between each event emit
 */
export const readAndEmitEventStream = (filename, delayIntervalMs = 0) => {
    const ev = new EventEmitter();
    const fireEvents = async () => {
        // from: https://stackoverflow.com/questions/6156501/read-a-file-one-line-at-a-time-in-node-js
        const fileStream = createReadStream(filename);
        const rl = createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });
        // Note: we use the crlfDelay option to recognize all instances of CR LF
        // ('\r\n') in input.txt as a single line break.
        for await (const line of rl) {
            if (line) {
                const { event, data } = JSON.parse(line);
                ev.emit(event, data);
                delayIntervalMs && (await delay(delayIntervalMs));
            }
        }
        fileStream.close();
    };
    return {
        ev,
        task: fireEvents()
    };
};
//# sourceMappingURL=baileys-event-stream.js.map
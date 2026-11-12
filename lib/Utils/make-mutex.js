export const makeMutex = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let task = Promise.resolve();
    // AunuBaileys (1.0.76): Hunt-ronde-3 — the old `taskTimeout` was dead
    // code (declared, cleared in a finally, NEVER assigned — there is no
    // hidden timeout safety net, and inventing one that breaks the chain
    // would corrupt the serialization this mutex exists for). Removed.
    // Note: a task that never settles blocks later tasks by design — that
    // is what a serial mutex means (upstream parity); callers must not
    // await unbounded work inside mutex sections.
    return {
        mutex(code) {
            task = (async () => {
                // wait for the previous task to complete
                // if there is an error, we swallow so as to not block the queue
                try {
                    await task;
                }
                catch { }
                // execute the current task
                return await code();
            })();
            // we replace the existing task, appending the new piece of execution to it
            // so the next task will have to wait for this one to finish
            return task;
        }
    };
};
export const makeKeyedMutex = () => {
    const map = {};
    return {
        mutex(key, task) {
            if (!map[key]) {
                map[key] = makeMutex();
            }
            return map[key].mutex(task);
        }
    };
};
//# sourceMappingURL=make-mutex.js.map
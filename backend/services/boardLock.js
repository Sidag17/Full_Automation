/**
 * Per-board mutex: only one flash / reset / capture / combo at a time per boardId.
 * Different boards can run in parallel (each has its own lock chain).
 */
const locks = new Map();

/**
 * @param {string} boardId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withBoardLock(boardId, fn) {
    const key = String(boardId ?? "").trim();
    if (!key) {
        throw new Error("withBoardLock: boardId is required");
    }

    const previous = locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });

    const tail = previous.then(() => gate);
    locks.set(key, tail);

    await previous;
    try {
        return await fn();
    } finally {
        release();
        // Drop settled chain when this was the last waiter
        if (locks.get(key) === tail) {
            locks.delete(key);
        }
    }
}

/** True if a board currently has an active or queued lock holder. */
export function isBoardLocked(boardId) {
    const key = String(boardId ?? "").trim();
    return locks.has(key);
}

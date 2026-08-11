export function persistStateChange<T>(current: T, createNext: (current: T) => T, persist: (next: T) => void): T {
    const next = createNext(current);
    persist(next);
    return next;
}

export async function commitQueueMutation<T>(
    current: T,
    createNext: (current: T) => T,
    persist: (next: T) => void,
    apply: (next: T) => void,
    effects: () => Promise<void>,
): Promise<T> {
    const next = createNext(current);
    persist(next);
    apply(next);
    await effects();
    return next;
}

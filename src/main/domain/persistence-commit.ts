export function persistStateChange<T>(current: T, createNext: (current: T) => T, persist: (next: T) => void): T {
    const next = createNext(current);
    persist(next);
    return next;
}

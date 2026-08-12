import { Transform } from 'node:stream';

export interface TokenBucketClock {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface TokenBucketBudget {
    reserve(bytes: number, release: () => void): () => void;
    setMaxBytesPerSecond(maxBytesPerSecond: number | null): void;
}

interface TokenBucketReservation {
    bytes: number;
    release: () => void;
    cancelled: boolean;
}

const systemClock: TokenBucketClock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
};

function assertRate(maxBytesPerSecond: number): void {
    if (!Number.isSafeInteger(maxBytesPerSecond) || maxBytesPerSecond <= 0) throw new RangeError('maxBytesPerSecond must be a positive safe integer');
}

class SharedTokenBucketBudget implements TokenBucketBudget {
    private availableBytes: number;
    private lastRefillAt: number;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private draining = false;
    private readonly reservations: TokenBucketReservation[] = [];

    constructor(private maxBytesPerSecond: number | null, private readonly clock: TokenBucketClock) {
        if (maxBytesPerSecond !== null) assertRate(maxBytesPerSecond);
        this.availableBytes = maxBytesPerSecond ?? 0;
        this.lastRefillAt = clock.now();
    }

    reserve(bytes: number, release: () => void): () => void {
        const reservation: TokenBucketReservation = { bytes, release, cancelled: false };
        this.reservations.push(reservation);
        this.drain();
        return () => {
            if (reservation.cancelled) return;
            reservation.cancelled = true;
            this.drain();
        };
    }

    setMaxBytesPerSecond(maxBytesPerSecond: number | null): void {
        if (maxBytesPerSecond !== null) assertRate(maxBytesPerSecond);
        if (this.maxBytesPerSecond === maxBytesPerSecond) return;
        const wasUnlimited = this.maxBytesPerSecond === null;
        this.maxBytesPerSecond = maxBytesPerSecond;
        this.availableBytes = maxBytesPerSecond === null ? 0 : wasUnlimited ? maxBytesPerSecond : Math.min(this.availableBytes, maxBytesPerSecond);
        this.lastRefillAt = this.clock.now();
        this.drain();
    }

    private refill(capacity: number): void {
        if (this.maxBytesPerSecond === null) return;
        const now = this.clock.now();
        const elapsed = Math.max(0, now - this.lastRefillAt);
        this.availableBytes = Math.min(capacity, this.availableBytes + (elapsed * this.maxBytesPerSecond) / 1000);
        this.lastRefillAt = now;
    }

    private clearTimer(): void {
        if (!this.timer) return;
        this.clock.clearTimeout(this.timer);
        this.timer = null;
    }

    private removeCancelledReservations(): void {
        while (this.reservations[0]?.cancelled) this.reservations.shift();
    }

    private drain(): void {
        if (this.draining) return;
        this.draining = true;
        try {
            this.clearTimer();
            while (true) {
                this.removeCancelledReservations();
                const reservation = this.reservations[0];
                if (!reservation) return;
                if (this.maxBytesPerSecond === null) {
                    this.reservations.shift();
                    reservation.release();
                    continue;
                }
                const capacity = Math.max(this.maxBytesPerSecond, reservation.bytes);
                this.refill(capacity);
                if (this.availableBytes >= reservation.bytes) {
                    this.availableBytes -= reservation.bytes;
                    this.reservations.shift();
                    reservation.release();
                    continue;
                }
                const delayMs = Math.max(1, Math.ceil(((reservation.bytes - this.availableBytes) * 1000) / this.maxBytesPerSecond));
                this.timer = this.clock.setTimeout(() => {
                    this.timer = null;
                    this.drain();
                }, delayMs);
                return;
            }
        } finally {
            this.draining = false;
        }
    }
}

class TokenBucketTransform extends Transform {
    private cancelReservation: (() => void) | null = null;

    constructor(private readonly budget: TokenBucketBudget) {
        super();
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const output = Buffer.from(chunk);
        this.cancelReservation = this.budget.reserve(output.length, () => {
            this.cancelReservation = null;
            if (this.destroyed) return;
            this.push(output);
            callback();
        });
    }

    override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
        this.cancelReservation?.();
        this.cancelReservation = null;
        callback(error);
    }
}

export function createTokenBucketBudget(maxBytesPerSecond: number | null, clock: TokenBucketClock = systemClock): TokenBucketBudget {
    return new SharedTokenBucketBudget(maxBytesPerSecond, clock);
}

export function createTokenBucketTransform(
    maxBytesPerSecond: number,
    clock: TokenBucketClock = systemClock,
    budget: TokenBucketBudget = createTokenBucketBudget(maxBytesPerSecond, clock),
): Transform {
    assertRate(maxBytesPerSecond);
    return new TokenBucketTransform(budget);
}

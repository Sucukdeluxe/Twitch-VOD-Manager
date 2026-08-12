import { Transform } from 'node:stream';

export interface TokenBucketClock {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const systemClock: TokenBucketClock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
};

class TokenBucketTransform extends Transform {
    private availableBytes: number;
    private lastRefillAt: number;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly maxBytesPerSecond: number, private readonly clock: TokenBucketClock) {
        super();
        this.availableBytes = maxBytesPerSecond;
        this.lastRefillAt = clock.now();
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const output = Buffer.from(chunk);
        const capacity = Math.max(this.maxBytesPerSecond, output.length);
        const release = (): void => {
            this.timer = null;
            if (this.destroyed) return;
            const now = this.clock.now();
            const elapsed = Math.max(0, now - this.lastRefillAt);
            this.availableBytes = Math.min(capacity, this.availableBytes + (elapsed * this.maxBytesPerSecond) / 1000);
            this.lastRefillAt = now;
            if (this.availableBytes >= output.length) {
                this.availableBytes -= output.length;
                this.push(output);
                callback();
                return;
            }
            const delayMs = Math.max(1, Math.ceil(((output.length - this.availableBytes) * 1000) / this.maxBytesPerSecond));
            this.timer = this.clock.setTimeout(release, delayMs);
        };
        release();
    }

    override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
        if (this.timer) this.clock.clearTimeout(this.timer);
        this.timer = null;
        callback(error);
    }
}

export function createTokenBucketTransform(maxBytesPerSecond: number, clock: TokenBucketClock = systemClock): Transform {
    if (!Number.isSafeInteger(maxBytesPerSecond) || maxBytesPerSecond <= 0) throw new RangeError('maxBytesPerSecond must be a positive safe integer');
    return new TokenBucketTransform(maxBytesPerSecond, clock);
}

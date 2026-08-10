import { Readable, Writable } from 'stream';

export interface PausableOutput {
    pause(): void;
    resume(): void;
    cancel(): Promise<void>;
    isPaused(): boolean;
    finished: Promise<void>;
}

export function createPausableOutput(source: Readable, target: Writable): PausableOutput {
    let paused = false;
    let settled = false;
    let resolveFinished: () => void = () => {};
    let rejectFinished: (error: Error) => void = () => {};
    let resolveClosed: () => void = () => {};
    const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = resolve;
        rejectFinished = reject;
    });
    const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });
    const attach = () => source.pipe(target, { end: false });
    const finish = () => {
        if (!settled) target.end();
    };

    target.once('finish', () => {
        settled = true;
        resolveFinished();
    });
    target.once('close', () => {
        resolveClosed();
        if (!settled) {
            settled = true;
            resolveFinished();
        }
    });
    target.once('error', (error) => {
        settled = true;
        source.destroy(error);
        rejectFinished(error);
    });
    source.once('end', finish);
    source.once('error', (error) => target.destroy(error));
    attach();

    return {
        pause() {
            if (paused || settled) return;
            paused = true;
            source.unpipe(target);
            source.pause();
        },
        resume() {
            if (!paused || settled) return;
            paused = false;
            attach();
            source.resume();
        },
        async cancel() {
            if (!settled) {
                paused = false;
                source.unpipe(target);
                source.destroy();
                target.destroy();
            }
            await closed;
        },
        isPaused: () => paused,
        finished
    };
}

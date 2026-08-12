import { Readable, Transform, Writable } from 'stream';

export interface PausableOutput {
    pause(): void;
    resume(): void;
    cancel(): Promise<void>;
    isPaused(): boolean;
    finished: Promise<void>;
}

export function createPausableOutput(source: Readable, target: Writable, transform?: Transform): PausableOutput {
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
    const outputSource = transform ? source.pipe(transform) : source;
    const attach = () => outputSource.pipe(target, { end: false });
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
    outputSource.once('end', finish);
    source.once('error', (error) => target.destroy(error));
    if (transform) transform.once('error', (error) => target.destroy(error));
    attach();

    return {
        pause() {
            if (paused || settled) return;
            paused = true;
            outputSource.unpipe(target);
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
                outputSource.unpipe(target);
                source.destroy();
                transform?.destroy();
                target.destroy();
            }
            await closed;
        },
        isPaused: () => paused,
        finished
    };
}

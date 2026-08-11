export type UpdateCheckOperationResult =
    | { state: 'completed' }
    | { state: 'failed'; error: unknown }
    | { state: 'timed-out' }
    | { state: 'in-progress' };

export class UpdateCheckCoordinator {
    private activeOperation: Promise<{ state: 'completed' } | { state: 'failed'; error: unknown }> | null = null;

    get inProgress(): boolean {
        return this.activeOperation !== null;
    }

    run(operation: () => Promise<void>, timeoutMs: number): Promise<UpdateCheckOperationResult> {
        if (this.activeOperation) {
            return Promise.resolve({ state: 'in-progress' });
        }

        const tracked = Promise.resolve()
            .then(operation)
            .then(
                () => ({ state: 'completed' as const }),
                (error) => ({ state: 'failed' as const, error })
            );
        this.activeOperation = tracked;
        void tracked.then(() => {
            if (this.activeOperation === tracked) {
                this.activeOperation = null;
            }
        });

        return new Promise<UpdateCheckOperationResult>((resolve) => {
            let pending = true;
            const timeout = setTimeout(() => {
                if (!pending) return;
                pending = false;
                resolve({ state: 'timed-out' });
            }, timeoutMs);
            void tracked.then((result) => {
                if (!pending) return;
                pending = false;
                clearTimeout(timeout);
                resolve(result);
            });
        });
    }
}

export function createUpdateCheckCoordinator(): UpdateCheckCoordinator {
    return new UpdateCheckCoordinator();
}

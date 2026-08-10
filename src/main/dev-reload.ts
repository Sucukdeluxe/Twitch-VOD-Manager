import { watch, type FSWatcher } from 'node:fs';

const staticRendererAssets = new Set(['index.html', 'styles.css', 'workspace.css']);

export function isRendererReloadTarget(fileName: string): boolean {
    const normalized = fileName.replaceAll('\\', '/');
    const baseName = normalized.split('/').at(-1) ?? '';
    return staticRendererAssets.has(baseName) || /^renderer(?:[-.].+)?\.js$/.test(baseName);
}

export function watchRendererChanges(
    outputDirectory: string,
    sourceDirectory: string,
    reload: () => void,
): () => void {
    let reloadTimer: NodeJS.Timeout | undefined;
    const scheduleReload = (fileName: string | Buffer | null): void => {
        if (!fileName || !isRendererReloadTarget(fileName.toString())) return;
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(reload, 125);
    };
    const watchers: FSWatcher[] = [
        watch(outputDirectory, { recursive: true }, (_, fileName) => scheduleReload(fileName)),
        watch(sourceDirectory, { recursive: true }, (_, fileName) => scheduleReload(fileName)),
    ];

    return () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        for (const watcher of watchers) watcher.close();
    };
}

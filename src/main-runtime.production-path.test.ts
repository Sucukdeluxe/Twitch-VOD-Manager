import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function mainSource(): string {
    return readFileSync(join(__dirname, 'main.ts'), 'utf8');
}

describe('main runtime safety production paths', () => {
    it('isolates startup secret reads from the persistent application state', () => {
        const source = mainSource();
        expect(source).toContain("readSecretSafely(appSecretStore, 'twitch_client_secret'");
        expect(source).toContain("readSecretSafely(appSecretStore, 'discord_webhook_url'");
        expect(source).toContain("entry.source !== 'legacy-config-scrub'");
    });

    it('rejects oversized config files before reading them', () => {
        const source = mainSource();
        const handler = source.slice(source.indexOf("ipcMain.handle('import-config'"), source.indexOf('function isTrustedRendererEvent'));
        expect(handler.indexOf('fs.statSync(importPath)')).toBeGreaterThan(-1);
        expect(handler.indexOf('fs.readFileSync(importPath')).toBeGreaterThan(handler.indexOf('fs.statSync(importPath)'));
        expect(handler).toContain('MAX_CONFIG_IMPORT_BYTES');
    });

    it('tracks both cleanup timers and guards their callbacks during shutdown', () => {
        const source = mainSource();
        expect(source).toContain('let autoCleanupStartupTimer: NodeJS.Timeout | null = null;');
        expect(source).toContain('clearTimeout(autoCleanupStartupTimer)');
        expect(source).toMatch(/autoCleanupStartupTimer = setTimeout\([\s\S]*?appShutdownStarted/);
        expect(source).toMatch(/function restartAutoCleanupTimer\(\): void \{\s*stopAutoCleanupTimer\(\);\s*if \(appShutdownStarted\) return;/);
    });

    it('cancels the deferred updater setup and refuses to initialize after shutdown', () => {
        const source = mainSource();
        expect(source).toContain('let autoUpdaterSetupTimer: NodeJS.Timeout | null = null;');
        expect(source).toContain('clearTimeout(autoUpdaterSetupTimer)');
        expect(source).toMatch(/autoUpdaterSetupTimer = setTimeout\([\s\S]*?!appShutdownStarted[\s\S]*?setupAutoUpdater/);
        expect(source).toMatch(/function setupAutoUpdater\(\) \{\s*if \(appShutdownStarted\) return;/);
    });

    it('tracks frame extraction processes and cleans them after waiting during shutdown', () => {
        const source = mainSource();
        const shutdown = source.slice(source.indexOf('async function shutdownCleanup'), source.indexOf("app.on('window-all-closed'"));
        expect(source).toContain('currentCutterFrameProcesses.add(proc)');
        expect(source).toContain('currentCutterFrameFiles.add(tempFile)');
        expect(source).toMatch(/currentCutterFrameProcesses[\s\S]*?waitForChildProcessExit/);
        expect(source).toMatch(/currentCutterFrameFiles[\s\S]*?fs\.rmSync/);
        expect(shutdown).toContain('runResilientSteps(frameFiles.map');
        expect(shutdown).toContain('if (!frameProcessesExited) return;');
    });

    it('waits for standalone clip processes before discarding partial output', () => {
        const source = mainSource();
        const shutdown = source.slice(source.indexOf('async function shutdownCleanup'), source.indexOf("app.on('window-all-closed'"));
        const wait = shutdown.indexOf('waitForChildProcessExit(tracking.process)');
        const discard = shutdown.indexOf('partialDownloadRegistry.discard(tracking.partialFilename)');
        expect(wait).toBeGreaterThan(-1);
        expect(discard).toBeGreaterThan(wait);
        const clipCleanup = shutdown.slice(shutdown.indexOf("['clip-processes'"), shutdown.indexOf("['editor-process'"));
        expect(clipCleanup).toContain('Promise.allSettled');
        expect(clipCleanup).not.toContain("['clip-wait'");
        expect(clipCleanup).toMatch(/await waitForChildProcessExit\(tracking\.process\)[\s\S]*?tracking\.output\.cancel\(\)[\s\S]*?partialDownloadRegistry\.discard/);
    });

    it('cannot start or publish a standalone clip after shutdown begins', () => {
        const source = mainSource();
        const handler = source.slice(source.indexOf("registerTrustedIpcHandler(ipcMain, 'download-clip'"), source.indexOf("registerTrustedIpcHandler(ipcMain, 'run-preflight'"));
        const request = handler.indexOf('await getClipInfo(clipId)');
        expect(handler.indexOf('if (appShutdownStarted)', 0)).toBeGreaterThan(-1);
        expect(handler.indexOf('if (appShutdownStarted)', request)).toBeGreaterThan(request);
        const partial = handler.indexOf('const partialFilename = partialDownloadRegistry.begin(filename)');
        const spawn = handler.indexOf('const proc = spawn(');
        const finalGuard = handler.indexOf('if (appShutdownStarted)', partial);
        expect(finalGuard).toBeGreaterThan(partial);
        expect(finalGuard).toBeLessThan(spawn);
        expect(handler.slice(finalGuard, spawn)).toContain('partialDownloadRegistry.discard(partialFilename)');
        expect(handler).toContain('activeClipProcesses.add(tracking)');
        expect(handler).toContain('activeClipProcesses.delete(tracking)');
        const finishHandler = handler.slice(handler.indexOf('const finish ='), handler.indexOf('activeClipProcesses.add(tracking)'));
        expect(finishHandler).toContain('activeClipProcesses.delete(tracking)');
        const closeHandler = handler.slice(handler.indexOf("proc.on('close'"), handler.indexOf("proc.on('error'"));
        expect(closeHandler).not.toContain('activeClipProcesses.delete(tracking)');
        expect(closeHandler.indexOf('if (appShutdownStarted)')).toBeGreaterThan(closeHandler.indexOf('await outputFinished'));
        expect(closeHandler.indexOf('partialDownloadRegistry.commit')).toBeGreaterThan(closeHandler.indexOf('if (appShutdownStarted)'));
        expect(closeHandler.indexOf('finish({ success: true, filename })')).toBeGreaterThan(closeHandler.indexOf('partialDownloadRegistry.commit'));
    });

    it('guards and tracks every standalone cut and merge process across shutdown', () => {
        const source = mainSource();
        const cut = source.slice(source.indexOf('async function cutVideo('), source.indexOf('async function mergeVideos('));
        const merge = source.slice(source.indexOf('async function mergeVideos('), source.indexOf('async function splitMergedFile('));
        const handlers = source.slice(source.indexOf("ipcMain.handle('cut-video'"), source.indexOf("ipcMain.handle('select-multiple-videos'"));
        const shutdown = source.slice(source.indexOf('async function shutdownCleanup'), source.indexOf("app.on('window-all-closed'"));

        expect(cut).toMatch(/await ensureFfmpegInstalled\(\);\s*if \(appShutdownStarted\) return false;/);
        expect(cut).toMatch(/const runCutAttempt[\s\S]*?if \(appShutdownStarted\) return false;[\s\S]*?const proc = spawn[\s\S]*?currentEditorProcesses\.add\(proc\)/);
        expect(cut).toMatch(/const copySuccess = await runCutAttempt\(true\);\s*if \(appShutdownStarted\) return false;/);
        expect(merge).toMatch(/await ensureFfmpegInstalled\(\);\s*if \(appShutdownStarted\) return false;/);
        expect(merge).toMatch(/const runMergeAttempt[\s\S]*?if \(appShutdownStarted\) return false;[\s\S]*?const proc = spawn[\s\S]*?currentEditorProcesses\.add\(proc\)/);
        expect(merge).toMatch(/const copySuccess = await runMergeAttempt\(true\);\s*if \(appShutdownStarted\) return false;/);
        expect(handlers).toContain('const success = completed && !appShutdownStarted');
        expect(handlers).toContain('return produced && !appShutdownStarted');
        expect(shutdown).toContain('const editorProcesses = [...currentEditorProcesses]');
        expect(shutdown).toMatch(/\['editor-processes'[\s\S]*?process\.kill\(\)[\s\S]*?waitForAllChildProcessesExit\(editorProcesses\)/);
    });

    it('runs shutdown poller and cache stops inside the resilient cleanup sequence', () => {
        const source = mainSource();
        const shutdown = source.slice(source.indexOf('async function shutdownCleanup'), source.indexOf("app.on('window-all-closed'"));
        const resilientStart = shutdown.indexOf('await runResilientSteps([');
        for (const operation of [
            'stopMetadataCacheCleanup()',
            "cleanupMetadataCaches('shutdown')",
            'stopAutoUpdatePolling()',
            'stopAutoRecordPoller()',
            'stopAutoVodPoller()',
            'stopLiveStatusPoller()',
            'stopAutoCleanupTimer()',
        ]) {
            expect(shutdown.indexOf(operation)).toBeGreaterThan(resilientStart);
        }
    });

    it('uses a safe archive-open allowlist', () => {
        const source = mainSource();
        expect(source).toContain('SAFE_ARCHIVE_OPEN_EXTENSIONS');
        expect(source).toContain("'.mp4'");
        expect(source).not.toMatch(/SAFE_ARCHIVE_OPEN_EXTENSIONS[^;]+\.url/);
        expect(source).not.toMatch(/SAFE_ARCHIVE_OPEN_EXTENSIONS[^;]+\.chm/);
    });

    it('routes auto VOD additions through the same atomic live duplicate check', () => {
        const source = mainSource();
        const poller = source.slice(source.indexOf('async function runAutoVodPoll'), source.indexOf('// ==========================================\n// LIVE RECORDING'));
        expect(poller).toContain('commitQueueItemWithResult(queueItem, false)');
        expect(poller).not.toContain('const queuedUrls');
        expect(poller).not.toContain('downloadQueue.push(queueItem)');
    });

    it('uses the built Twitch provider request and fallback orchestration in production refreshes', () => {
        const source = mainSource();
        const publicRequest = source.slice(source.indexOf('async function fetchPublicTwitchGqlOutcome'), source.indexOf('async function fetchPublicTwitchGql<'));
        expect(publicRequest).toContain('requestPublicTwitchGraphql<T>(');
        const users = source.slice(source.indexOf('async function getUserId'), source.indexOf('async function getVODs'));
        expect(users).toContain('requestTwitchHelixUsers(axios');
        const vods = source.slice(source.indexOf('async function getVODs'), source.indexOf('interface LiveStreamInfo'));
        expect(vods).toContain('refreshTwitchProviderData(');
        expect(vods).toContain('requestTwitchHelixVideos(axios');
        expect(vods).toContain('vodListLastGood.get(cacheKey)');
        expect(vods).toContain("refreshed.source === 'last-good'");
    });

    it('regenerates invalid or duplicate persisted queue ids before renderer exposure', () => {
        const source = mainSource();
        const queueLoad = source.slice(source.indexOf('function sanitizeQueueItem'), source.indexOf('let queueSaveTimer'));
        expect(queueLoad).toContain('isValidPersistedQueueId(raw.id) ? raw.id : generateQueueItemId()');
        expect(queueLoad).toContain('loadedIds.has(sanitized.id)');
        expect(queueLoad).toContain('sanitized.id = generateQueueItemId()');
        expect(queueLoad).toContain("raw.status === 'downloading' && isPlainObject(raw.mergeGroup)");
        expect(queueLoad).not.toContain('interruptedMergeItemIds.has(rawId)');
    });

    it('clears transfer metrics on resume, retry, completion, and error transitions', () => {
        const source = mainSource();
        const phaseBoundary = source.slice(source.indexOf('async function waitForQueuePhaseBoundary'), source.indexOf('// userId -> login reverse map'));
        const resumed = phaseBoundary.slice(phaseBoundary.indexOf('onResumed:'), phaseBoundary.indexOf('    });', phaseBoundary.indexOf('onResumed:')));
        expect(resumed).toContain('delete item.speed');
        expect(resumed).toContain('delete item.eta');
        expect(resumed).toContain('delete item.progressStatus');
        expect(source).toContain("clearQueueTransferState(item, 'pending', 0)");
        expect(source).toContain("clearQueueTransferState(candidate, 'pending', 0)");
        expect(source).toContain("clearQueueTransferState(item, 'downloading', item.progress)");
        expect(source).toContain("finalResult.success ? 'completed' : 'error'");
        expect(source).toContain('const retryProgress = prepareQueueRetryProgress(');
        expect(source).toContain('recordDownloadProgress(retryProgress)');
        const retryBlock = source.slice(source.indexOf('const retryProgress = prepareQueueRetryProgress('), source.indexOf('queueProcessRegistry.whenCancelled(item.id)', source.indexOf('const retryProgress = prepareQueueRetryProgress(')));
        expect(retryBlock).toContain("if (!queuePaused) mainWindow?.webContents.send('download-progress', retryProgress)");
    });

    it('does not restore transfer byte counters into inactive persisted queue states', () => {
        const source = mainSource();
        const sanitizer = source.slice(source.indexOf('function sanitizeQueueItem'), source.indexOf('interface QueueLoadResult'));
        expect(sanitizer).toMatch(/if \(finalStatus === 'paused'\) \{[\s\S]*?raw\.downloadedBytes[\s\S]*?raw\.totalBytes[\s\S]*?\}/);
    });

    it('persists live recording health in main state and queue fingerprints', () => {
        const source = mainSource();
        const progress = source.slice(source.indexOf('function getQueueBroadcastFingerprint'), source.indexOf('function clearDownloadProgress'));
        expect(progress).toContain("item.recordingHealth || ''");
        expect(progress).toContain('mergeQueueProgressState(item, progress, false)');
    });

    it('keeps merge cleanup recoverable when an artifact cannot be removed', () => {
        const source = mainSource();
        const cleanup = source.slice(source.indexOf("mg.mergePhase = 'cleanup'"), source.indexOf('async function processOneQueueItem'));
        expect(cleanup).toContain('if (failedCleanup.size > 0)');
        expect(cleanup).toContain('item.mergeRecoveryBlocked = true');
        expect(cleanup).toMatch(/catch\s*\{\s*failedCleanup\.add\(filePath\);\s*\}/);
        expect(cleanup).toMatch(/catch\s*\{\s*failedCleanup\.add\(mg\.mergedFile\);\s*\}/);
        expect(cleanup.indexOf("mg.mergePhase = 'done'")).toBeGreaterThan(cleanup.indexOf('if (failedCleanup.size > 0)'));
        const startup = source.slice(source.indexOf('const queueLoad ='), source.indexOf('lastPersistedQueueSnapshot = cloneQueue(downloadQueue)'));
        expect(startup).toContain('item.mergeRecoveryBlocked');
        expect(startup).toContain('queueLoad.interruptedMergeItemIds.add(item.id)');
        const removal = source.slice(source.indexOf("registerTrustedIpcHandler(ipcMain, 'remove-from-queue'"), source.indexOf("ipcMain.handle('clear-completed'"));
        expect(removal).toContain('recoverInterruptedMergeArtifacts([removedItem]');
        expect(removal).toContain('if (recovery.failedFiles.length > 0)');
    });

    it('pins every merge phase to the persisted canonical artifact root', () => {
        const source = mainSource();
        const mergePipeline = source.slice(source.indexOf('async function processDownloadMergeGroup'), source.indexOf('async function processOneQueueItem'));
        expect(mergePipeline).toContain('resolveMergeArtifactRoot(item, config.download_path)');
        expect(mergePipeline).toContain('item.artifactRoot = artifactRoot');
        expect(mergePipeline).not.toContain('path.join(config.download_path');
        expect(mergePipeline.match(/path\.join\(artifactRoot/g)?.length).toBeGreaterThanOrEqual(3);
    });

    it('exposes actual managed-tool execution counters only through the trusted cutter E2E gate', () => {
        const source = mainSource();
        const handler = source.slice(source.indexOf("ipcMain.handle('get-managed-tool-execution-diagnostics'"), source.indexOf("ipcMain.handle('repair-managed-tools'"));
        expect(handler).toContain('isTrustedRendererEvent(event)');
        expect(source).toContain('createManagedToolExecutionTracker(Boolean(process.env.TWITCH_VOD_MANAGER_E2E_CUTTER_OUTPUT_ROOT))');
        expect(handler).toContain('managedToolExecutionTracker.snapshot()');
        expect(source).toContain("recordManagedToolExecution('ffmpeg'");
        expect(source).toContain("recordManagedToolExecution('ffprobe'");
        expect(source).toContain("recordManagedToolExecution('streamlink'");
    });

    it('rejects merge, split, and concat work when shutdown rejects registration', () => {
        const source = mainSource();
        const registrations = [...source.matchAll(/const registration = itemId[\s\S]*?queueProcessRegistry\.register\([\s\S]*?\n\s*: null;/g)];
        expect(registrations).toHaveLength(3);
        for (const registration of registrations) {
            const tail = source.slice((registration.index ?? 0) + registration[0].length, (registration.index ?? 0) + registration[0].length + 220);
            expect(tail).toContain('if (registration && !registration.accepted)');
            expect(tail).toContain('resolve(false)');
        }
    });
});

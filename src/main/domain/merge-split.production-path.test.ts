import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('merge split production path', () => {
    it('persists a hidden merge output before ffmpeg can write crash data', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
        const start = source.indexOf('async function processDownloadMergeGroup');
        const merge = source.slice(start, source.indexOf('// ---- PHASE 3: SPLITTING ----', start));

        expect(merge).toContain('.merge_output_');
        expect(merge.indexOf('mg.mergedFile = mergedFilePath')).toBeLessThan(merge.indexOf('await mergeVideos('));
        expect(merge.indexOf('saveQueue(downloadQueue)', merge.indexOf('mg.mergedFile = mergedFilePath'))).toBeLessThan(merge.indexOf('await mergeVideos('));
    });

    it('encodes each split into a persisted app-owned temp file before atomically publishing it', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
        const start = source.indexOf('async function splitMergedFile');
        const end = source.indexOf('// ==========================================\n// DOWNLOAD FUNCTIONS', start);
        const split = source.slice(start, end);

        expect(split).toContain('.merge_split_');
        expect(split).toContain('onPartState(i, outputFile, temporaryFile)');
        expect(split).toContain('fs.renameSync(temporaryFile, outputFile)');
        expect(split).toContain('onPartState(i, outputFile, null)');
        expect(split.indexOf('onPartState(i, outputFile, temporaryFile)')).toBeLessThan(split.indexOf("spawn(ffmpeg, args"));
    });

    it('hydrates interrupted split state and prevents retry while recovery artifacts remain', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');

        expect(source).toContain('splitTempFiles: Array.isArray(raw.splitTempFiles)');
        expect(source).toContain("raw.status === 'downloading' && isPlainObject(raw.mergeGroup)");
        expect(source).toContain('const interruptedMergeItemIds = new Set<string>()');
        expect(source).toContain('recoverInterruptedMergeArtifacts(downloadQueue, config.download_path, queueLoad.interruptedMergeItemIds)');
        expect(source).toContain("item.status === 'error' && !item.mergeRecoveryBlocked");
        expect(source).toContain("if (item.status !== 'error' || item.mergeRecoveryBlocked) return downloadQueue");
    });
});

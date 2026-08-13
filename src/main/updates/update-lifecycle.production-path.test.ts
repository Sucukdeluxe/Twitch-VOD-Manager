import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('main update lifecycle production path', () => {
    it('uses one lifecycle for checks, downloads, terminals and typed errors', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
        const start = source.indexOf('async function requestUpdateCheck');
        const end = source.indexOf('// ==========================================\n// IPC HANDLERS', start);
        const updateSource = source.slice(start, end);

        expect(source).toMatch(/import\s*\{[\s\S]*UpdateLifecycle[\s\S]*\}\s*from '\.\/main\/updates'/);
        expect(source).toContain('const autoUpdateLifecycle = new UpdateLifecycle()');
        expect(updateSource).toContain('autoUpdateLifecycle.beginCheck()');
        expect(updateSource).toContain('autoUpdateLifecycle.beginDownload(version)');
        expect(updateSource).toContain('autoUpdateLifecycle.completeCheckAvailable(incomingVersion)');
        expect(updateSource).toContain('autoUpdateLifecycle.completeCheckNotAvailable()');
        expect(updateSource).toContain('autoUpdateLifecycle.completeDownload(downloadedVersion)');
        const timeoutBranch = updateSource.slice(
            updateSource.indexOf("if (result.state === 'timed-out')"),
            updateSource.indexOf("if (result.state === 'in-progress')")
        );
        expect(timeoutBranch).toContain('autoUpdateLifecycle.failCheck()');
        expect(updateSource).toContain("kind: 'check'");
        expect(updateSource).toContain("kind: 'download'");
        expect(updateSource).not.toContain('autoUpdateDownloadInProgress = false');
    });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('VFR cutter production path', () => {
    it('accepts VFR media preparation and keeps timestamp-based video and audio trimming', () => {
        const mainSource = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
        const prepareStart = mainSource.indexOf('async function prepareVideoEditorMedia');
        const prepareEnd = mainSource.indexOf('async function prepareVideoEditorWaveform', prepareStart);
        const prepare = mainSource.slice(prepareStart, prepareEnd);
        const exportSource = readFileSync(join(process.cwd(), 'src', 'main', 'domain', 'cutter-export.ts'), 'utf8');

        expect(prepare).not.toContain('info.variableFrameRate');
        expect(exportSource).toContain("`trim=start=${start}:end=${end}`");
        expect(exportSource).toContain("'setpts=PTS-STARTPTS'");
        expect(exportSource).toContain('atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS');
    });
});

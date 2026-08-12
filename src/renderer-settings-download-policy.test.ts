import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

function readParser(): (rate: string, windows: string) => { value: unknown; error: string | null } {
    const source = readFileSync(join(process.cwd(), 'src', 'renderer-settings.ts'), 'utf8');
    const start = source.indexOf('function parseDownloadPolicyFormValue');
    const end = source.indexOf('function updateDownloadPolicyValidation', start);
    if (start < 0 || end < 0) throw new Error('Download policy form parser is unavailable');
    const compiled = transpileModule(`${source.slice(start, end)}\nglobalThis.__parseDownloadPolicyFormValue = parseDownloadPolicyFormValue;`, {
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
    }).outputText;
    const context: Record<string, unknown> = {};
    runInNewContext(compiled, context);
    return context.__parseDownloadPolicyFormValue as (rate: string, windows: string) => { value: unknown; error: string | null };
}

describe('download policy settings input', () => {
    it('converts a human-friendly MiB/s value into a whole safe byte rate and accepts flexible local windows', () => {
        const parse = readParser();

        expect(parse('1,5', '22:00-06:00; 09:30 - 12:00')).toEqual({
            value: {
                throttle: { maxBytesPerSecond: 1_572_864 },
                windows: [{ start: '22:00', end: '06:00' }, { start: '09:30', end: '12:00' }]
            },
            error: null
        });
    });

    it('rejects invalid byte-rate and local-window values without producing a persistence payload', () => {
        const parse = readParser();

        expect(parse('0', '22:00-06:00')).toEqual({ value: null, error: 'rate' });
        expect(parse('1.25', '22:00-22:00')).toEqual({ value: null, error: 'window' });
        expect(parse('999999999999999999999', '')).toEqual({ value: null, error: 'rate' });
    });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, test } from 'vitest';

function sourceFragment(start: string, end: string): string {
    const source = readFileSync(join(__dirname, 'renderer-updates.ts'), 'utf8');
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error('Missing renderer updates production fragment');
    return source.slice(from, to);
}

function evaluate(source: string, context: Record<string, unknown>): { rememberUpdateInfo: (info?: { version?: string } | null) => unknown } {
    context.globalThis = context;
    const compiled = transpileModule(`${source}\nObject.assign(globalThis, { __updatesProductionPath: { rememberUpdateInfo } });`, {
        compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(compiled, context);
    return (context as { __updatesProductionPath: { rememberUpdateInfo: (info?: { version?: string } | null) => unknown } }).__updatesProductionPath;
}

describe('renderer update production paths', () => {
    test('does not create an update state without a version', () => {
        const api = evaluate(sourceFragment('function rememberUpdateInfo', 'function getActiveUpdateInfo'), {
            latestUpdateVersion: '',
            latestUpdateInfo: null,
        });

        expect(api.rememberUpdateInfo({})).toBeNull();
    });
});

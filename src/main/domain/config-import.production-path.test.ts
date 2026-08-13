import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('config import production path', () => {
    it('uses the import sanitizer and the same runtime transition as normal saves', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
        const start = source.indexOf("ipcMain.handle('import-config'");
        const end = source.indexOf('function isTrustedRendererEvent', start);
        const handler = source.slice(start, end);

        expect(handler).toContain('sanitizeImportedConfig(parsed)');
        expect(handler).toContain('applyConfigTransition(previousConfig, merged)');
        expect(handler).not.toContain('sanitizeConfigInput(parsed)');
    });
});

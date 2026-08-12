import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const styles = readFileSync(join(__dirname, 'styles.css'), 'utf8');
const workspaceStyles = readFileSync(join(__dirname, 'workspace.css'), 'utf8');

describe('cutter workspace style production paths', () => {
    test('hides the source bar when the non-adjacent workspace is shown', () => {
        expect(styles).toContain('.cutter-source-bar:has(~ .cutter-workspace.shown)');
    });

    test('keeps the export profile indicator from tiling after workspace background styling', () => {
        const selector = '#cutterTab .cutter-export-options select {';
        const start = workspaceStyles.indexOf(selector);
        const end = workspaceStyles.indexOf('}', start);
        expect(workspaceStyles.slice(start, end)).toMatch(/background-repeat:\s*no-repeat/);
    });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const styles = readFileSync(join(__dirname, 'styles.css'), 'utf8');
const workspaceStyles = readFileSync(join(__dirname, 'workspace.css'), 'utf8');

describe('cutter workspace style production paths', () => {
    test('keeps loaded-source visibility independent from the large-window media query', () => {
        const selector = '#cutterTab .cutter-source-bar:has(~ .cutter-workspace.shown)';
        const selectorIndex = styles.indexOf(selector);
        const mediaStart = styles.indexOf('@media (min-width: 1181px) and (min-height: 680px)');
        const nextTopLevelRule = styles.indexOf('\n.cutter-source-bar {', mediaStart);
        expect(selectorIndex).toBeGreaterThan(-1);
        expect(selectorIndex < mediaStart || selectorIndex > nextTopLevelRule).toBe(true);
    });

    test('keeps one reserved non-repeating indicator on every cutter export select', () => {
        const selector = '#cutterTab .cutter-export-options select {';
        const start = workspaceStyles.indexOf(selector);
        const end = workspaceStyles.indexOf('}', start);
        const rule = workspaceStyles.slice(start, end);
        expect(rule.match(/background-image:/g)).toHaveLength(1);
        expect(rule).toMatch(/appearance:\s*none/);
        expect(rule).toMatch(/padding-right:\s*28px/);
        expect(rule).toMatch(/background-repeat:\s*no-repeat/);
    });
});

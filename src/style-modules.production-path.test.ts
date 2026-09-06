import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isRendererReloadTarget } from './main/dev-reload';

const styleFiles = [
    'styles.css',
    'styles-workflows.css',
    'styles-overlays.css',
    'workspace.css',
    'workspace-refinements.css',
];

describe('production style modules', () => {
    test('preserves the complete stylesheet byte sequence across module boundaries', () => {
        const content = Buffer.from(styleFiles
            .map((fileName) => readFileSync(join(__dirname, fileName), 'utf8'))
            .join('')
            .replace(/\r\n/g, '\n'));
        const digest = createHash('sha256').update(content).digest('hex');

        expect(digest).toBe('2121672b9cf4534a7e15be2cf88ab1919fe54fe8f3ca314e6658ed6633436019');
    });

    test('derives the Windows hot-development executable version from package metadata', () => {
        const script = readFileSync(join(__dirname, '../scripts/dev.mjs'), 'utf8');

        expect(script).toContain("readFileSync(resolve(rootDirectory, 'package.json'), 'utf8')");
        expect(script).toMatch(/version:\s*developmentAppVersion/);
        expect(script).not.toMatch(/version:\s*['"]\d+\.\d+\.\d+['"]/);
    });

    test('reloads every production stylesheet during hot development', () => {
        for (const fileName of styleFiles) {
            expect(isRendererReloadTarget(fileName), fileName).toBe(true);
        }
        expect(isRendererReloadTarget('future-workspace-surface.css')).toBe(true);
    });

    test('loads and packages every stylesheet in cascade order', () => {
        const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
        const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as {
            build?: { files?: string[] };
        };
        const links = Array.from(html.matchAll(/<link rel="stylesheet" href="\.\/([^"?]+)"/g), (match) => match[1]);

        expect(links).toEqual(styleFiles);
        for (const fileName of styleFiles) {
            expect(packageJson.build?.files).toContain(`src/${fileName}`);
        }
        expect(packageJson.build?.files).toContain('!dist/main/dev-executable.js');
        expect(packageJson.build?.files).toContain('!dist/main/index.js');
        expect(packageJson.build?.files).toContain('!dist/types.js');
    });

    test('animates queue progress only while downloading and visibly marks paused items', () => {
        const styles = readFileSync(join(__dirname, 'styles-workflows.css'), 'utf8');
        const baseShimmer = styles.match(/\.queue-progress-bar::after\s*\{([\s\S]*?)\}/)?.[1] ?? '';
        const activeShimmer = styles.match(/\.queue-item:has\(\.status\.downloading\)\s+\.queue-progress-bar::after\s*\{([\s\S]*?)\}/)?.[1] ?? '';
        const pausedStatus = styles.match(/\.queue-item\s+\.status\.paused\s*\{([\s\S]*?)\}/)?.[1] ?? '';

        expect(baseShimmer).toMatch(/display:\s*none/);
        expect(baseShimmer).toMatch(/animation:\s*none/);
        expect(activeShimmer).toMatch(/display:\s*block/);
        expect(activeShimmer).toMatch(/animation:\s*queue-progress-shimmer/);
        expect(pausedStatus).toMatch(/background:/);
        expect(pausedStatus).toMatch(/box-shadow:/);
    });
});

import { describe, expect, test } from 'vitest';
import { isRendererReloadTarget } from './dev-reload';

describe('isRendererReloadTarget', () => {
    test('reloads renderer output and static renderer assets', () => {
        expect(isRendererReloadTarget('renderer.js')).toBe(true);
        expect(isRendererReloadTarget('renderer-settings.js')).toBe(true);
        expect(isRendererReloadTarget('renderer.workspace.js')).toBe(true);
        expect(isRendererReloadTarget('index.html')).toBe(true);
        expect(isRendererReloadTarget('styles.css')).toBe(true);
        expect(isRendererReloadTarget('styles-workflows.css')).toBe(true);
        expect(isRendererReloadTarget('styles-overlays.css')).toBe(true);
        expect(isRendererReloadTarget('workspace.css')).toBe(true);
        expect(isRendererReloadTarget('workspace-refinements.css')).toBe(true);
    });

    test('does not reload for main-process output', () => {
        expect(isRendererReloadTarget('main.js')).toBe(false);
        expect(isRendererReloadTarget('preload.js')).toBe(false);
        expect(isRendererReloadTarget('rendererworker.js')).toBe(false);
        expect(isRendererReloadTarget('renderer-.js')).toBe(false);
        expect(isRendererReloadTarget('main/domain/config.js')).toBe(false);
    });
});

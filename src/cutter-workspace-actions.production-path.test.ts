import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

function fragment(source: string, start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`Missing production fragment: ${start}`);
    return source.slice(from, to);
}

describe('cutter workspace actions production path', () => {
    const html = readFileSync(join(__dirname, 'index.html'), 'utf8');

    test('keeps project open and save actions in the persistent loaded toolbar', () => {
        const toolbar = fragment(html, '<div class="toolbar-context" data-toolbar-for="cutter"', '<div class="toolbar-context" data-toolbar-for="merge"');
        const sourceBar = fragment(html, '<div class="cutter-source-bar">', '<div class="cutter-recovery-panel"');

        expect(toolbar).toContain('id="cutterOpenProjectBtn"');
        expect(toolbar).toContain('id="cutterSaveProjectBtn"');
        expect(sourceBar).not.toContain('id="cutterOpenProjectBtn"');
        expect(sourceBar).not.toContain('id="cutterSaveProjectBtn"');
    });

    test('opens the video picker directly from the cutter context action', () => {
        const cutterContext = fragment(html, '<section class="context-panel" data-context-for="cutter"', '<section class="context-panel" data-context-for="merge"');

        expect(cutterContext).toContain('onclick="selectCutterVideo()"');
        expect(cutterContext).not.toContain("focusWorkspaceTarget('cutterBrowseBtn'");
    });

    test('shows the unambiguous frame timecode format on editable fields', () => {
        const trimCard = fragment(html, '<div class="cutter-trim-card">', '<div class="cutter-cut-section">');

        expect(trimCard.match(/placeholder="HH:MM:SS:FF"/g)).toHaveLength(2);
        expect(trimCard.match(/title="HH:MM:SS:FF"/g)).toHaveLength(2);
    });

    test('uses correct German umlauts in owned fallback and locale sources', () => {
        const german = readFileSync(join(__dirname, 'renderer-locale-de.ts'), 'utf8');

        expect(html).toContain('Max Stabilität');
        expect(german).toContain('Unterstützte Formate');
        expect(german).toContain("openFolder: 'Öffnen'");
        expect(german).toContain("partMinutesLabel: 'Teil-Länge (Minuten)'");
        expect(german).toContain('Einige Änderungen erfordern');
        expect(german).toContain('Öffnet während einer Live-Aufnahme');
        expect(german).toContain("invalidDuration: 'Ungültig!'");
        expect(german).toContain("empty: 'Keine Videos ausgewählt'");
        expect(german).toContain("success: 'Videos erfolgreich zusammengefügt!'");
        expect(german).toContain("phaseCleanup: 'Aufräumen...'");
        expect(german).toContain("checkInProgress: 'Update-Prüfung läuft bereits.'");
        expect(german).toContain("checkFailed: 'Update-Prüfung fehlgeschlagen.'");
        expect(german).toContain("downloadInProgress: 'Update-Download läuft bereits.'");
        expect(html).not.toContain('Max Stabilitat');
        expect(german).not.toMatch(/Unterstutzte|\bOffnen\b|Teil-Lange|Aenderungen|Oeffnet|Ungultig|ausgewahlt|zusammengefugt|Aufraumen|Update-Prufung|\blauft\b/);
    });

    test('provides localized System Check failure copy to the settings renderer', () => {
        const german = readFileSync(join(__dirname, 'renderer-locale-de.ts'), 'utf8');
        const english = readFileSync(join(__dirname, 'renderer-locale-en.ts'), 'utf8');

        expect(german).toContain("preflightError: 'System-Check fehlgeschlagen.'");
        expect(english).toContain("preflightError: 'System check failed.'");
    });
});

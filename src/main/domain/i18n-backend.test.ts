import { test, expect, describe } from 'vitest';
import { tBackend, BACKEND_MESSAGES, type BackendMessageKey } from './i18n-backend';

describe('tBackend', () => {
    test('returns DE message for known key (default language)', () => {
        expect(tBackend('invalidVodUrl', undefined, 'de')).toBe(BACKEND_MESSAGES.de.invalidVodUrl);
    });

    test('returns EN message when language=en', () => {
        expect(tBackend('invalidVodUrl', undefined, 'en')).toBe(BACKEND_MESSAGES.en.invalidVodUrl);
    });

    test('unknown language falls back to de', () => {
        expect(tBackend('invalidVodUrl', undefined, 'fr')).toBe(BACKEND_MESSAGES.de.invalidVodUrl);
        expect(tBackend('invalidVodUrl', undefined, '')).toBe(BACKEND_MESSAGES.de.invalidVodUrl);
    });

    test('substitutes single {param}', () => {
        const result = tBackend('streamlinkExitCode', { code: 42 }, 'en');
        expect(result).toBe('Streamlink exit code 42');
    });

    test('substitutes multiple {params}', () => {
        const result = tBackend('integrityDurationMismatch', { actual: 100, expected: 120 }, 'de');
        expect(result).toContain('100');
        expect(result).toContain('120');
        expect(result).not.toContain('{actual}');
        expect(result).not.toContain('{expected}');
    });

    test('numeric params stringify', () => {
        const result = tBackend('fileTooSmall', { bytes: 256 }, 'en');
        expect(result).toBe('File too small (256 bytes)');
    });

    test('every DE key has an EN counterpart', () => {
        const deKeys = Object.keys(BACKEND_MESSAGES.de) as BackendMessageKey[];
        const enKeys = Object.keys(BACKEND_MESSAGES.en);
        for (const k of deKeys) {
            expect(enKeys).toContain(k);
        }
    });

    test('describes a blocked standalone download and a phase-boundary pause honestly', () => {
        expect(tBackend('downloadOutsideWindow', { nextStart: '22:00' }, 'de')).toBe('Download außerhalb des Zeitfensters blockiert. Nächster Start: 22:00.');
        expect(tBackend('downloadOutsideWindow', { nextStart: '22:00' }, 'en')).toBe('Download blocked outside the configured window. Next start: 22:00.');
        expect(tBackend('downloadPausePending', undefined, 'de')).toBe('Pause nach dem aktuellen Schritt.');
        expect(tBackend('downloadPausePending', undefined, 'en')).toBe('Pausing after the current step.');
        expect(tBackend('mergeRecoveryBlocked', undefined, 'de')).toBe('Unterbrochene Merge-Dateien konnten nicht entfernt werden. Entferne den Queue-Eintrag manuell.');
        expect(tBackend('mergeRecoveryBlocked', undefined, 'en')).toBe('Interrupted merge files could not be removed. Remove the queue item manually.');
    });

    test('German backend messages use native umlauts', () => {
        const text = Object.values(BACKEND_MESSAGES.de).join('\n').toLocaleLowerCase('de-DE');
        const forbidden = ['ungueltig', 'integritaetspruefung', 'fur ', 'benoetigt', 'prufe '];
        for (const token of forbidden) {
            expect(text).not.toContain(token);
        }
    });

    test('no template literal left after substitution for typical params', () => {
        // attemptFailed has {attempt}, {max}, {errorClass}, {error}
        const result = tBackend('attemptFailed', { attempt: 1, max: 3, errorClass: 'network', error: 'ETIMEDOUT' }, 'en');
        expect(result).toBe('Attempt 1/3 failed (network): ETIMEDOUT');
    });
});

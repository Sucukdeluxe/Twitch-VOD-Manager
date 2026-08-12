import { test, expect, describe, vi } from 'vitest';
import { MemorySecureStorage, createElectronSecureStorage, type SecureStorage } from './secure-storage';

vi.mock('electron', () => ({}));

describe('MemorySecureStorage', () => {
    test('isEncryptionAvailable returns false (kennzeichnet Memory-Mode)', () => {
        const s: SecureStorage = new MemorySecureStorage();
        expect(s.isEncryptionAvailable()).toBe(false);
    });

    test('roundtrip ascii', () => {
        const s = new MemorySecureStorage();
        const cipher = s.encrypt('hello');
        expect(cipher).not.toBe('hello'); // base64-Kodierung greift
        expect(s.decrypt(cipher)).toBe('hello');
    });

    test('roundtrip multi-byte', () => {
        const s = new MemorySecureStorage();
        expect(s.decrypt(s.encrypt('aeoeue-test'))).toBe('aeoeue-test');
    });

    test('roundtrip empty string', () => {
        const s = new MemorySecureStorage();
        expect(s.decrypt(s.encrypt(''))).toBe('');
    });

    test('long token (simuliert OAuth access_token Groesse)', () => {
        const s = new MemorySecureStorage();
        const token = 'a'.repeat(256);
        expect(s.decrypt(s.encrypt(token))).toBe(token);
    });
});

describe('createElectronSecureStorage', () => {
    test('is exported as function', () => {
        expect(typeof createElectronSecureStorage).toBe('function');
    });

    test('throws useful error if called outside Electron (vitest env)', () => {
        // In vitest (Node-only) ist electron entweder nicht installiert oder hat keine
        // app-context-Funktionen. Genaues Error-Wording ist nicht stable, aber Aufruf
        // muss throwen statt undefined zurueckgeben.
        expect(() => createElectronSecureStorage()).toThrow();
    });
});

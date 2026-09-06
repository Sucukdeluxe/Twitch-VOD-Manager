import { beforeEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { extractZipArchive } from './extract-zip';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const execute = vi.mocked(execFile);
const archive = "C:\\Downloads\\Sascha's [tools] & media.zip";
const destination = "C:\\Downloads\\Sascha's [tools] & media";

beforeEach(() => { execute.mockReset(); });

it('passes archive paths literally to the built-in Windows extractor without a shell', async () => {
    execute.mockImplementation((...args: unknown[]) => {
        (args[3] as (error: Error | null) => void)(null);
        return {} as ReturnType<typeof execFile>;
    });
    await extractZipArchive(archive, destination);
    expect(execute).toHaveBeenCalledWith(expect.stringMatching(/System32[\\/]tar\.exe$/), ['-xf', archive, '-C', destination], expect.objectContaining({ windowsHide: true, timeout: 120000 }), expect.any(Function));
});

it('falls back only when tar is unavailable and keeps paths out of PowerShell source', async () => {
    execute.mockImplementation((...args: unknown[]) => {
        (args[3] as (error: Error | null) => void)(execute.mock.calls.length === 1 ? Object.assign(new Error('missing'), { code: 'ENOENT' }) : null);
        return {} as ReturnType<typeof execFile>;
    });
    await extractZipArchive(archive, destination);
    expect(execute).toHaveBeenCalledTimes(2);
    const fallback = execute.mock.calls[1];
    expect(fallback[1]).toEqual(expect.arrayContaining([expect.stringContaining('-ErrorAction Stop')]));
    expect(JSON.stringify(fallback[1])).not.toContain('Sascha');
    expect(fallback[2]).toMatchObject({ env: { TVM_ARCHIVE_PATH: archive, TVM_EXTRACT_PATH: destination } });
});

it('rejects extraction errors instead of reporting an incomplete archive as successful', async () => {
    const failure = Object.assign(new Error('invalid archive'), { code: 1 });
    execute.mockImplementation((...args: unknown[]) => {
        (args[3] as (error: Error | null) => void)(failure);
        return {} as ReturnType<typeof execFile>;
    });
    await expect(extractZipArchive(archive, destination)).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(1);
});

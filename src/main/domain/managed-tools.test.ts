import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createManagedToolInstaller, type ExternalToolManifest } from './managed-tools';

let directory: string;

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function manifest(): ExternalToolManifest {
    return {
        id: 'streamlink',
        version: '8.4.0',
        sourceUrl: 'https://example.invalid/streamlink-8.4.0.zip',
        archiveName: 'streamlink-8.4.0.zip',
        sha256: sha256('verified archive'),
        executables: ['streamlink.exe']
    };
}

function writeExistingInstallation(installPath: string, contents = 'old executable'): void {
    fs.mkdirSync(path.join(installPath, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(installPath, 'bin', 'streamlink.exe'), contents);
}

function createInstaller(options: {
    archiveContents?: string;
    extract?: (archivePath: string, destinationPath: string) => Promise<void>;
    rename?: (sourcePath: string, destinationPath: string) => void;
} = {}) {
    const installPath = path.join(directory, 'installed');
    const tempPath = path.join(directory, 'temporary');
    const download = vi.fn(async (_sourceUrl: string, archivePath: string) => {
        fs.mkdirSync(path.dirname(archivePath), { recursive: true });
        fs.writeFileSync(archivePath, options.archiveContents ?? 'verified archive');
    });
    const extract = options.extract ?? (async (_archivePath: string, destinationPath: string) => {
        fs.mkdirSync(path.join(destinationPath, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(destinationPath, 'bin', 'streamlink.exe'), 'new executable');
    });

    return {
        installPath,
        installer: createManagedToolInstaller({
            installationDirectory: installPath,
            temporaryDirectory: tempPath,
            download,
            extract,
            rename: options.rename
        }),
        download
    };
}

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-vod-manager-managed-tools-'));
});

afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('managed tool installer', () => {
    it('retains the working installation when the downloaded archive hash is corrupted', async () => {
        const { installer, installPath, download } = createInstaller({ archiveContents: 'corrupted archive' });
        writeExistingInstallation(installPath);

        const result = await installer.repair(manifest());

        expect(result.success).toBe(false);
        expect(result.error).toBe('archive-hash-mismatch');
        expect(download).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(path.join(installPath, 'bin', 'streamlink.exe'), 'utf8')).toBe('old executable');
    });

    it('retains the working installation when extraction is interrupted', async () => {
        const { installer, installPath } = createInstaller({
            extract: async () => { throw new Error('interrupted extraction'); }
        });
        writeExistingInstallation(installPath);

        const result = await installer.repair(manifest());

        expect(result.success).toBe(false);
        expect(result.error).toBe('extract-failed');
        expect(fs.readFileSync(path.join(installPath, 'bin', 'streamlink.exe'), 'utf8')).toBe('old executable');
    });

    it('retains the working installation when a staged archive lacks the required executable', async () => {
        const { installer, installPath } = createInstaller({
            extract: async (_archivePath, destinationPath) => {
                fs.mkdirSync(destinationPath, { recursive: true });
                fs.writeFileSync(path.join(destinationPath, 'readme.txt'), 'missing executable');
            }
        });
        writeExistingInstallation(installPath);

        const result = await installer.repair(manifest());

        expect(result.success).toBe(false);
        expect(result.error).toBe('required-executable-missing');
        expect(fs.readFileSync(path.join(installPath, 'bin', 'streamlink.exe'), 'utf8')).toBe('old executable');
    });

    it('restores the previous tool when promotion of the staged installation fails', async () => {
        const installPath = path.join(directory, 'installed');
        let failedPromotion = false;
        const { installer } = createInstaller({
            rename: (sourcePath, destinationPath) => {
                if (!failedPromotion && sourcePath.includes('.stage-') && destinationPath === installPath) {
                    failedPromotion = true;
                    throw new Error('promotion interrupted');
                }
                fs.renameSync(sourcePath, destinationPath);
            }
        });
        writeExistingInstallation(installPath);

        const result = await installer.repair(manifest());

        expect(result.success).toBe(false);
        expect(result.error).toBe('promotion-failed');
        expect(fs.readFileSync(path.join(installPath, 'bin', 'streamlink.exe'), 'utf8')).toBe('old executable');
    });

    it('reports promotion failure when the previous installation cannot be restored', async () => {
        const installPath = path.join(directory, 'installed');
        const { installer } = createInstaller({
            rename: (sourcePath, destinationPath) => {
                if (sourcePath.includes('.stage-') && destinationPath === installPath) {
                    throw new Error('promotion interrupted');
                }
                if (sourcePath.includes('.backup-') && destinationPath === installPath) {
                    throw new Error('rollback interrupted');
                }
                fs.renameSync(sourcePath, destinationPath);
            }
        });
        writeExistingInstallation(installPath);

        const result = await installer.repair(manifest());

        expect(result.success).toBe(false);
        expect(result.error).toBe('promotion-failed');
    });

    it('reports a verified manifest version only after a staged install is promoted', async () => {
        const { installer, installPath } = createInstaller();

        const result = await installer.repair(manifest());

        expect(result.success).toBe(true);
        expect(fs.readFileSync(path.join(installPath, 'bin', 'streamlink.exe'), 'utf8')).toBe('new executable');
        expect(result.status).toMatchObject({
            id: 'streamlink',
            version: '8.4.0',
            state: 'verified',
            verified: true
        });
    });

    it('marks a mismatched installed version as unverified', () => {
        const { installer, installPath } = createInstaller();
        writeExistingInstallation(installPath);
        fs.writeFileSync(path.join(installPath, '.tool-manifest.json'), JSON.stringify({
            id: 'streamlink',
            version: '8.3.0',
            sourceUrl: 'https://example.invalid/streamlink-8.3.0.zip',
            archiveName: 'streamlink-8.3.0.zip',
            sha256: sha256('old archive')
        }));

        expect(installer.status(manifest())).toMatchObject({
            version: '8.3.0',
            state: 'unverified',
            verified: false
        });
    });

    it('shares one repair operation for concurrent requests', async () => {
        let releaseDownload: (() => void) | undefined;
        const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve; });
        const { installer, download } = createInstaller({
            extract: async (_archivePath, destinationPath) => {
                fs.mkdirSync(path.join(destinationPath, 'bin'), { recursive: true });
                fs.writeFileSync(path.join(destinationPath, 'bin', 'streamlink.exe'), 'new executable');
            }
        });
        download.mockImplementationOnce(async (_sourceUrl: string, archivePath: string) => {
            await downloadGate;
            fs.mkdirSync(path.dirname(archivePath), { recursive: true });
            fs.writeFileSync(archivePath, 'verified archive');
        });

        const first = installer.repair(manifest());
        const second = installer.repair(manifest());
        await Promise.resolve();
        expect(download).toHaveBeenCalledTimes(1);

        releaseDownload?.();
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult.success).toBe(true);
        expect(secondResult.success).toBe(true);
        expect(download).toHaveBeenCalledTimes(1);
    });
});

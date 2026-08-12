import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fileSystemSpies = vi.hoisted(() => ({
    readFileSync: vi.fn(),
    createReadStream: vi.fn()
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    fileSystemSpies.readFileSync.mockImplementation(actual.readFileSync);
    fileSystemSpies.createReadStream.mockImplementation(actual.createReadStream);
    return {
        ...actual,
        readFileSync: fileSystemSpies.readFileSync,
        createReadStream: fileSystemSpies.createReadStream
    };
});

import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
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

function writeVerifiedInstallation(installPath: string, contents = 'old executable'): void {
    writeExistingInstallation(installPath, contents);
    const toolManifest = manifest();
    fs.writeFileSync(path.join(installPath, '.tool-manifest.json'), JSON.stringify({
        id: toolManifest.id,
        version: toolManifest.version,
        sourceUrl: toolManifest.sourceUrl,
        archiveName: toolManifest.archiveName,
        sha256: toolManifest.sha256,
        executableHashes: { 'streamlink.exe': sha256(contents) }
    }));
}

function writeInterruptedPromotionJournal(installPath: string, backupPath: string, stagingPath: string, phase: string): void {
    fs.writeFileSync(`${installPath}.transaction.json`, JSON.stringify({
        installationDirectory: installPath,
        backupDirectory: backupPath,
        stagingDirectory: stagingPath,
        phase
    }));
}

function createInstaller(options: {
    archiveContents?: string;
    extract?: (archivePath: string, destinationPath: string) => Promise<void>;
    rename?: (sourcePath: string, destinationPath: string) => void;
    remove?: (targetPath: string, options: { recursive?: boolean; force?: boolean }) => void;
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
            rename: options.rename,
            remove: options.remove
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

    it('reports recovery failure when the previous installation cannot be restored', async () => {
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
        expect(result.error).toBe('recovery-restore-failed');
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

    it('marks a mismatched installed version as unverified', async () => {
        const { installer, installPath } = createInstaller();
        writeExistingInstallation(installPath);
        fs.writeFileSync(path.join(installPath, '.tool-manifest.json'), JSON.stringify({
            id: 'streamlink',
            version: '8.3.0',
            sourceUrl: 'https://example.invalid/streamlink-8.3.0.zip',
            archiveName: 'streamlink-8.3.0.zip',
            sha256: sha256('old archive')
        }));

        await expect(installer.status(manifest())).resolves.toMatchObject({
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
        await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));

        releaseDownload?.();
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult.success).toBe(true);
        expect(secondResult.success).toBe(true);
        expect(download).toHaveBeenCalledTimes(1);
    });

    it('restores a valid previous tool at the active path after interruption between backup and promotion', async () => {
        const { installer, installPath } = createInstaller();
        const backupPath = `${installPath}.backup-interrupted`;
        const stagingPath = `${installPath}.stage-interrupted`;
        writeVerifiedInstallation(backupPath, 'old executable');
        writeVerifiedInstallation(stagingPath, 'new executable');
        writeInterruptedPromotionJournal(installPath, backupPath, stagingPath, 'backup-created');

        await expect(installer.status(manifest())).resolves.toMatchObject({ state: 'verified', verified: true });
        expect(fs.readFileSync(path.join(installPath, 'bin', 'streamlink.exe'), 'utf8')).toBe('old executable');
        expect(fs.existsSync(backupPath)).toBe(false);
        expect(fs.existsSync(stagingPath)).toBe(false);
        expect(fs.existsSync(`${installPath}.transaction.json`)).toBe(false);
    });

    it('keeps a valid promoted tool after interruption between promotion and journal cleanup', async () => {
        const { installer, installPath } = createInstaller();
        const backupPath = `${installPath}.backup-interrupted`;
        const stagingPath = `${installPath}.stage-interrupted`;
        writeVerifiedInstallation(installPath, 'new executable');
        writeVerifiedInstallation(backupPath, 'old executable');
        writeInterruptedPromotionJournal(installPath, backupPath, stagingPath, 'backup-created');

        await expect(installer.status(manifest())).resolves.toMatchObject({ state: 'verified', verified: true });
        expect(fs.readFileSync(path.join(installPath, 'bin', 'streamlink.exe'), 'utf8')).toBe('new executable');
        expect(fs.existsSync(backupPath)).toBe(false);
        expect(fs.existsSync(`${installPath}.transaction.json`)).toBe(false);
    });

    it('reports a precise recovery failure while preserving the usable backup path', async () => {
        const installPath = path.join(directory, 'installed');
        const backupPath = `${installPath}.backup-interrupted`;
        const stagingPath = `${installPath}.stage-interrupted`;
        const { installer } = createInstaller({
            rename: (sourcePath, destinationPath) => {
                if (sourcePath === backupPath && destinationPath === installPath) {
                    throw new Error('restore denied');
                }
                fs.renameSync(sourcePath, destinationPath);
            }
        });
        writeVerifiedInstallation(backupPath, 'old executable');
        writeVerifiedInstallation(stagingPath, 'new executable');
        writeInterruptedPromotionJournal(installPath, backupPath, stagingPath, 'backup-created');

        const result = await installer.repair(manifest());

        expect(result.success).toBe(false);
        expect(result.error).toBe('recovery-restore-failed');
        expect(result.detail).toContain('restore denied');
        expect(fs.readFileSync(path.join(backupPath, 'bin', 'streamlink.exe'), 'utf8')).toBe('old executable');
    });

    it('does not leave a repair in flight when archive cleanup fails', async () => {
        let archiveCleanupFailed = false;
        const { installer, download } = createInstaller({
            remove: (targetPath, options) => {
                if (!archiveCleanupFailed && String(targetPath).includes(manifest().archiveName)) {
                    archiveCleanupFailed = true;
                    throw new Error('archive cleanup denied');
                }
                fs.rmSync(targetPath, options);
            }
        });

        const first = await installer.repair(manifest());
        const second = await installer.repair(manifest());

        expect(first.success).toBe(true);
        expect(first.diagnostics).toContain('archive cleanup denied');
        expect(second.success).toBe(true);
        expect(download).toHaveBeenCalledTimes(2);
    });

    it('marks a changed managed executable corrupt and repairs it from a verified archive', async () => {
        const { installer, installPath } = createInstaller();
        const installed = await installer.repair(manifest());
        expect(installed.success).toBe(true);
        fs.writeFileSync(path.join(installPath, 'bin', 'streamlink.exe'), 'changed executable');

        await expect(installer.status(manifest())).resolves.toMatchObject({ state: 'corrupt', verified: false });

        const repaired = await installer.repair(manifest());
        expect(repaired.success).toBe(true);
        expect(repaired.status).toMatchObject({ state: 'verified', verified: true });
        expect(fs.readFileSync(path.join(installPath, 'bin', 'streamlink.exe'), 'utf8')).toBe('new executable');
    });

    it('promotes a verified staged first install after interruption before promotion', async () => {
        const { installer, installPath, download } = createInstaller();
        const stagingPath = `${installPath}.stage-interrupted`;
        writeVerifiedInstallation(stagingPath, 'first executable');
        writeInterruptedPromotionJournal(installPath, `${installPath}.backup-interrupted`, stagingPath, 'staged');

        await expect(installer.status(manifest())).resolves.toMatchObject({ state: 'verified', verified: true });
        expect(fs.readFileSync(path.join(installPath, 'bin', 'streamlink.exe'), 'utf8')).toBe('first executable');
        expect(fs.existsSync(stagingPath)).toBe(false);
        expect(fs.existsSync(`${installPath}.transaction.json`)).toBe(false);

        const result = await installer.install(manifest());
        expect(result.success).toBe(true);
        expect(download).not.toHaveBeenCalled();
    });

    it('clears a staged first-install journal after promotion before its phase update', async () => {
        const { installer, installPath, download } = createInstaller();
        writeVerifiedInstallation(installPath, 'first executable');
        writeInterruptedPromotionJournal(installPath, `${installPath}.backup-interrupted`, `${installPath}.stage-interrupted`, 'staged');

        await expect(installer.status(manifest())).resolves.toMatchObject({ state: 'verified', verified: true });
        expect(fs.readFileSync(path.join(installPath, 'bin', 'streamlink.exe'), 'utf8')).toBe('first executable');
        expect(fs.existsSync(`${installPath}.transaction.json`)).toBe(false);

        const result = await installer.install(manifest());
        expect(result.success).toBe(true);
        expect(download).not.toHaveBeenCalled();
    });

    it('streams multi-megabyte executable verification without readFileSync and detects corruption', async () => {
        const multiMegabyteExecutable = Buffer.alloc(3 * 1024 * 1024, 0x5a);
        const { installer, installPath } = createInstaller({
            extract: async (_archivePath, destinationPath) => {
                fs.mkdirSync(path.join(destinationPath, 'bin'), { recursive: true });
                fs.writeFileSync(path.join(destinationPath, 'bin', 'streamlink.exe'), multiMegabyteExecutable);
            }
        });

        expect((await installer.repair(manifest())).success).toBe(true);
        fileSystemSpies.readFileSync.mockClear();

        await expect(installer.status(manifest())).resolves.toMatchObject({ state: 'verified', verified: true });
        expect(fileSystemSpies.readFileSync).not.toHaveBeenCalled();

        fs.writeFileSync(path.join(installPath, 'bin', 'streamlink.exe'), Buffer.alloc(3 * 1024 * 1024, 0x2a));
        await expect(installer.status(manifest())).resolves.toMatchObject({ state: 'corrupt', verified: false });
        expect(fileSystemSpies.readFileSync).not.toHaveBeenCalled();
    });

    it('waits for hash streams to close before promoting a verified installation', async () => {
        const createReadStream = fileSystemSpies.createReadStream.getMockImplementation();
        if (!createReadStream) throw new Error('createReadStream mock is not initialized');
        let openStreams = 0;
        fileSystemSpies.createReadStream.mockImplementation((filePath: fs.PathLike) => {
            const stream = new EventEmitter();
            openStreams += 1;
            queueMicrotask(() => {
                stream.emit('data', fs.readFileSync(filePath));
                stream.emit('end');
                setImmediate(() => {
                    openStreams -= 1;
                    stream.emit('close');
                });
            });
            return stream as fs.ReadStream;
        });

        const installPath = path.join(directory, 'installed');
        const { installer } = createInstaller({
            rename: (sourcePath, destinationPath) => {
                if (sourcePath.includes('.stage-') && destinationPath === installPath && openStreams > 0) {
                    throw new Error('hash stream still open');
                }
                fs.renameSync(sourcePath, destinationPath);
            }
        });

        try {
            await expect(installer.repair(manifest())).resolves.toMatchObject({ success: true });
        } finally {
            fileSystemSpies.createReadStream.mockImplementation(createReadStream);
        }
    });
});

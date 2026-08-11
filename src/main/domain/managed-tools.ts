import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ManagedToolId = 'streamlink' | 'ffmpeg';

export interface ExternalToolManifest {
    id: ManagedToolId;
    version: string;
    sourceUrl: string;
    archiveName: string;
    sha256: string;
    executables: string[];
}

export interface ManagedToolStatus {
    id: ManagedToolId;
    version: string;
    sourceUrl: string;
    archiveName: string;
    state: 'missing' | 'installing' | 'verified' | 'unverified' | 'corrupt';
    verified: boolean;
}

export interface ManagedToolInstallResult {
    success: boolean;
    status: ManagedToolStatus;
    error?: 'download-failed' | 'archive-hash-mismatch' | 'extract-failed' | 'required-executable-missing' | 'promotion-failed';
}

interface ManagedToolRecord {
    id: ManagedToolId;
    version: string;
    sourceUrl: string;
    archiveName: string;
    sha256: string;
}

export interface ManagedToolInstallerOptions {
    installationDirectory: string;
    temporaryDirectory: string;
    download(sourceUrl: string, archivePath: string): Promise<void>;
    extract(archivePath: string, destinationPath: string): Promise<void>;
    rename?(sourcePath: string, destinationPath: string): void;
}

const RECORD_FILE_NAME = '.tool-manifest.json';

function findFileRecursive(rootDir: string, fileName: string): string | null {
    try {
        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(rootDir, entry.name);
            if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
                return entryPath;
            }
            if (entry.isDirectory()) {
                const nested = findFileRecursive(entryPath, fileName);
                if (nested) return nested;
            }
        }
    } catch {
        return null;
    }
    return null;
}

function sha256File(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isRecord(value: unknown): value is ManagedToolRecord {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return typeof record.id === 'string'
        && typeof record.version === 'string'
        && typeof record.sourceUrl === 'string'
        && typeof record.archiveName === 'string'
        && typeof record.sha256 === 'string';
}

function matchesManifest(record: ManagedToolRecord, manifest: ExternalToolManifest): boolean {
    return record.id === manifest.id
        && record.version === manifest.version
        && record.sourceUrl === manifest.sourceUrl
        && record.archiveName === manifest.archiveName
        && record.sha256 === manifest.sha256;
}

export class ManagedToolInstaller {
    private readonly inFlight = new Map<ManagedToolId, Promise<ManagedToolInstallResult>>();

    constructor(private readonly options: ManagedToolInstallerOptions) {}

    status(manifest: ExternalToolManifest, includeInstallState = true): ManagedToolStatus {
        const base: Omit<ManagedToolStatus, 'state' | 'verified'> = {
            id: manifest.id,
            version: manifest.version,
            sourceUrl: manifest.sourceUrl,
            archiveName: manifest.archiveName
        };

        if (includeInstallState && this.inFlight.has(manifest.id)) {
            return { ...base, state: 'installing', verified: false };
        }

        if (!fs.existsSync(this.options.installationDirectory)) {
            return { ...base, state: 'missing', verified: false };
        }

        let record: ManagedToolRecord | null = null;
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(this.options.installationDirectory, RECORD_FILE_NAME), 'utf8'));
            if (!isRecord(parsed)) {
                return { ...base, state: 'corrupt', verified: false };
            }
            record = parsed;
        } catch {
            const hasAnyExecutable = manifest.executables.some((name) => findFileRecursive(this.options.installationDirectory, name));
            return { ...base, state: hasAnyExecutable ? 'unverified' : 'corrupt', verified: false };
        }

        const recordBase = { ...base, version: record.version };
        if (!matchesManifest(record, manifest)) {
            return { ...recordBase, state: 'unverified', verified: false };
        }

        const allExecutablesPresent = manifest.executables.every((name) => findFileRecursive(this.options.installationDirectory, name));
        return allExecutablesPresent
            ? { ...recordBase, state: 'verified', verified: true }
            : { ...recordBase, state: 'corrupt', verified: false };
    }

    install(manifest: ExternalToolManifest): Promise<ManagedToolInstallResult> {
        const currentStatus = this.status(manifest);
        if (currentStatus.verified) {
            return Promise.resolve({ success: true, status: currentStatus });
        }
        return this.start(manifest);
    }

    repair(manifest: ExternalToolManifest): Promise<ManagedToolInstallResult> {
        return this.start(manifest);
    }

    reset(manifest: ExternalToolManifest): ManagedToolStatus {
        if (this.inFlight.has(manifest.id)) {
            return this.status(manifest);
        }
        fs.rmSync(this.options.installationDirectory, { recursive: true, force: true });
        return this.status(manifest);
    }

    private start(manifest: ExternalToolManifest): Promise<ManagedToolInstallResult> {
        const existing = this.inFlight.get(manifest.id);
        if (existing) return existing;

        const operation = this.installOnce(manifest);
        this.inFlight.set(manifest.id, operation);
        void operation.then(() => {
            if (this.inFlight.get(manifest.id) === operation) {
                this.inFlight.delete(manifest.id);
            }
        });
        return operation;
    }

    private async installOnce(manifest: ExternalToolManifest): Promise<ManagedToolInstallResult> {
        const uniqueSuffix = crypto.randomUUID();
        const archivePath = path.join(this.options.temporaryDirectory, `${manifest.archiveName}.${uniqueSuffix}`);
        const stagingDirectory = `${this.options.installationDirectory}.stage-${uniqueSuffix}`;
        let error: ManagedToolInstallResult['error'] | undefined;

        try {
            fs.mkdirSync(this.options.temporaryDirectory, { recursive: true });
            await this.options.download(manifest.sourceUrl, archivePath);
            if (sha256File(archivePath).toLowerCase() !== manifest.sha256.toLowerCase()) {
                error = 'archive-hash-mismatch';
                return { success: false, error, status: this.status(manifest, false) };
            }

            try {
                await this.options.extract(archivePath, stagingDirectory);
            } catch {
                error = 'extract-failed';
                return { success: false, error, status: this.status(manifest, false) };
            }

            if (!manifest.executables.every((name) => findFileRecursive(stagingDirectory, name))) {
                error = 'required-executable-missing';
                return { success: false, error, status: this.status(manifest, false) };
            }

            const record: ManagedToolRecord = {
                id: manifest.id,
                version: manifest.version,
                sourceUrl: manifest.sourceUrl,
                archiveName: manifest.archiveName,
                sha256: manifest.sha256
            };
            fs.writeFileSync(path.join(stagingDirectory, RECORD_FILE_NAME), JSON.stringify(record));

            try {
                this.promote(stagingDirectory);
            } catch {
                error = 'promotion-failed';
                return { success: false, error, status: this.status(manifest, false) };
            }

            return { success: true, status: this.status(manifest, false) };
        } catch {
            error = 'download-failed';
            return { success: false, error, status: this.status(manifest, false) };
        } finally {
            fs.rmSync(archivePath, { force: true });
            fs.rmSync(stagingDirectory, { recursive: true, force: true });
        }
    }

    private promote(stagingDirectory: string): void {
        const backupDirectory = `${this.options.installationDirectory}.backup-${crypto.randomUUID()}`;
        const rename = this.options.rename ?? fs.renameSync;
        let previousMoved = false;

        try {
            if (fs.existsSync(this.options.installationDirectory)) {
                rename(this.options.installationDirectory, backupDirectory);
                previousMoved = true;
            }
            rename(stagingDirectory, this.options.installationDirectory);
            if (previousMoved) {
                try {
                    fs.rmSync(backupDirectory, { recursive: true, force: true });
                } catch {}
            }
        } catch (error) {
            if (previousMoved && fs.existsSync(backupDirectory) && !fs.existsSync(this.options.installationDirectory)) {
                try {
                    rename(backupDirectory, this.options.installationDirectory);
                } catch {}
            }
            throw error;
        }
    }
}

export function createManagedToolInstaller(options: ManagedToolInstallerOptions): ManagedToolInstaller {
    return new ManagedToolInstaller(options);
}

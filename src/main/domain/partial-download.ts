import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../infra/fs-atomic';

const PARTIAL_SUFFIX = '.tvm-part';

export class PartialDownloadRegistry {
    private readonly paths = new Set<string>();

    constructor(private readonly registryPath: string) {
        this.load(this.registryPath);
        this.load(`${this.registryPath}.tmp`);
    }

    begin(finalPath: string): string {
        const partialPath = path.resolve(`${finalPath}${PARTIAL_SUFFIX}`);
        if (fs.existsSync(partialPath)) fs.rmSync(partialPath, { force: true });
        this.paths.add(partialPath);
        this.persist();
        return partialPath;
    }

    commit(partialPath: string, finalPath: string): void {
        const normalizedPartialPath = this.normalize(partialPath);
        const normalizedFinalPath = path.resolve(finalPath);
        if (!fs.existsSync(normalizedPartialPath)) throw new Error(`Teil-Datei fehlt: ${normalizedPartialPath}`);
        if (fs.existsSync(normalizedFinalPath)) throw new Error(`Zieldatei existiert bereits: ${normalizedFinalPath}`);
        fs.renameSync(normalizedPartialPath, normalizedFinalPath);
        this.paths.delete(normalizedPartialPath);
        this.persist();
    }

    discard(partialPath: string): void {
        const normalizedPartialPath = this.normalize(partialPath);
        if (fs.existsSync(normalizedPartialPath)) fs.rmSync(normalizedPartialPath, { force: true });
        this.paths.delete(normalizedPartialPath);
        this.persist();
    }

    cleanup(): string[] {
        const removed: string[] = [];
        for (const partialPath of this.paths) {
            if (fs.existsSync(partialPath)) {
                fs.rmSync(partialPath, { force: true });
                removed.push(partialPath);
            }
        }
        this.paths.clear();
        this.persist();
        return removed;
    }

    private normalize(filePath: string): string {
        const normalizedPath = path.resolve(filePath);
        if (!normalizedPath.endsWith(PARTIAL_SUFFIX)) throw new Error(`Ungültiger Teil-Dateipfad: ${normalizedPath}`);
        return normalizedPath;
    }

    private load(filePath: string): void {
        try {
            if (!fs.existsSync(filePath)) return;
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const values = Array.isArray(parsed) ? parsed : parsed?.paths;
            if (!Array.isArray(values)) return;
            for (const value of values) {
                if (typeof value !== 'string') continue;
                try {
                    this.paths.add(this.normalize(value));
                } catch { }
            }
        } catch { }
    }

    private persist(): void {
        if (this.paths.size === 0) {
            fs.rmSync(this.registryPath, { force: true });
            fs.rmSync(`${this.registryPath}.tmp`, { force: true });
            return;
        }
        fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
        writeFileAtomicSync(this.registryPath, JSON.stringify({ paths: [...this.paths] }, null, 2));
    }
}

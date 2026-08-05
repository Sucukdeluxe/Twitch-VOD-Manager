import * as fs from 'fs';

/**
 * Atomic write via tmp + rename. Survives crash mid-write — either old or
 * new content, never partial. Windows fallback: copy + unlink if rename
 * fails (e.g. target locked by reader). fsync best-effort.
 */
export function writeFileAtomicSync(targetPath: string, payload: string | Buffer): void {
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf-8');
    const tmpPath = targetPath + '.tmp';

    let fd: number | null = null;
    try {
        fd = fs.openSync(tmpPath, 'w');
        fs.writeSync(fd, buffer, 0, buffer.length, 0);
        try { fs.fsyncSync(fd); } catch { /* fsync may fail on some FS; rename is still safer than nothing */ }
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
    }

    try {
        fs.renameSync(tmpPath, targetPath);
    } catch {
        fs.copyFileSync(tmpPath, targetPath);
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
}

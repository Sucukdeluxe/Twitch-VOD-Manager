import * as crypto from 'crypto';
import * as fs from 'fs';

export function hashBuffer(b: Buffer): string {
    return crypto.createHash('sha1').update(b).digest('hex');
}

/**
 * Streaming sha1-Hash einer Datei. Async, damit grosse Recorded-Segments
 * (oft mehrere MB) nicht den Event-Loop blockieren.
 */
export function hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk: Buffer | string) => {
            if (typeof chunk === 'string') {
                hash.update(chunk, 'utf-8');
            } else {
                hash.update(chunk);
            }
        });
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

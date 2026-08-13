import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(fileName: string): string {
    return readFileSync(join(__dirname, fileName), 'utf8');
}

describe('German production text', () => {
    it('keeps visible HTML and archive fallbacks free of replacement spellings', () => {
        expect(source('index.html')).not.toMatch(/>Offnen</);
        expect(source('index.html')).not.toMatch(/>Spater</);
        expect(source('renderer-archive.ts')).not.toContain("'Oeffnen'");
    });
});

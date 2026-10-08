import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve } from 'node:path';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const sourceDirectory = resolve(rootDirectory, 'src');
const outputDirectory = resolve(rootDirectory, 'dist');
const rendererDirectory = resolve(outputDirectory, 'renderer');
const sourceHtml = await readFile(resolve(sourceDirectory, 'index.html'), 'utf8');
const assets = [...sourceHtml.matchAll(/(?:href|src)="((?:\.\/|\.\.\/dist\/)[^"/]+\.(?:css|js))"/g)];
await mkdir(rendererDirectory, { recursive: true });
let rendererHtml = sourceHtml.replaceAll('../build/', '../../build/');
for (const [, reference] of assets) {
    const file = resolve(sourceDirectory, reference);
    const content = await readFile(file);
    const extension = extname(file);
    const stem = reference.split('/').at(-1).slice(0, -extension.length);
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const name = stem + '.' + digest + extension;
    try {
        await writeFile(resolve(rendererDirectory, name), content, { flag: 'wx' });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
    rendererHtml = rendererHtml.replaceAll('"' + reference + '"', '"./' + name + '"');
}
const temporaryPath = resolve(rendererDirectory, 'index.html.tmp');
await writeFile(temporaryPath, rendererHtml);
await rename(temporaryPath, resolve(rendererDirectory, 'index.html'));

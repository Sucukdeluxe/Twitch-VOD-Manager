import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';

const options = {
    absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
    entryPoints: ['src/vod-player/workspace.jsx'],
    bundle: true,
    outfile: 'dist/renderer-vod-player.js',
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    minify: true,
    legalComments: 'eof',
    define: { 'process.env.NODE_ENV': '"production"' },
};

if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);

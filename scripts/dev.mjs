import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { readFileSync, watch } from 'node:fs';
import { dirname, resolve } from 'node:path';

const scriptPath = fileURLToPath(import.meta.url);
const rootDirectory = resolve(dirname(scriptPath), '..');
const developmentAppVersion = JSON.parse(readFileSync(resolve(rootDirectory, 'package.json'), 'utf8')).version;
if (typeof developmentAppVersion !== 'string' || developmentAppVersion.trim().length === 0) {
    throw new Error('package.json version must be a non-empty string');
}
const electronSourceExecutable = process.platform === 'win32'
    ? resolve(rootDirectory, 'node_modules', 'electron', 'dist', 'electron.exe')
    : resolve(rootDirectory, 'node_modules', '.bin', 'electron');
let electronExecutable = electronSourceExecutable;
const outputDirectory = resolve(rootDirectory, 'dist');
const developmentProgramData = resolve(rootDirectory, '.dev-program-data');
const developmentUserData = resolve(rootDirectory, '.dev-user-data');
const developmentRelaunchCommand = `"${process.execPath}" "${scriptPath}" --once`;
const runOnce = process.argv.includes('--once');

let electronProcess;
let restarting = false;
let buildTimer;
let buildProcess;
let sourceWatcher;
let buildPending = false;
let stopping = false;

function run(command, args, options = {}) {
    return spawn(command, args, { cwd: rootDirectory, stdio: 'inherit', windowsHide: true, ...options });
}

function waitForExit(child) {
    return new Promise((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolveExit(code ?? 1));
    });
}

function startElectron() {
    electronProcess = run(electronExecutable, [`--user-data-dir=${developmentUserData}`, '.'], {
        windowsHide: false,
        env: {
            ...process.env,
            PROGRAMDATA: developmentProgramData,
            TWITCH_VOD_MANAGER_DEV: '1',
            TWITCH_VOD_MANAGER_RELAUNCH_COMMAND: developmentRelaunchCommand,
        },
    });
    electronProcess.once('exit', () => {
        electronProcess = undefined;
    });
    return electronProcess;
}

function restartElectron() {
    if (restarting) return;
    restarting = true;
    if (electronProcess) {
        electronProcess.once('exit', () => {
            restarting = false;
            startElectron();
        });
        electronProcess.kill();
        return;
    }
    restarting = false;
    startElectron();
}

async function buildAndRestart() {
    if (buildProcess || stopping || !buildPending) return;
    clearTimeout(buildTimer);
    buildPending = false;
    buildProcess = run(process.execPath, [resolve(rootDirectory, 'scripts', 'build.mjs')]);
    const exitCode = await waitForExit(buildProcess);
    buildProcess = undefined;
    if (stopping) return;
    if (buildPending) {
        await buildAndRestart();
    } else if (exitCode === 0) {
        restartElectron();
    }
}

function scheduleBuild(fileName) {
    const name = fileName?.toString() ?? '';
    if (!/\.(?:ts|tsx|js|jsx|css|html)$/.test(name) || /\.(?:test|spec)\./.test(name)) return;
    buildPending = true;
    clearTimeout(buildTimer);
    buildTimer = setTimeout(() => void buildAndRestart(), 300);
}

function stop(child) {
    if (child && !child.killed) child.kill();
}

const initialCompile = run(process.execPath, [resolve(rootDirectory, 'scripts', 'build.mjs')]);
const initialExitCode = await waitForExit(initialCompile);
if (initialExitCode !== 0) process.exit(initialExitCode);

if (process.platform === 'win32') {
    const helperPath = pathToFileURL(resolve(outputDirectory, 'main', 'dev-executable.js')).href;
    const { prepareWindowsDevExecutable } = await import(helperPath);
    electronExecutable = await prepareWindowsDevExecutable({
        sourcePath: electronSourceExecutable,
        destinationPath: resolve(rootDirectory, 'node_modules', 'electron', 'dist', 'Twitch VOD Manager.exe'),
        iconPath: resolve(rootDirectory, 'build', 'icon.ico'),
        version: developmentAppVersion,
    });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        stopping = true;
        sourceWatcher?.close();
        clearTimeout(buildTimer);
        stop(buildProcess);
        stop(electronProcess);
        process.exit();
    });
}

if (runOnce) {
    process.exitCode = await waitForExit(startElectron());
} else {
    sourceWatcher = watch(resolve(rootDirectory, 'src'), { recursive: true }, (_, fileName) => scheduleBuild(fileName));
    startElectron();
}

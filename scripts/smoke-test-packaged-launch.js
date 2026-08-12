const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function packagedExecutablePath() {
  if (process.env.PACKAGED_APP_PATH) return path.resolve(process.env.PACKAGED_APP_PATH);
  return path.join(root, 'release', 'win-unpacked', `${packageJson.build.productName}.exe`);
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

async function verifyPackagedLaunch(executablePath = packagedExecutablePath(), readyMs = 5000) {
  if (process.platform !== 'win32') throw new Error('Packaged launch smoke requires Windows');
  if (!fs.statSync(executablePath).isFile()) throw new Error(`Packaged executable is missing: ${executablePath}`);

  const environmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-packaged-launch-'));
  const userDataDir = path.join(environmentRoot, 'userdata');
  const programDataDir = path.join(environmentRoot, 'programdata');
  const appDataDir = path.join(environmentRoot, 'appdata');
  const localAppDataDir = path.join(environmentRoot, 'localappdata');
  const tempDir = path.join(environmentRoot, 'temp');
  for (const directory of [userDataDir, programDataDir, appDataDir, localAppDataDir, tempDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  let output = '';
  const child = spawn(executablePath, [
    `--user-data-dir=${userDataDir}`,
    '--proxy-server=http://127.0.0.1:1',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
  ], {
    cwd: path.dirname(executablePath),
    env: {
      ...process.env,
      PROGRAMDATA: programDataDir,
      APPDATA: appDataDir,
      LOCALAPPDATA: localAppDataDir,
      TEMP: tempDir,
      TMP: tempDir,
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      ALL_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const capture = (chunk) => {
    output = `${output}${chunk}`.slice(-32768);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  try {
    const result = await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), readyMs))
    ]);
    if (result) throw new Error(`Packaged app exited before readiness: ${JSON.stringify({ ...result, output })}`);
    return { executablePath, readyMs };
  } finally {
    terminateProcessTree(child);
    fs.rmSync(environmentRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  verifyPackagedLaunch()
    .then((result) => console.log(JSON.stringify({ failures: [], result }, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = { packagedExecutablePath, verifyPackagedLaunch };

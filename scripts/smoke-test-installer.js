const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    timeout: 240000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr })}`);
  }
  return result;
}

function findUninstaller(installationDirectory) {
  return fs.readdirSync(installationDirectory)
    .filter((name) => /^uninstall.*\.exe$/i.test(name))
    .map((name) => path.join(installationDirectory, name))[0] || '';
}

function main() {
  if (process.platform !== 'win32') throw new Error('Installer smoke requires Windows');
  if (process.env.CI !== 'true' && process.env.TWITCH_VOD_MANAGER_INSTALLER_SMOKE !== '1') {
    throw new Error('Installer smoke is restricted to CI or explicit TWITCH_VOD_MANAGER_INSTALLER_SMOKE=1 opt-in');
  }

  const installerPath = path.join(root, 'release', `Twitch-VOD-Manager-Setup-${packageJson.version}.exe`);
  if (!fs.statSync(installerPath).isFile()) throw new Error(`Installer is missing: ${installerPath}`);

  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-installer-'));
  const installationDirectory = path.join(smokeRoot, 'app');
  const executablePath = path.join(installationDirectory, `${packageJson.build.productName}.exe`);
  let uninstallerPath = '';

  try {
    run(installerPath, ['/S', `/D=${installationDirectory}`], { cwd: smokeRoot });
    if (!fs.statSync(executablePath).isFile()) throw new Error(`Installed executable is missing: ${executablePath}`);
    uninstallerPath = findUninstaller(installationDirectory);
    if (!uninstallerPath) throw new Error('Installed uninstaller is missing');
    run(process.execPath, [path.join(__dirname, 'smoke-test-packaged-launch.js')], {
      cwd: root,
      env: { ...process.env, PACKAGED_APP_PATH: executablePath }
    });
    run(uninstallerPath, ['/S'], { cwd: smokeRoot });
    if (fs.existsSync(executablePath)) throw new Error('Silent uninstall left the packaged executable installed');
    console.log(JSON.stringify({ failures: [], installerPath }, null, 2));
  } finally {
    if (uninstallerPath && fs.existsSync(uninstallerPath)) {
      spawnSync(uninstallerPath, ['/S'], { cwd: smokeRoot, timeout: 240000, windowsHide: true, stdio: 'ignore' });
    }
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { spawnSync } = require('child_process');

const {
  assertHostedWindowsCi,
  assertInstalledRegistration,
  assertInstallerSurfaceClean,
  assertPathInside,
  assertShortcutDetails,
  createInstallerPhases,
  readShortcutDetails,
  registryKeys
} = require('./smoke-test-installer');

const builderInstallerSource = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include', 'installer.nsh'), 'utf8');
const builderMultiUserSource = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'multiUser.nsh'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('real installer smoke cannot be enabled on a local workstation', () => {
  assert.throws(
    () => assertHostedWindowsCi({ TWITCH_VOD_MANAGER_INSTALLER_SMOKE: '1' }, 'win32'),
    /approved Windows Actions runner/
  );
});

test('real installer smoke rejects generic local CI identities', () => {
  assert.throws(() => assertHostedWindowsCi({
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_RUN_ID: '123',
    GITHUB_SERVER_URL: 'https://ci.example.test',
    RUNNER_OS: 'Windows',
    RUNNER_TEMP: 'C:\\runner-temp'
  }, 'win32'), /approved Windows Actions runner/);
});

test('real installer smoke accepts the GitHub Windows Actions identity', () => {
  assert.doesNotThrow(() => assertHostedWindowsCi({
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_RUN_ID: '123',
    GITHUB_SERVER_URL: 'https://github.com',
    RUNNER_OS: 'Windows',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_TEMP: 'C:\\runner-temp'
  }, 'win32'));
});

test('real installer smoke accepts the git.24-music.de Gitea Windows Actions identity', () => {
  assert.doesNotThrow(() => assertHostedWindowsCi({
    CI: 'true',
    GITEA_ACTIONS: 'true',
    GITHUB_RUN_ID: '456',
    GITHUB_SERVER_URL: 'https://git.24-music.de',
    RUNNER_OS: 'Windows',
    RUNNER_TEMP: 'C:\\runner-temp'
  }, 'win32'));
  assert.doesNotThrow(() => assertHostedWindowsCi({
    CI: 'true',
    GITEA_ACTIONS: 'true',
    GITHUB_RUN_ID: '456',
    GITHUB_SERVER_URL: 'https://git.24-music.de',
    RUNNER_OS: 'windows',
    RUNNER_TEMP: 'C:\\runner-temp'
  }, 'win32'));
});

test('installer phases cover current user then all users with scope-correct paths', () => {
  const phases = createInstallerPhases('C:\\smoke', {
    commonDesktop: 'C:\\shared-desktop',
    commonPrograms: 'C:\\shared-programs',
    currentDesktop: 'C:\\user-desktop',
    currentPrograms: 'C:\\user-programs'
  });

  assert.deepStrictEqual(phases.map((phase) => ({
    flag: phase.flag,
    hive: phase.hive,
    installationDirectory: phase.installationDirectory,
    startMenuShortcut: phase.startMenuShortcut
  })), [
    {
      flag: '/currentuser',
      hive: 'HKCU',
      installationDirectory: 'C:\\smoke\\currentuser\\app',
      startMenuShortcut: 'C:\\user-programs\\Twitch VOD Manager.lnk'
    },
    {
      flag: '/allusers',
      hive: 'HKLM',
      installationDirectory: 'C:\\smoke\\allusers\\app',
      startMenuShortcut: 'C:\\shared-programs\\Twitch VOD Manager.lnk'
    }
  ]);
  for (const phase of phases) {
    assert.deepStrictEqual(phase.installArguments, ['/S', phase.flag, `/D=${phase.installationDirectory}`]);
  }
});

test('installer phases reject unresolved Windows shell folders', () => {
  assert.throws(() => createInstallerPhases('C:\\smoke', {
    commonDesktop: '',
    commonPrograms: 'C:\\shared-programs',
    currentDesktop: 'C:\\user-desktop',
    currentPrograms: 'C:\\user-programs'
  }), /commonDesktop/);
});

test('shortcut contract verifies the real target and versioned installed icon', () => {
  const expectedIcon = `C:\\smoke\\currentuser\\app\\resources\\app-icons\\icon-${packageJson.version}.ico`;
  const existingPaths = new Set([
    'c:\\smoke\\currentuser\\app\\twitch vod manager.exe',
    expectedIcon.toLowerCase()
  ]);
  assert.doesNotThrow(() => assertShortcutDetails({
    iconLocation: `${expectedIcon},0`,
    targetPath: 'C:\\smoke\\currentuser\\app\\Twitch VOD Manager.exe'
  }, {
    expectedIcon,
    expectedTarget: 'C:\\smoke\\currentuser\\app\\Twitch VOD Manager.exe',
    pathExists: (candidate) => existingPaths.has(candidate.toLowerCase())
  }));
  assert.throws(() => assertShortcutDetails({
    iconLocation: 'C:\\Users\\runner\\AppData\\Local\\Twitch VOD Manager\\Shortcut Icons\\icon-1.0.17.ico,0',
    targetPath: 'C:\\smoke\\currentuser\\app\\Twitch VOD Manager.exe'
  }, {
    expectedIcon,
    expectedTarget: 'C:\\smoke\\currentuser\\app\\Twitch VOD Manager.exe',
    pathExists: () => true
  }), /icon/i);
});

test('shortcut inspection reads a real temporary Windows link', { skip: process.platform !== 'win32' }, () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-link-contract-'));
  const targetPath = path.join(temporaryRoot, 'Twitch VOD Manager.exe');
  const iconPath = path.join(temporaryRoot, 'icon.ico');
  const wrongTargetPath = path.join(temporaryRoot, 'Wrong Twitch VOD Manager.exe');
  const shortcutPath = path.join(temporaryRoot, 'Twitch VOD Manager.lnk');
  try {
    fs.writeFileSync(targetPath, 'target');
    fs.writeFileSync(iconPath, 'icon');
    fs.writeFileSync(wrongTargetPath, 'wrong target');
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:TVM_TEST_SHORTCUT); $shortcut.TargetPath = $env:TVM_TEST_TARGET; $shortcut.IconLocation = $env:TVM_TEST_ICON; $shortcut.Save(); $folder = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TVM_TEST_ROOT); [Console]::Write($folder.ShortPath)"], {
      encoding: 'utf8',
      env: { ...process.env, TVM_TEST_ICON: iconPath, TVM_TEST_ROOT: temporaryRoot, TVM_TEST_SHORTCUT: shortcutPath, TVM_TEST_TARGET: targetPath },
      windowsHide: true
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const details = readShortcutDetails(shortcutPath);
    const shortRoot = result.stdout.trim();
    const expectedTarget = path.join(shortRoot, path.basename(targetPath));
    const expectedIcon = path.join(shortRoot, path.basename(iconPath));
    assert.doesNotThrow(() => assertShortcutDetails(details, { expectedIcon, expectedTarget }));
    assert.throws(() => assertShortcutDetails(details, {
      expectedIcon,
      expectedTarget: wrongTargetPath
    }), /target mismatch/i);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('registration contract proves the selected hive, install path and uninstall mode', () => {
  const [phase] = createInstallerPhases('C:\\smoke', {
    commonDesktop: 'C:\\shared-desktop',
    commonPrograms: 'C:\\shared-programs',
    currentDesktop: 'C:\\user-desktop',
    currentPrograms: 'C:\\user-programs'
  });
  const selected = registryKeys('HKCU');
  const values = new Map([
    [`${selected.install}|InstallLocation`, phase.installationDirectory],
    [`${selected.uninstall}|UninstallString`, `"C:\\smoke\\currentuser\\app\\Uninstall Twitch VOD Manager.exe" ${phase.flag}`],
    [`${selected.uninstall}|QuietUninstallString`, `"C:\\smoke\\currentuser\\app\\Uninstall Twitch VOD Manager.exe" ${phase.flag} /S`]
  ]);
  assert.doesNotThrow(() => assertInstalledRegistration(phase, {
    expectedUninstallerPath: 'C:\\smoke\\currentuser\\app\\Uninstall Twitch VOD Manager.exe',
    keyExists: (key) => [...values.keys()].some((entry) => entry.startsWith(`${key}|`)),
    readRegistryValue: (key, name) => values.get(`${key}|${name}`) ?? null
  }));
  values.set(`${registryKeys('HKLM').install}|InstallLocation`, 'C:\\orphan');
  assert.throws(() => assertInstalledRegistration(phase, {
    expectedUninstallerPath: 'C:\\smoke\\currentuser\\app\\Uninstall Twitch VOD Manager.exe',
    keyExists: (key) => [...values.keys()].some((entry) => entry.startsWith(`${key}|`)),
    readRegistryValue: (key, name) => values.get(`${key}|${name}`) ?? null
  }), /opposite installation scope/i);
  values.delete(`${registryKeys('HKLM').install}|InstallLocation`);
  values.set(`${selected.uninstall}|UninstallString`, `"C:\\smoke\\currentuser\\app\\Uninstall Twitch VOD Manager.exe" ${phase.flag} /unexpected`);
  assert.throws(() => assertInstalledRegistration(phase, {
    expectedUninstallerPath: 'C:\\smoke\\currentuser\\app\\Uninstall Twitch VOD Manager.exe',
    keyExists: (key) => [...values.keys()].some((entry) => entry.startsWith(`${key}|`)),
    readRegistryValue: (key, name) => values.get(`${key}|${name}`) ?? null
  }), /uninstall command mismatch/i);
});

test('bundled electron-builder writes the selected install mode into both uninstall commands', () => {
  assert.match(builderMultiUserSource, /!macro setInstallModePerUser[\s\S]*?SetShellVarContext current/);
  assert.match(builderMultiUserSource, /!macro setInstallModePerAllUsers[\s\S]*?SetShellVarContext all/);
  assert.match(builderInstallerSource, /\$installMode == "all"[\s\S]*?StrCpy \$0 "\/allusers"[\s\S]*?StrCpy \$0 "\/currentuser"/);
  assert.match(builderInstallerSource, /WriteRegStr SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" UninstallString '"\$2" \$0'/);
  assert.match(builderInstallerSource, /WriteRegStr SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" QuietUninstallString '"\$2" \$0 \/S'/);
});

test('clean surface contract includes both registry hives and both shortcut scopes', () => {
  const phases = createInstallerPhases('C:\\smoke', {
    commonDesktop: 'C:\\shared-desktop',
    commonPrograms: 'C:\\shared-programs',
    currentDesktop: 'C:\\user-desktop',
    currentPrograms: 'C:\\user-programs'
  });
  assert.doesNotThrow(() => assertInstallerSurfaceClean(phases, {
    keyExists: () => false,
    pathExists: () => false
  }));
  assert.throws(() => assertInstallerSurfaceClean(phases, {
    keyExists: (key) => key === registryKeys('HKLM').uninstall,
    pathExists: (candidate) => candidate === phases[0].startMenuShortcut
  }), /HKLM.*Twitch VOD Manager\.lnk/i);
});

test('recursive cleanup is limited to the dedicated runner temp directory', () => {
  assert.doesNotThrow(() => assertPathInside('C:\\runner-temp\\tvm-installer-123', 'C:\\runner-temp'));
  assert.throws(() => assertPathInside('C:\\runner-temp', 'C:\\runner-temp'), /outside its parent/i);
  assert.throws(() => assertPathInside('C:\\other', 'C:\\runner-temp'), /outside its parent/i);
});

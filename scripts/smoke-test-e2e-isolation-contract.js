const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HELPER_FILE = path.join(__dirname, 'e2e-test-environment.js');
const SMOKE_FILES = [
  'scripts/smoke-test.js',
  'scripts/smoke-test-template-guide.js',
  'scripts/smoke-test-full.js',
  'scripts/smoke-test-settings-autosave.js',
  'scripts/smoke-test-workspace-ui.js'
];

function inspectSources() {
  const failures = [];

  if (!fs.existsSync(HELPER_FILE)) {
    failures.push('Missing scripts/e2e-test-environment.js');
  }

  for (const relativePath of SMOKE_FILES) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const requiredPatterns = [
      ["require('./e2e-test-environment')", 'shared isolation helper import'],
      ['createE2eEnvironment(', 'isolated test root creation'],
      ['getElectronLaunchOptions(', 'isolated Electron launch options'],
      ['verifyE2eIsolation(', 'runtime isolation verification'],
      ['installOfflineFixtures(', 'offline IPC fixtures'],
      ['cleanupE2eEnvironment(', 'guaranteed isolated root cleanup']
    ];

    for (const [pattern, label] of requiredPatterns) {
      if (!source.includes(pattern)) {
        failures.push(`${relativePath}: missing ${label}`);
      }
    }

    if (/process\.exit\s*\(/.test(source)) {
      failures.push(`${relativePath}: process.exit bypasses cleanup`);
    }

    if (/electron\.launch\s*\(\s*\{/.test(source)) {
      failures.push(`${relativePath}: raw electron.launch options bypass shared isolation`);
    }
  }

  const fullSource = fs.readFileSync(path.join(ROOT, 'scripts/smoke-test-full.js'), 'utf8');
  const forbiddenFullPatterns = [
    ['backupFile(', 'real-file backup path'],
    ['restoreFile(', 'real-file restore path'],
    ["path.join(process.cwd(), 'tmp_e2e_full')", 'project-local media path'],
    ["process.env.PROGRAMDATA || 'C:\\\\ProgramData'", 'ambient ProgramData path']
  ];

  for (const [pattern, label] of forbiddenFullPatterns) {
    if (fullSource.includes(pattern)) {
      failures.push(`scripts/smoke-test-full.js: contains ${label}`);
    }
  }

  return failures;
}

function inspectHelper() {
  if (!fs.existsSync(HELPER_FILE)) {
    return [];
  }

  const failures = [];
  const {
    createE2eEnvironment,
    getElectronLaunchOptions,
    cleanupE2eEnvironment
  } = require(HELPER_FILE);
  const environment = createE2eEnvironment('isolation-contract');

  try {
    const expectedDirectories = [
      environment.rootDir,
      environment.programDataDir,
      environment.userDataDir,
      environment.downloadsDir,
      environment.appDataDir
    ];

    for (const directory of expectedDirectories) {
      if (!fs.statSync(directory).isDirectory()) {
        failures.push(`Helper did not create directory: ${directory}`);
      }
    }

    const config = JSON.parse(fs.readFileSync(environment.configFile, 'utf8'));
    const queue = JSON.parse(fs.readFileSync(environment.queueFile, 'utf8'));
    const launch = getElectronLaunchOptions(environment);

    if (path.resolve(config.download_path) !== path.resolve(environment.downloadsDir)) {
      failures.push('Seed config download_path is outside the isolated downloads directory');
    }
    if (!Array.isArray(config.streamers) || config.streamers.length !== 0) {
      failures.push('Seed config contains streamers');
    }
    if (!Array.isArray(config.auto_record_streamers) || config.auto_record_streamers.length !== 0) {
      failures.push('Seed config enables auto recording');
    }
    if (!Array.isArray(config.auto_vod_download_streamers) || config.auto_vod_download_streamers.length !== 0) {
      failures.push('Seed config enables automatic VOD downloads');
    }
    if (config.auto_resume_queue_on_startup !== false || config.auto_resume_live_recording !== false) {
      failures.push('Seed config enables automatic resume behavior');
    }
    if (config.auto_cleanup_enabled !== false) {
      failures.push('Seed config enables automatic cleanup');
    }
    if (config.discord_webhook_url !== '') {
      failures.push('Seed config contains a webhook');
    }
    if (!Array.isArray(queue) || queue.length !== 0) {
      failures.push('Seed queue is not empty');
    }
    if (path.resolve(launch.env.PROGRAMDATA) !== path.resolve(environment.programDataDir)) {
      failures.push('Electron launch options do not isolate PROGRAMDATA');
    }
    if (launch.args[0] !== `--user-data-dir=${environment.userDataDir}` || launch.args.at(-1) !== '.') {
      failures.push('Electron launch options do not place the isolated userData switch before the app path');
    }
    if (!String(launch.args[1] || '').startsWith('--proxy-server=http://127.0.0.1:')) {
      failures.push('Electron launch options do not install the Chromium offline proxy guard');
    }
    if (launch.env.HTTP_PROXY !== launch.env.HTTPS_PROXY || launch.env.HTTP_PROXY !== launch.env.ALL_PROXY) {
      failures.push('Electron launch options do not install consistent Node proxy guards');
    }
    if (!String(launch.env.HTTP_PROXY || '').startsWith('http://127.0.0.1:')) {
      failures.push('Electron launch options do not route Node HTTP clients to an offline loopback proxy');
    }
    if (launch.env.NO_PROXY !== '') {
      failures.push('Electron launch options allow proxy bypasses');
    }
  } finally {
    cleanupE2eEnvironment(environment);
  }

  if (fs.existsSync(environment.rootDir)) {
    failures.push('Helper cleanup left the isolated root on disk');
  }

  return failures;
}

function run() {
  const failures = [...inspectSources(), ...inspectHelper()];
  const summary = {
    files: SMOKE_FILES,
    failures
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = failures.length === 0 ? 0 : 1;
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

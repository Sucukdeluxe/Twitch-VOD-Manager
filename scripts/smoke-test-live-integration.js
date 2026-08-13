const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn, spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const {
  PRODUCTION_RELEASE_DOWNLOAD_BASE,
  assertOwnedPath,
  buildStreamlinkArguments,
  compareVersions,
  parseGateMode,
  parseLatestYaml,
  readLiveConfiguration,
  redactDiagnostic,
  sanitizeChildEnvironment,
  validateDownloadedReleaseArtifact,
  validateMediaProbe,
  validateProductionRelease,
  validateTwitchToken,
  validateUpdateCacheRecord
} = require('./smoke-test-live-integration-contract');

const root = path.resolve(__dirname, '..');
const GITHUB_LATEST_API = 'https://api.github.com/repos/Sucukdeluxe/Twitch-VOD-Manager/releases/latest';
const GITHUB_COMMIT_API_BASE = 'https://api.github.com/repos/Sucukdeluxe/Twitch-VOD-Manager/commits';
const GITHUB_RELEASE_BASE = 'https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/download';
const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const MAX_SOURCE_INSTALLER_BYTES = 256 * 1024 * 1024;
const ELECTRON_CLOSE_TIMEOUT_MS = 15000;
const PACKAGED_VERSION_TIMEOUT_MS = 30000;
const UPDATE_CHECK_TIMEOUT_MS = 120000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 8 * 60 * 1000;

function createOwnedRoot(prefix) {
  const base = process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP)
    ? process.env.RUNNER_TEMP
    : os.tmpdir();
  if (!fs.statSync(base).isDirectory()) throw new Error(`Temporary base directory is unavailable: ${base}`);
  const ownedRoot = fs.mkdtempSync(path.join(base, prefix));
  assertOwnedPath(ownedRoot, base);
  return { base, ownedRoot };
}

async function removeOwnedRoot(ownedRoot, base) {
  assertOwnedPath(ownedRoot, base);
  await fs.promises.rm(ownedRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}

async function runWithOwnedRoot(prefix, operation) {
  const context = createOwnedRoot(prefix);
  try {
    return await operation(context);
  } finally {
    await removeOwnedRoot(context.ownedRoot, context.base);
  }
}

async function runBoundedOperation(label, timeoutMs, operation) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`${label} timeout must be a positive integer`);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  return await fetch(url, { ...options, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
}

async function readBoundedText(response, maximumBytes = 256 * 1024) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximumBytes) throw new Error(`HTTP response exceeded ${maximumBytes} bytes`);
  if (!response.body) return '';
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes) throw new Error(`HTTP response exceeded ${maximumBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await readBoundedText(response);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${new URL(url).hostname}`);
  }
}

function loadBuiltTwitchProduct() {
  const product = require(path.join(root, 'dist', 'main', 'twitch'));
  const requiredExports = [
    'TwitchAppTokenService',
    'createTwitchProviderRefreshService',
    'requestPublicTwitchVodsByLogin',
    'requestTwitchAppAccessToken',
    'requestTwitchHelixUsers',
    'requestTwitchHelixVideos'
  ];
  if (requiredExports.some((name) => typeof product[name] !== 'function')) {
    throw new Error('Built Twitch product paths are unavailable; run npm run build first');
  }
  return product;
}

async function requestProductTwitchToken(credentials, requestJson = fetchJson) {
  const product = loadBuiltTwitchProduct();
  let tokenPayload;
  const client = {
    async post(url, data, config) {
      if (data !== null || !config || typeof config.timeout !== 'number') throw new Error('Built Twitch token request contract was invalid');
      const requestUrl = new URL(url);
      for (const [name, value] of Object.entries(config.params || {})) requestUrl.searchParams.set(name, String(value));
      tokenPayload = await requestJson(requestUrl, { method: 'POST' }, config.timeout);
      return { data: tokenPayload };
    }
  };
  const service = new product.TwitchAppTokenService(
    (requestCredentials) => product.requestTwitchAppAccessToken(client, requestCredentials, 30000)
  );
  const accessToken = await service.ensure(credentials);
  if (!accessToken) throw new Error('Built Twitch token product path rejected the provider response');
  return { accessToken, tokenPayload };
}

function createProductTwitchHttpClient(requestJson = fetchJson) {
  return {
    async get(url, config) {
      const requestUrl = new URL(url);
      for (const [name, value] of Object.entries(config.params || {})) requestUrl.searchParams.set(name, String(value));
      return { data: await requestJson(requestUrl, { headers: config.headers }, config.timeout) };
    },
    async post(url, body, config) {
      return {
        data: await requestJson(url, {
          body: JSON.stringify(body),
          headers: config.headers,
          method: 'POST'
        }, config.timeout)
      };
    }
  };
}

async function verifyProductTwitchProviderFallbacks(configuration, accessToken, client = createProductTwitchHttpClient()) {
  const product = loadBuiltTwitchProduct();
  const auth = { accessToken, clientId: configuration.clientId };
  const usersOutcome = await product.requestTwitchHelixUsers(client, configuration.login, auth, 30000);
  if (usersOutcome.status !== 'success') throw new Error(`Built Twitch Helix user path returned ${usersOutcome.status}`);
  const user = usersOutcome.value.find((entry) => entry.login.toLowerCase() === configuration.login);
  if (!user) throw new Error('Built Twitch Helix user path did not bind the requested login');

  let phase = 'public';
  const service = product.createTwitchProviderRefreshService({
    maxLastGoodEntries: 1,
    refreshToken: async () => false,
    requestHelix: async () => phase === 'helix'
      ? await product.requestTwitchHelixVideos(client, user.id, auth, 30000, 50)
      : { status: 'unavailable' },
    requestPublic: async () => phase === 'public'
      ? await product.requestPublicTwitchVodsByLogin(client, configuration.login, 100, 30000, 3)
      : { status: 'unavailable' }
  });
  const key = `vod:${configuration.vodId}`;
  const publicRefresh = await service.refresh(key);
  if (publicRefresh.source !== 'public') throw new Error(`Built Twitch public GQL path returned ${publicRefresh.source}`);
  const publicVod = publicRefresh.value?.find((entry) => entry.id === configuration.vodId);
  if (!publicVod || String(publicVod.user_login || '').toLowerCase() !== configuration.login) {
    throw new Error('Built Twitch public GQL path did not bind the requested VOD to the broadcaster');
  }
  phase = 'helix';
  const helixRefresh = await service.refresh(key);
  if (helixRefresh.source !== 'helix') throw new Error(`Built Twitch Helix video path returned ${helixRefresh.source}`);
  const helixVod = helixRefresh.value?.find((entry) => entry.id === configuration.vodId);
  if (!helixVod || String(helixVod.user_login || '').toLowerCase() !== configuration.login) {
    throw new Error('Built Twitch Helix video path did not bind the requested VOD to the broadcaster');
  }
  phase = 'offline';
  const lastGoodRefresh = await service.refresh(key);
  if (lastGoodRefresh.source !== 'last-good' || !lastGoodRefresh.stale || lastGoodRefresh.value !== helixRefresh.value) {
    throw new Error('Built Twitch provider service did not restore last-good data while both providers were unavailable');
  }
  return {
    helix: {
      duration: helixVod.duration,
      source: helixRefresh.source,
      userId: user.id,
      vodId: helixVod.id
    },
    lastGood: {
      restoredFrom: 'helix',
      restoredVodId: helixVod.id,
      source: lastGoodRefresh.source,
      stale: lastGoodRefresh.stale
    },
    public: {
      duration: publicVod.duration,
      login: publicVod.user_login,
      source: publicRefresh.source,
      vodId: publicVod.id
    }
  };
}

function assertTrustedDownloadResponse(response) {
  const finalUrl = new URL(response.url);
  const allowedHost = finalUrl.hostname === 'github.com'
    || finalUrl.hostname.endsWith('.githubusercontent.com');
  if (finalUrl.protocol !== 'https:' || !allowedHost) throw new Error(`Release download redirected to an untrusted host: ${finalUrl.hostname}`);
}

async function downloadFile(url, destinationPath, maximumBytes) {
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'Twitch-VOD-Manager-Live-Integration-Gate'
    }
  }, 240000);
  if (!response.ok || !response.body) throw new Error(`Release download failed with HTTP ${response.status}`);
  assertTrustedDownloadResponse(response);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new Error(`Release download exceeded ${maximumBytes} bytes`);
  const partialPath = `${destinationPath}.partial`;
  let downloadedBytes = 0;
  const digest = nodeCrypto.createHash('sha256');
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length;
      if (downloadedBytes > maximumBytes) {
        callback(new Error(`Release download exceeded ${maximumBytes} bytes`));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(partialPath, { flags: 'wx' }));
    fs.renameSync(partialPath, destinationPath);
    return { bytes: downloadedBytes, sha256: digest.digest('hex') };
  } finally {
    fs.rmSync(partialPath, { force: true });
  }
}

function runProcess(command, argumentsList, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: options.cwd,
      env: options.env || sanitizeChildEnvironment(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const capture = (current, chunk) => `${current}${chunk}`.slice(-65536);
    child.stdout?.on('data', (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = capture(stderr, chunk); });
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      terminateProcessTree(child);
      reject(new Error(`${options.label || path.basename(command)} timed out`));
    }, options.timeoutMs || 120000);
    child.once('error', (error) => {
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${options.label || path.basename(command)} failed: ${JSON.stringify({ code, signal, stderr: stderr.trim(), stdout: stdout.trim() })}`));
        return;
      }
      resolve({ code, stderr: stderr.trim(), stdout: stdout.trim() });
    });
  });
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      env: sanitizeChildEnvironment(process.env),
      stdio: 'ignore',
      windowsHide: true
    });
    return;
  }
  child.kill('SIGKILL');
}

function findExecutable(explicitPath, commandName) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${commandName} executable is not a file: ${resolved}`);
    return resolved;
  }
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const located = spawnSync(locator, [commandName], {
    encoding: 'utf8',
    env: sanitizeChildEnvironment(process.env),
    windowsHide: true
  });
  if (located.status !== 0) throw new Error(`${commandName} is unavailable; set its TWITCH_VOD_MANAGER_LIVE_*_PATH variable`);
  const candidate = String(located.stdout || '').split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
  if (!candidate || !fs.statSync(candidate).isFile()) throw new Error(`${commandName} could not be resolved to a regular file`);
  return candidate;
}

async function runTwitchGate(configuration) {
  return await runWithOwnedRoot('tvm-live-twitch-', async ({ ownedRoot }) => {
    let accessToken = '';
    try {
      const toolProfile = path.join(ownedRoot, 'profile');
      const toolEnvironment = sanitizeChildEnvironment(process.env, {
        APPDATA: path.join(toolProfile, 'appdata'),
        LOCALAPPDATA: path.join(toolProfile, 'localappdata'),
        TEMP: path.join(toolProfile, 'temp'),
        TMP: path.join(toolProfile, 'temp'),
        USERPROFILE: toolProfile
      });
      for (const directory of [toolEnvironment.APPDATA, toolEnvironment.LOCALAPPDATA, toolEnvironment.TEMP, toolEnvironment.USERPROFILE]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      const streamlinkPath = findExecutable(configuration.streamlinkPath, process.platform === 'win32' ? 'streamlink.exe' : 'streamlink');
      const ffprobePath = findExecutable(configuration.ffprobePath, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      const streamlinkVersion = await runProcess(streamlinkPath, ['--version'], { env: toolEnvironment, label: 'Streamlink version check', timeoutMs: 30000 });
      const ffprobeVersion = await runProcess(ffprobePath, ['-version'], { env: toolEnvironment, label: 'ffprobe version check', timeoutMs: 30000 });

      const productToken = await requestProductTwitchToken({
        clientId: configuration.clientId,
        clientSecret: configuration.clientSecret
      });
      accessToken = productToken.accessToken;
      const validationPayload = await fetchJson(TWITCH_VALIDATE_URL, {
        headers: { Authorization: `OAuth ${accessToken}` }
      });
      const token = validateTwitchToken(productToken.tokenPayload, validationPayload, configuration.clientId);
      const providers = await verifyProductTwitchProviderFallbacks(configuration, accessToken);

      const samplePath = path.join(ownedRoot, `vod-${configuration.vodId}-sample.ts`);
      const streamlinkArguments = buildStreamlinkArguments(configuration.vodId, samplePath, 8);
      await runProcess(streamlinkPath, streamlinkArguments, { env: toolEnvironment, label: 'Bounded Streamlink VOD download', timeoutMs: 120000 });
      const stat = fs.statSync(samplePath);
      const probe = await runProcess(ffprobePath, [
        '-v',
        'error',
        '-show_entries',
        'format=duration,size',
        '-show_entries',
        'stream=codec_type,codec_name',
        '-of',
        'json',
        samplePath
      ], { env: toolEnvironment, label: 'ffprobe sample validation', timeoutMs: 30000 });
      const media = validateMediaProbe(JSON.parse(probe.stdout), stat.size);

      return {
        helix: providers.helix,
        lastGood: providers.lastGood,
        oauth: { expiresInSeconds: token.expiresInSeconds, validated: true },
        public: providers.public,
        streamlink: {
          bytes: media.bytes,
          codec: media.codec,
          durationSeconds: media.durationSeconds,
          ffprobeVersion: ffprobeVersion.stdout.split(/\r?\n/, 1)[0],
          streamlinkVersion: streamlinkVersion.stdout.split(/\r?\n/, 1)[0]
        }
      };
    } catch (error) {
      throw new Error(redactDiagnostic(error, [configuration.clientId, configuration.clientSecret, accessToken]), { cause: error });
    }
  });
}

function findFileRecursive(directory, fileName) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return entryPath;
    if (entry.isDirectory()) {
      const nested = findFileRecursive(entryPath, fileName);
      if (nested) return nested;
    }
  }
  return '';
}

async function prepareSourcePackagedApp(configuration, ownedRoot) {
  if (configuration.packagedAppPath) {
    const executablePath = path.resolve(configuration.packagedAppPath);
    if (!fs.statSync(executablePath).isFile()) throw new Error(`Packaged source executable is not a file: ${executablePath}`);
    return { executablePath, sourceInstallerVerified: false };
  }

  const sourceTag = `v${configuration.sourceVersion}`;
  const installerName = `Twitch-VOD-Manager-Setup-${configuration.sourceVersion}.exe`;
  const installerUrl = `${GITHUB_RELEASE_BASE}/${sourceTag}/${installerName}`;
  const installerPath = path.join(ownedRoot, installerName);
  const downloaded = await downloadFile(installerUrl, installerPath, MAX_SOURCE_INSTALLER_BYTES);
  if (downloaded.sha256 !== configuration.sourceSha256) throw new Error('Public source installer SHA-256 did not match the pinned digest');

  const sevenZipPath = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe');
  if (!fs.existsSync(sevenZipPath)) throw new Error('Bundled 7z extractor is unavailable; run npm ci first');
  const installerExtraction = path.join(ownedRoot, 'source-installer');
  const appExtraction = path.join(ownedRoot, 'source-app');
  fs.mkdirSync(installerExtraction);
  fs.mkdirSync(appExtraction);
  await runProcess(sevenZipPath, ['x', '-y', `-o${installerExtraction}`, installerPath, '$PLUGINSDIR\\app-64.7z'], {
    label: 'Source installer extraction',
    timeoutMs: 120000
  });
  const appArchivePath = findFileRecursive(installerExtraction, 'app-64.7z');
  if (!appArchivePath) throw new Error('Public source installer did not contain app-64.7z');
  assertOwnedPath(appArchivePath, ownedRoot);
  await runProcess(sevenZipPath, ['x', '-y', `-o${appExtraction}`, appArchivePath], {
    label: 'Packaged source app extraction',
    timeoutMs: 120000
  });
  const executablePath = findFileRecursive(appExtraction, 'Twitch VOD Manager.exe');
  if (!executablePath) throw new Error('Extracted public source app did not contain Twitch VOD Manager.exe');
  assertOwnedPath(executablePath, ownedRoot);
  return { executablePath, sourceInstallerVerified: true };
}

async function requestProductionLatestYaml(url) {
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Twitch-VOD-Manager-Live-Integration-Gate' }
  });
  if (!response.ok) throw new Error(`Production latest.yml failed with HTTP ${response.status}`);
  assertTrustedDownloadResponse(response);
  return await readBoundedText(response, 128 * 1024);
}

async function inspectProductionRelease(configuration, dependencies = {}) {
  const requestJson = dependencies.requestJson || fetchJson;
  const requestLatestYaml = dependencies.requestLatestYaml || requestProductionLatestYaml;
  const latest = await requestJson(GITHUB_LATEST_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Twitch-VOD-Manager-Live-Integration-Gate'
    }
  });
  const expectedTag = `v${configuration.expectedVersion}`;
  if (latest?.tag_name !== expectedTag || latest?.draft === true || latest?.prerelease === true) {
    throw new Error(`GitHub latest release was not the pinned public ${expectedTag}`);
  }
  const commit = await requestJson(`${GITHUB_COMMIT_API_BASE}/${encodeURIComponent(expectedTag)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Twitch-VOD-Manager-Live-Integration-Gate'
    }
  });
  const commitSha = typeof commit?.sha === 'string' ? commit.sha.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{40}$/.test(commitSha) || commitSha !== configuration.expectedCommitSha) {
    throw new Error('Public release tag commit did not match the pinned workflow commit');
  }
  const feedUrl = `${PRODUCTION_RELEASE_DOWNLOAD_BASE}/${expectedTag}/latest.yml`;
  const metadata = parseLatestYaml(await requestLatestYaml(feedUrl));
  const release = validateProductionRelease(metadata, {
    expectedSha512: configuration.expectedSha512,
    expectedVersion: configuration.expectedVersion,
    latestTag: expectedTag
  });
  const assets = Array.isArray(latest.assets) ? latest.assets : [];
  const installerAsset = assets.find((asset) => asset?.name === release.artifactName);
  const feedAsset = assets.find((asset) => asset?.name === 'latest.yml');
  if (!installerAsset || installerAsset.size !== release.artifactSize || !feedAsset) {
    throw new Error('GitHub latest release assets did not match latest.yml');
  }
  return { ...release, commitSha };
}

function createUpdaterEnvironment(ownedRoot) {
  const directories = {
    appData: path.join(ownedRoot, 'appdata'),
    localAppData: path.join(ownedRoot, 'localappdata'),
    programData: path.join(ownedRoot, 'programdata'),
    temp: path.join(ownedRoot, 'temp'),
    userData: path.join(ownedRoot, 'userdata'),
    userProfile: path.join(ownedRoot, 'profile')
  };
  for (const directory of [...Object.values(directories), path.join(directories.userProfile, 'Desktop')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const environment = sanitizeChildEnvironment(process.env, {
    APPDATA: directories.appData,
    LOCALAPPDATA: directories.localAppData,
    PROGRAMDATA: directories.programData,
    TEMP: directories.temp,
    TMP: directories.temp,
    USERPROFILE: directories.userProfile
  });
  return { directories, environment };
}

async function waitForHardExit(child, timeoutMs = 15000) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Packaged app did not exit after forced termination'));
    }, timeoutMs);
    child.once('exit', finish);
    if (child.exitCode !== null) finish();
  });
}

async function closeElectronApp(electronApp, electronProcess, options = {}) {
  if (!electronProcess || electronProcess.exitCode !== null) return;
  const timeoutMs = options.timeoutMs || ELECTRON_CLOSE_TIMEOUT_MS;
  const terminate = options.terminate || terminateProcessTree;
  const waitForExit = options.waitForExit || waitForHardExit;
  if (electronApp) {
    try {
      await runBoundedOperation('Packaged app close', timeoutMs, async () => await electronApp.close());
    } catch {}
  }
  if (electronProcess.exitCode === null) {
    terminate(electronProcess);
    await waitForExit(electronProcess, timeoutMs);
  }
}

async function runWithElectronAppCleanup(lifecycle, operation, closeOptions = {}) {
  try {
    return await operation();
  } finally {
    await closeElectronApp(lifecycle.electronApp, lifecycle.electronProcess, closeOptions);
  }
}

async function startUpdaterDownload(window) {
  await window.locator('#workspaceUpdateButton').hover();
  const downloadButton = window.locator('#updateButton');
  await downloadButton.waitFor({ state: 'visible' });
  await downloadButton.click();
}

async function getPackagedVersion(window, timeoutMs = PACKAGED_VERSION_TIMEOUT_MS) {
  return await runBoundedOperation(
    'Packaged app version query',
    timeoutMs,
    async () => await window.evaluate(() => window.api.getVersion())
  );
}

async function checkPackagedUpdate(window, timeoutMs = UPDATE_CHECK_TIMEOUT_MS) {
  return await runBoundedOperation(
    'Packaged app update check',
    timeoutMs,
    async () => await window.evaluate(() => window.api.checkUpdate())
  );
}

function createUpdaterDownloadReadySummary({ artifact, downloadedVersion, progressEvents, release, source, sourceVersion }) {
  return {
    artifact: {
      bytes: artifact.bytes,
      name: release.artifactName,
      sha512Verified: artifact.sha512Verified
    },
    feed: release.feedUrl,
    scope: 'download-ready',
    source: {
      installerDigestVerified: source.sourceInstallerVerified,
      version: sourceVersion
    },
    target: {
      commitSha: release.commitSha,
      downloadReady: true,
      progressEvents,
      version: downloadedVersion
    }
  };
}

async function runUpdaterGate(configuration) {
  if (process.platform !== 'win32') throw new Error('The packaged updater live gate requires Windows');
  return await runWithOwnedRoot('tvm-live-updater-', async ({ ownedRoot }) => {
    const lifecycle = { electronApp: null, electronProcess: null };
    return await runWithElectronAppCleanup(lifecycle, async () => {
      const release = await inspectProductionRelease(configuration);
      const source = await prepareSourcePackagedApp(configuration, ownedRoot);
      const { directories, environment } = createUpdaterEnvironment(ownedRoot);
      lifecycle.electronApp = await electron.launch({
        executablePath: source.executablePath,
        args: [`--user-data-dir=${directories.userData}`],
        env: environment,
        timeout: 60000
      });
      lifecycle.electronProcess = lifecycle.electronApp.process();
      const window = await lifecycle.electronApp.firstWindow({ timeout: 60000 });
      await window.waitForFunction(() => Boolean(window.api && document.getElementById('updateBanner')), null, { timeout: 60000 });
      await window.evaluate(() => {
        window.__tvmLiveUpdaterGate = {
          available: null,
          downloaded: null,
          errors: [],
          maximumProgress: 0,
          progressEvents: 0
        };
        window.api.onUpdateAvailable((info) => { window.__tvmLiveUpdaterGate.available = info; });
        window.api.onUpdateDownloaded((info) => { window.__tvmLiveUpdaterGate.downloaded = info; });
        window.api.onUpdateDownloadProgress((progress) => {
          window.__tvmLiveUpdaterGate.progressEvents += 1;
          window.__tvmLiveUpdaterGate.maximumProgress = Math.max(window.__tvmLiveUpdaterGate.maximumProgress, Number(progress.percent) || 0);
        });
        window.api.onUpdateError((error) => { window.__tvmLiveUpdaterGate.errors.push(String(error?.message || 'update-error')); });
      });
      const sourceVersion = await getPackagedVersion(window);
      if (sourceVersion !== configuration.sourceVersion || compareVersions(sourceVersion, configuration.expectedVersion) >= 0) {
        throw new Error(`Packaged source app version ${sourceVersion} was not the pinned older ${configuration.sourceVersion}`);
      }

      const checkResult = await checkPackagedUpdate(window);
      if (!checkResult || checkResult.error) throw new Error('Packaged app rejected the production update check');
      await window.waitForFunction((version) => {
        const state = window.__tvmLiveUpdaterGate;
        return state.errors.length > 0 || state.available?.version === version;
      }, configuration.expectedVersion, { timeout: 120000 });
      let state = await window.evaluate(() => ({
        events: window.__tvmLiveUpdaterGate,
        ui: document.getElementById('updateBanner')?.dataset.updateState
      }));
      if (state.events.errors.length > 0) throw new Error(`Packaged updater emitted an error before download: ${state.events.errors.join('; ')}`);
      if (state.ui !== 'available') throw new Error(`Packaged updater UI did not reach available state: ${state.ui || 'missing'}`);

      await startUpdaterDownload(window);
      await window.waitForFunction((version) => {
        const state = window.__tvmLiveUpdaterGate;
        const uiState = document.getElementById('updateBanner')?.dataset.updateState;
        return state.errors.length > 0 || (state.downloaded?.version === version && uiState === 'ready');
      }, configuration.expectedVersion, { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS });
      state = await window.evaluate(() => ({
        events: window.__tvmLiveUpdaterGate,
        installButtonDisabled: document.getElementById('updateButton')?.disabled,
        progressValue: document.getElementById('updateProgressGauge')?.getAttribute('aria-valuenow'),
        ui: document.getElementById('updateBanner')?.dataset.updateState
      }));
      if (state.events.errors.length > 0) throw new Error(`Packaged updater emitted an error during download: ${state.events.errors.join('; ')}`);
      if (state.ui !== 'ready' || state.progressValue !== '100' || state.installButtonDisabled !== false) {
        throw new Error(`Packaged updater UI did not reach install-ready state: ${JSON.stringify({ disabled: state.installButtonDisabled, progress: state.progressValue, ui: state.ui })}`);
      }
      if (state.events.progressEvents < 1 || state.events.maximumProgress <= 0) {
        throw new Error('Packaged updater did not emit real download progress from the isolated cache');
      }

      const pendingDirectory = path.join(directories.localAppData, 'twitch-vod-manager-updater', 'pending');
      assertOwnedPath(pendingDirectory, ownedRoot);
      const updateInfoPath = path.join(pendingDirectory, 'update-info.json');
      const updateInfo = JSON.parse(fs.readFileSync(updateInfoPath, 'utf8'));
      const cacheRecord = validateUpdateCacheRecord(updateInfo, {
        artifactName: release.artifactName,
        expectedSha512: configuration.expectedSha512
      });
      const artifactPath = path.join(pendingDirectory, cacheRecord.fileName);
      assertOwnedPath(artifactPath, ownedRoot);
      const artifact = await validateDownloadedReleaseArtifact(artifactPath, {
        artifactName: release.artifactName,
        artifactSize: release.artifactSize,
        expectedSha512: configuration.expectedSha512
      });

      return createUpdaterDownloadReadySummary({
        artifact,
        downloadedVersion: state.events.downloaded.version,
        progressEvents: state.events.progressEvents,
        release,
        source,
        sourceVersion
      });
    });
  });
}

async function main() {
  const mode = parseGateMode(process.argv.slice(2));
  const configuration = readLiveConfiguration(mode);
  const summary = { mode, updater: null, twitch: null };
  if (mode === 'all' || mode === 'twitch') summary.twitch = await runTwitchGate(configuration.twitch);
  if (mode === 'all' || mode === 'updater') summary.updater = await runUpdaterGate(configuration.updater);
  console.log(JSON.stringify({ failures: [], summary }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    const secrets = Object.entries(process.env)
      .filter(([name]) => name.startsWith('TWITCH_VOD_MANAGER_LIVE_') && /CLIENT_ID|SECRET|TOKEN/i.test(name))
      .map(([, value]) => value);
    console.error(redactDiagnostic(error, secrets));
    process.exitCode = 1;
  });
}

module.exports = {
  checkPackagedUpdate,
  closeElectronApp,
  createUpdaterEnvironment,
  createUpdaterDownloadReadySummary,
  downloadFile,
  findExecutable,
  getPackagedVersion,
  inspectProductionRelease,
  prepareSourcePackagedApp,
  requestProductTwitchToken,
  runWithElectronAppCleanup,
  runWithOwnedRoot,
  runTwitchGate,
  runUpdaterGate,
  startUpdaterDownload,
  verifyProductTwitchProviderFallbacks
};

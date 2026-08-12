const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  createE2eEnvironment,
  getElectronLaunchOptions,
  verifyE2eIsolation,
  installOfflineFixtures,
  cleanupE2eEnvironment
} = require('./e2e-test-environment');

function findFileRecursive(rootDir, fileName) {
  if (!fs.existsSync(rootDir)) return null;

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return fullPath;
    }

    if (entry.isDirectory()) {
      const nested = findFileRecursive(fullPath, fileName);
      if (nested) return nested;
    }
  }

  return null;
}

function resolveFfmpegBinary(environment) {
  const direct = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
  if (direct.status === 0) return 'ffmpeg';

  const bundledRoot = path.join(environment.appDataDir, 'tools', 'ffmpeg');
  const bundled = findFileRecursive(bundledRoot, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (bundled) return bundled;

  throw new Error('ffmpeg not found. Install ffmpeg or run app preflight auto-fix first.');
}

function runFfmpeg(ffmpegPath, args) {
  const res = spawnSync(ffmpegPath, args, { windowsHide: true, stdio: 'pipe' });
  if (res.status !== 0) {
    const stderr = (res.stderr || Buffer.from('')).toString('utf-8').slice(0, 800);
    throw new Error(`ffmpeg failed: ${stderr || `exit ${res.status}`}`);
  }
}

function ensureTestMedia(environment) {
  const mediaA = path.join(environment.mediaDir, 'in_a.mp4');
  const mediaB = path.join(environment.mediaDir, 'in_b.mp4');
  const ffmpeg = resolveFfmpegBinary(environment);

  runFfmpeg(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=640x360:rate=30',
    '-t', '4',
    '-pix_fmt', 'yuv420p',
    mediaA
  ]);

  runFfmpeg(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=640x360:rate=30',
    '-t', '3',
    '-pix_fmt', 'yuv420p',
    mediaB
  ]);

  return { mediaA, mediaB };
}

async function run() {
  const environment = createE2eEnvironment('full');
  let app = null;
  try {
    const { mediaA, mediaB } = ensureTestMedia(environment);

    app = await electron.launch(getElectronLaunchOptions(environment));

    const win = await app.firstWindow();
    const isolation = await verifyE2eIsolation(app, win, environment);
    const fixtures = await installOfflineFixtures(app);
    const issues = [];
    const mergedOutputFile = path.join(environment.mediaDir, 'merged_full.mp4');
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false,
        filePaths: options?.properties?.includes('multiSelections') ? [files.mediaA, files.mediaB] : [files.mediaA]
      });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: files.mergedOutputFile });
    }, { mediaA, mediaB, mergedOutputFile });

    win.on('pageerror', (err) => {
      issues.push(`pageerror: ${String(err)}`);
    });

    win.on('console', (msg) => {
      if (msg.type() === 'error') {
        issues.push(`console.error: ${msg.text()}`);
      }
    });

    await win.waitForTimeout(2200);

    const summary = await win.evaluate(async () => {
      const failures = [];
      const checks = {};

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const assert = (condition, message) => {
        if (!condition) failures.push(message);
      };

      const waitFor = async (predicate, timeoutMs = 15000, intervalMs = 250) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (predicate()) return true;
          await sleep(intervalMs);
        }
        return false;
      };

      const clearQueue = async () => {
        const q = await window.api.getQueue();
        for (const item of q) {
          await window.api.removeFromQueue(item.id);
        }
      };

      const initialConfig = await window.api.getConfig();

      try {
        await clearQueue();

        const requiredGlobals = [
          'showTab',
          'addStreamer',
          'refreshVODs',
          'downloadClip',
          'saveSettings',
          'runPreflight',
          'refreshDebugLog',
          'toggleDebugAutoRefresh',
          'retryFailedDownloads',
          'toggleDownload'
        ];

        const missingGlobals = requiredGlobals.filter((name) => typeof window[name] !== 'function');
        checks.globals = { missingGlobals };
        assert(missingGlobals.length === 0, `Missing globals: ${missingGlobals.join(', ')}`);

        const tabs = ['vods', 'clips', 'cutter', 'merge', 'settings'];
        const tabChecks = {};
        for (const tab of tabs) {
          window.showTab(tab);
          tabChecks[tab] = document.querySelector('.tab-content.active')?.id === `${tab}Tab`;
        }
        checks.tabs = tabChecks;
        assert(Object.values(tabChecks).every(Boolean), 'Tab switching failed for at least one tab');

        window.showTab('settings');
        const preflight = await window.api.runPreflight(false);
        await window.runPreflight(false);
        await window.refreshDebugLog();
        checks.preflight = {
          ok: preflight.ok,
          checks: preflight.checks,
          panelText: (document.getElementById('preflightResult')?.textContent || '').slice(0, 180),
          healthBadge: (document.getElementById('healthBadge')?.textContent || '').trim()
        };
        assert(Boolean(checks.preflight.panelText), 'Preflight panel is empty');
        assert(Boolean(checks.preflight.healthBadge), 'Health badge is empty');

        const lang = document.getElementById('languageSelect');
        lang.value = 'de';
        lang.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(160);
        const deState = {
          nav: (document.getElementById('navSettingsText')?.textContent || '').trim(),
          retry: (document.getElementById('btnRetryFailed')?.textContent || '').trim(),
          deText: (document.getElementById('languageDeText')?.textContent || '').trim(),
          deIcon: !!document.querySelector('#langOptionDe .flag-icon.flag-de'),
          deActive: !!document.getElementById('langOptionDe')?.classList.contains('active')
        };

        lang.value = 'en';
        lang.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(160);
        const enState = {
          nav: (document.getElementById('navSettingsText')?.textContent || '').trim(),
          retry: (document.getElementById('btnRetryFailed')?.textContent || '').trim(),
          enText: (document.getElementById('languageEnText')?.textContent || '').trim(),
          enIcon: !!document.querySelector('#langOptionEn .flag-icon.flag-en'),
          enIconTag: document.querySelector('#langOptionEn .flag-icon.flag-en')?.tagName || '',
          enIconOpacity: getComputedStyle(document.querySelector('#langOptionEn .flag-icon.flag-en')).opacity,
          enIconSize: document.querySelector('#langOptionEn .flag-icon.flag-en')?.getBoundingClientRect().toJSON() || null,
          enActive: !!document.getElementById('langOptionEn')?.classList.contains('active')
        };

        checks.language = { deState, enState };
        assert(deState.nav.includes('Einstellungen'), 'German language switch failed');
        assert(enState.nav.includes('Settings'), 'English language switch failed');
        assert(deState.deIcon, 'German flag icon missing');
        assert(enState.enIcon, 'English flag icon missing');
        assert(enState.enIconTag === 'svg', 'English flag must use crisp vector geometry');
        assert(enState.enIconOpacity === '1', 'English flag must render fully opaque');
        assert(enState.enIconSize?.width === 18 && enState.enIconSize?.height === 12, 'English flag must render at 18x12 pixels');
        assert(deState.deActive, 'German language button did not activate');
        assert(enState.enActive, 'English language button did not activate');

        await window.api.saveConfig({ client_id: '' });
        window.showTab('vods');
        await window.selectStreamer('fixture_streamer');

        await waitFor(() => document.querySelectorAll('.vod-card').length > 0, 18000, 300);
        const vodCards = document.querySelectorAll('.vod-card').length;
        checks.vods = {
          cards: vodCards,
          status: (document.getElementById('statusText')?.textContent || '').trim()
        };
        assert(vodCards > 0, 'No VOD cards loaded');

        if (vodCards > 0) {
          document.querySelector('.vod-card .vod-btn.primary')?.click();
          await sleep(350);
        }

        const queueAfterUiAdd = Number(document.getElementById('queueCount')?.textContent || '0');
        checks.queueBasic = { queueAfterUiAdd };
        assert(queueAfterUiAdd >= 1, 'Queue did not increase after VOD add button');

        await clearQueue();

        await window.api.saveConfig({ prevent_duplicate_downloads: true });
        await window.api.addToQueue({
          url: 'https://www.twitch.tv/videos/999999999999999',
          title: '__E2E_FULL__dup',
          date: '2026-02-01T00:00:00Z',
          streamer: 'fixture_streamer',
          duration_str: '1h0m0s'
        });
        await window.api.addToQueue({
          url: 'https://www.twitch.tv/videos/999999999999999',
          title: '__E2E_FULL__dup',
          date: '2026-02-01T00:00:00Z',
          streamer: 'fixture_streamer',
          duration_str: '1h0m0s'
        });
        let q = await window.api.getQueue();
        const duplicateCount = q.filter((item) => item.title === '__E2E_FULL__dup').length;
        checks.duplicatePrevention = { duplicateCount };
        assert(duplicateCount === 1, 'Duplicate prevention did not block second queue add');
        await clearQueue();

        const runtimeMetrics = await window.api.getRuntimeMetrics();
        checks.runtimeMetrics = {
          hasQueue: !!runtimeMetrics?.queue,
          hasCache: !!runtimeMetrics?.caches,
          hasConfig: !!runtimeMetrics?.config,
          mode: runtimeMetrics?.config?.performanceMode || 'unknown'
        };
        assert(Boolean(checks.runtimeMetrics.hasQueue && checks.runtimeMetrics.hasCache && checks.runtimeMetrics.hasConfig), 'Runtime metrics snapshot missing expected sections');

        window.showTab('clips');
        const clipUrl = document.getElementById('clipUrl');
        clipUrl.value = '';
        await window.downloadClip();
        const clipEmptyStatus = (document.getElementById('clipStatus')?.textContent || '').trim();
        assert(clipEmptyStatus.includes('Please enter a URL') || clipEmptyStatus.includes('Bitte URL eingeben'), 'Empty clip URL validation failed');

        clipUrl.value = 'invalid-url';
        await window.downloadClip();
        const clipInvalidStatus = (document.getElementById('clipStatus')?.textContent || '').trim();
        assert(clipInvalidStatus.includes('Invalid clip URL') || clipInvalidStatus.includes('Ungueltige Clip-URL'), 'Invalid clip URL localization failed');

        window.openClipDialog('https://www.twitch.tv/videos/999999999999999', '__E2E_FULL__clip', '2026-02-01T00:00:00Z', 'fixture_streamer', '1h0m0s');
        document.getElementById('clipStartTime').value = '00:00:10';
        document.getElementById('clipEndTime').value = '00:00:22';
        window.updateFromInput('start');
        window.updateFromInput('end');
        await window.confirmClipDialog();
        q = await window.api.getQueue();
        const clipItem = q.find((item) => item.title === '__E2E_FULL__clip');
        checks.clipQueue = { queued: !!clipItem, duration: clipItem?.customClip?.durationSec || 0 };
        assert(Boolean(clipItem && clipItem.customClip && clipItem.customClip.durationSec === 12), 'Clip dialog queue entry invalid');

        await clearQueue();

        await window.api.addToQueue({
          url: 'https://www.twitch.tv/videos/999999999999999',
          title: '__E2E_FULL__orderA',
          date: '2026-02-01T00:00:00Z',
          streamer: 'fixture_streamer',
          duration_str: '1h0m0s'
        });
        await window.api.addToQueue({
          url: 'https://www.twitch.tv/videos/999999999999998',
          title: '__E2E_FULL__orderB',
          date: '2026-02-01T00:00:00Z',
          streamer: 'fixture_streamer',
          duration_str: '1h0m0s'
        });

        q = await window.api.getQueue();
        const ids = q.map((item) => item.id);
        const reversed = [...ids].reverse();
        await window.api.reorderQueue(reversed);
        const reordered = await window.api.getQueue();
        const reorderOk = JSON.stringify(reordered.map((item) => item.id)) === JSON.stringify(reversed);
        checks.reorder = { reorderOk };
        assert(reorderOk, 'Queue reorder API failed');

        await clearQueue();

        const cutterInput = await window.api.selectVideoFile();
        const mergeInputs = await window.api.selectMultipleVideos();
        const mergeOutput = await window.api.saveVideoDialog('merged_full.mp4');
        const capabilityContract = Boolean(
          cutterInput?.token
          && mergeInputs?.length === 2
          && mergeInputs.every((file) => typeof file.token === 'string' && file.token)
          && mergeOutput?.token
        );
        const info = capabilityContract ? await window.api.getVideoInfo(cutterInput.token) : null;
        const frame = capabilityContract ? await window.api.extractFrame(cutterInput.token, 1) : null;
        const cut = capabilityContract ? await window.api.cutVideo(cutterInput.token, 0.5, 1.7) : { success: false };
        const merge = capabilityContract ? await window.api.mergeVideos(mergeInputs.map((file) => file.token), mergeOutput.token) : { success: false };
        checks.media = {
          capabilityContract,
          infoOk: !!info && info.duration > 0,
          frameOk: typeof frame === 'string' && frame.length > 100,
          cutOk: cut.success,
          mergeOk: merge.success
        };
        assert(checks.media.capabilityContract, 'File dialogs did not issue capability references');
        assert(checks.media.infoOk, 'getVideoInfo failed for test media');
        assert(checks.media.frameOk, 'extractFrame failed for test media');
        assert(checks.media.cutOk, 'cutVideo failed for test media');
        assert(checks.media.mergeOk, 'mergeVideos failed for test media');

        const updateResult = await window.api.checkUpdate();
        checks.update = updateResult;
        assert(typeof updateResult === 'object', 'checkUpdate did not return object');
      } catch (e) {
        failures.push(`Unexpected exception: ${String(e)}`);
      } finally {
        await clearQueue();
        await window.api.saveConfig(initialConfig);
        config = await window.api.getConfig();
        await window.connect();
      }

      return { checks, failures };
    });

    await app.close();
    app = null;

    const output = {
      isolation,
      fixtures,
      ...summary,
      runtimeIssues: issues
    };

    console.log(JSON.stringify(output, null, 2));

    const failed = output.failures.length > 0 || output.runtimeIssues.length > 0;
    return failed ? 1 : 0;
  } finally {
    if (app) {
      await app.close().catch(() => undefined);
    }
    cleanupE2eEnvironment(environment);
  }
}

run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });

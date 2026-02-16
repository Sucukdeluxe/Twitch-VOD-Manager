const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const APPDATA_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Twitch_VOD_Manager');
const CONFIG_FILE = path.join(APPDATA_DIR, 'config.json');
const QUEUE_FILE = path.join(APPDATA_DIR, 'download_queue.json');
const TMP_DIR = path.join(process.cwd(), 'tmp_e2e_full');
const MEDIA_A = path.join(TMP_DIR, 'in_a.mp4');
const MEDIA_B = path.join(TMP_DIR, 'in_b.mp4');

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

function restoreFile(filePath, backup) {
  if (backup === null) {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, backup);
}

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

function resolveFfmpegBinary() {
  const direct = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
  if (direct.status === 0) return 'ffmpeg';

  const bundledRoot = path.join(APPDATA_DIR, 'tools', 'ffmpeg');
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

function ensureTestMedia() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const ffmpeg = resolveFfmpegBinary();

  runFfmpeg(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=640x360:rate=30',
    '-t', '4',
    '-pix_fmt', 'yuv420p',
    MEDIA_A
  ]);

  runFfmpeg(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=640x360:rate=30',
    '-t', '3',
    '-pix_fmt', 'yuv420p',
    MEDIA_B
  ]);
}

async function run() {
  const configBackup = backupFile(CONFIG_FILE);
  const queueBackup = backupFile(QUEUE_FILE);

  let app;
  try {
    ensureTestMedia();

    const electronPath = require('electron');
    app = await electron.launch({
      executablePath: electronPath,
      args: ['.'],
      cwd: process.cwd()
    });

    const win = await app.firstWindow();
    const issues = [];

    win.on('pageerror', (err) => {
      issues.push(`pageerror: ${String(err)}`);
    });

    win.on('console', (msg) => {
      if (msg.type() === 'error') {
        issues.push(`console.error: ${msg.text()}`);
      }
    });

    await win.waitForTimeout(2200);

    const summary = await win.evaluate(async ({ mediaA, mediaB, tmpDir }) => {
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

      const cleanupDownloads = async () => {
        await window.api.cancelDownload();
        await sleep(400);
      };

      const initialConfig = await window.api.getConfig();

      try {
        await cleanupDownloads();
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
          enActive: !!document.getElementById('langOptionEn')?.classList.contains('active')
        };

        checks.language = { deState, enState };
        assert(deState.nav.includes('Einstellungen'), 'German language switch failed');
        assert(enState.nav.includes('Settings'), 'English language switch failed');
        assert(deState.deIcon, 'German flag icon missing');
        assert(enState.enIcon, 'English flag icon missing');
        assert(deState.deActive, 'German language button did not activate');
        assert(enState.enActive, 'English language button did not activate');

        await window.api.saveConfig({ client_id: '', client_secret: '', download_path: tmpDir });
        window.showTab('vods');
        await window.selectStreamer('xrohat');

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
          url: 'https://www.twitch.tv/videos/2695851503',
          title: '__E2E_FULL__dup',
          date: '2026-02-01T00:00:00Z',
          streamer: 'xrohat',
          duration_str: '1h0m0s'
        });
        await window.api.addToQueue({
          url: 'https://www.twitch.tv/videos/2695851503',
          title: '__E2E_FULL__dup',
          date: '2026-02-01T00:00:00Z',
          streamer: 'xrohat',
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

        window.openClipDialog('https://www.twitch.tv/videos/2695851503', '__E2E_FULL__clip', '2026-02-01T00:00:00Z', 'xrohat', '1h0m0s');
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
          url: 'https://www.twitch.tv/videos/2695851503',
          title: '__E2E_FULL__pause',
          date: '2026-02-01T00:00:00Z',
          streamer: 'xrohat',
          duration_str: '4h0m0s'
        });

        await window.api.startDownload();
        await waitFor(async () => {
          const list = await window.api.getQueue();
          const it = list.find((x) => x.title === '__E2E_FULL__pause');
          return it && (it.status === 'downloading' || it.status === 'error');
        }, 25000, 400);

        await window.api.pauseDownload();
        await sleep(1400);
        q = await window.api.getQueue();
        const paused = q.find((item) => item.title === '__E2E_FULL__pause');
        checks.pauseResume = {
          pausedStatus: paused?.status || 'none',
          buttonText: (document.getElementById('btnStart')?.textContent || '').trim()
        };
        assert(paused?.status === 'paused', 'Pause did not set item status to paused');

        await window.api.startDownload();
        await sleep(900);
        const resumed = await window.api.isDownloading();
        checks.pauseResume.resumed = resumed;
        assert(resumed === true, 'Resume did not restart downloading');

        await cleanupDownloads();
        await clearQueue();

        await window.api.addToQueue({
          url: 'not-a-valid-url',
          title: '__E2E_FULL__retry',
          date: '2026-02-01T00:00:00Z',
          streamer: 'xrohat',
          duration_str: '1h0m0s'
        });
        await window.api.startDownload();

        const reachedError = await waitFor(async () => {
          const list = await window.api.getQueue();
          const it = list.find((item) => item.title === '__E2E_FULL__retry');
          return it && it.status === 'error';
        }, 90000, 1000);

        q = await window.api.getQueue();
        const failed = q.find((item) => item.title === '__E2E_FULL__retry');
        checks.retryFlow = {
          failedStatus: failed?.status || 'none',
          failedReason: failed?.last_error || ''
        };
        assert(reachedError && failed?.status === 'error', 'Retry item did not reach deterministic error state');
        assert(Boolean(failed?.last_error), 'Retry test item missing error reason');

        await window.api.retryFailedDownloads();
        await sleep(500);
        q = await window.api.getQueue();
        const afterRetry = q.find((item) => item.title === '__E2E_FULL__retry');
        checks.retryFlow.afterRetryStatus = afterRetry?.status || 'none';
        const retryAcceptedStatuses = ['pending', 'downloading', 'error'];
        assert(retryAcceptedStatuses.includes(afterRetry?.status || ''), 'Retry failed action did not update item state');

        await cleanupDownloads();
        await clearQueue();

        await window.api.addToQueue({
          url: 'https://www.twitch.tv/videos/does-not-exist',
          title: '__E2E_FULL__orderA',
          date: '2026-02-01T00:00:00Z',
          streamer: 'xrohat',
          duration_str: '1h0m0s'
        });
        await window.api.addToQueue({
          url: 'https://www.twitch.tv/videos/does-not-exist',
          title: '__E2E_FULL__orderB',
          date: '2026-02-01T00:00:00Z',
          streamer: 'xrohat',
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

        const info = await window.api.getVideoInfo(mediaA);
        const frame = await window.api.extractFrame(mediaA, 1);
        const cut = await window.api.cutVideo(mediaA, 0.5, 1.7);
        const merge = await window.api.mergeVideos([mediaA, mediaB], `${tmpDir.replace(/\\/g, '/')}/merged_full.mp4`);
        checks.media = {
          infoOk: !!info && info.duration > 0,
          frameOk: typeof frame === 'string' && frame.length > 100,
          cutOk: cut.success,
          mergeOk: merge.success
        };
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
        await cleanupDownloads();
        await clearQueue();
        await window.api.saveConfig(initialConfig);
        config = await window.api.getConfig();
        await window.connect();
      }

      return { checks, failures };
    }, {
      mediaA: MEDIA_A.replace(/\\/g, '/'),
      mediaB: MEDIA_B.replace(/\\/g, '/'),
      tmpDir: TMP_DIR.replace(/\\/g, '/')
    });

    await app.close();
    app = null;

    const output = {
      ...summary,
      runtimeIssues: issues
    };

    console.log(JSON.stringify(output, null, 2));

    const failed = output.failures.length > 0 || output.runtimeIssues.length > 0;
    process.exit(failed ? 1 : 0);
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // ignore
      }
    }

    restoreFile(CONFIG_FILE, configBackup);
    restoreFile(QUEUE_FILE, queueBackup);
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

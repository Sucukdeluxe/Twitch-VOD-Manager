const { _electron: electron } = require('playwright');
const {
  createE2eEnvironment,
  getElectronLaunchOptions,
  verifyE2eIsolation,
  installOfflineFixtures,
  cleanupE2eEnvironment
} = require('./e2e-test-environment');

async function run() {
  const environment = createE2eEnvironment('smoke');
  let app = null;

  try {
    app = await electron.launch(getElectronLaunchOptions(environment));
    const win = await app.firstWindow();
    const isolation = await verifyE2eIsolation(app, win, environment);
    const fixtures = await installOfflineFixtures(app);
    const issues = [];

    win.on('pageerror', (err) => {
      issues.push(`pageerror: ${String(err)}`);
    });

    win.on('console', (msg) => {
      if (msg.type() === 'error') {
        issues.push(`console.error: ${msg.text()}`);
      }
    });

    await win.waitForTimeout(2500);

    const globals = await win.evaluate(async () => {
      const names = [
        'showTab',
        'addStreamer',
        'refreshVODs',
        'downloadClip',
        'selectCutterVideo',
        'startCutting',
        'addMergeFiles',
        'startMerging',
        'saveSettings',
        'checkUpdate',
        'downloadUpdate',
        'updateFromInput',
        'updateFromSlider',
        'runPreflight',
        'retryFailedDownloads',
        'toggleDebugAutoRefresh'
      ];
      const map = {};
      for (const n of names) map[n] = typeof window[n];
      return map;
    });

    await win.evaluate(() => {
      window.showTab('clips');
      window.showTab('cutter');
      window.showTab('merge');
      window.showTab('settings');
      window.showTab('vods');
    });

    const input = win.locator('#newStreamer');
    const randomName = `smoketest_${Date.now()}`;
    await input.fill(randomName);
    await win.evaluate(async () => {
      await window.addStreamer();
    });

    const hasTempStreamer = await win.locator('#streamerList').innerText();

    await win.evaluate(async (name) => {
      await window.removeStreamer(name);
    }, randomName);

    await win.evaluate(async () => {
      await window.selectStreamer('fixture_streamer');
    });

    await win.waitForTimeout(500);

    const vodCount = await win.locator('.vod-card').count();

    if (vodCount > 0) {
      await win.locator('.vod-card .vod-btn.primary').first().click();
      await win.waitForTimeout(500);
    }

    const queueCountAfterAdd = await win.locator('#queueCount').innerText();

    const queueRemove = win.locator('#queueList .remove').first();
    if (await queueRemove.count()) {
      await queueRemove.click();
      await win.waitForTimeout(300);
    }

    await win.evaluate(() => {
      window.showTab('clips');
    });

    await win.fill('#clipUrl', '');
    await win.evaluate(async () => {
      await window.downloadClip();
    });

    const clipStatus = await win.locator('#clipStatus').innerText();

    await win.evaluate(async () => {
      await window.runPreflight(false);
      await window.startCutting();
      await window.startMerging();
    });

    const mergeButtonDisabled = await win.locator('#btnMerge').isDisabled();
    const preflightText = await win.locator('#preflightResult').innerText();
    const healthBadge = await win.locator('#healthBadge').innerText();
    const failedGlobals = Object.entries(globals)
      .filter(([, type]) => type !== 'function')
      .map(([name, type]) => `${name}=${type}`);
    const summary = {
      isolation,
      fixtures,
      failedGlobals,
      hasTempStreamer: hasTempStreamer.includes(randomName),
      vodCount,
      queueCountAfterAdd,
      clipStatus,
      mergeButtonDisabled,
      preflightText,
      healthBadge,
      issues
    };

    console.log(JSON.stringify(summary, null, 2));

    const hasFailure =
      failedGlobals.length > 0 ||
      !summary.hasTempStreamer ||
      summary.vodCount < 1 ||
      !(summary.clipStatus.includes('Bitte URL eingeben') || summary.clipStatus.includes('Please enter a URL')) ||
      !summary.mergeButtonDisabled ||
      !summary.preflightText ||
      !summary.healthBadge ||
      summary.issues.length > 0;

    return hasFailure ? 1 : 0;
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

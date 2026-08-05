const { _electron: electron } = require('playwright');

async function run() {
  const electronPath = require('electron');
  const app = await electron.launch({
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
    await window.selectStreamer('xrohat');
  });

  await win.waitForTimeout(3500);

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

  await app.close();

  const failedGlobals = Object.entries(globals)
    .filter(([, type]) => type !== 'function')
    .map(([name, type]) => `${name}=${type}`);

  const summary = {
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

  process.exit(hasFailure ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

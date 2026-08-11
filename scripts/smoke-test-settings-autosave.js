const { _electron: electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  createE2eEnvironment,
  writeE2eConfig,
  readE2eConfig,
  getElectronLaunchOptions,
  verifyE2eIsolation,
  installOfflineFixtures,
  cleanupE2eEnvironment
} = require('./e2e-test-environment');

async function launchApp(environment) {
  return electron.launch(getElectronLaunchOptions(environment));
}

async function setSettingsAndBlur(win, mode, partMinutes) {
  await win.evaluate(async ({ mode, partMinutes }) => {
    window.showTab('settings');
    const modeField = document.getElementById('downloadMode');
    const partField = document.getElementById('partMinutes');

    modeField.value = mode;
    modeField.dispatchEvent(new Event('change', { bubbles: true }));

    partField.focus();
    partField.value = String(partMinutes);
    partField.dispatchEvent(new Event('input', { bubbles: true }));
    partField.blur();

    await new Promise((resolve) => setTimeout(resolve, 250));
  }, { mode, partMinutes });
}

async function setSettingsAndCloseImmediately(win, mode, partMinutes) {
  await win.evaluate(({ mode, partMinutes }) => {
    window.showTab('settings');
    const modeField = document.getElementById('downloadMode');
    const partField = document.getElementById('partMinutes');

    modeField.value = mode;
    modeField.dispatchEvent(new Event('change', { bubbles: true }));

    partField.focus();
    partField.value = String(partMinutes);
    partField.dispatchEvent(new Event('input', { bubbles: true }));
  }, { mode, partMinutes });
}

async function readSettingsFromUi(win) {
  return win.evaluate(() => {
    window.showTab('settings');
    return {
      downloadMode: document.getElementById('downloadMode')?.value || '',
      partMinutes: document.getElementById('partMinutes')?.value || ''
    };
  });
}

async function run() {
  const environment = createE2eEnvironment('settings-autosave');
  let app = null;
  try {
    writeE2eConfig(environment, {
      download_mode: 'full',
      part_minutes: 120
    });

    const isolations = [];
    app = await launchApp(environment);
    let win = await app.firstWindow();
    isolations.push(await verifyE2eIsolation(app, win, environment));
    await installOfflineFixtures(app);
    await win.waitForTimeout(2200);
    await setSettingsAndBlur(win, 'parts', 60);
    await app.close();
    app = null;

    const afterBlurClose = readE2eConfig(environment);

    app = await launchApp(environment);
    win = await app.firstWindow();
    isolations.push(await verifyE2eIsolation(app, win, environment));
    await installOfflineFixtures(app);
    await win.waitForTimeout(2200);
    const reopenedAfterBlur = await readSettingsFromUi(win);
    await app.close();
    app = null;

    for (const filename of ['app.db', 'app.db-wal', 'app.db-shm']) {
      fs.rmSync(path.join(environment.appDataDir, filename), { force: true });
    }
    writeE2eConfig(environment, {
      download_mode: 'full',
      part_minutes: 120
    });

    app = await launchApp(environment);
    win = await app.firstWindow();
    isolations.push(await verifyE2eIsolation(app, win, environment));
    const fixtures = await installOfflineFixtures(app);
    await win.waitForTimeout(2200);
    await setSettingsAndCloseImmediately(win, 'parts', 75);
    await app.close();
    app = null;

    const afterDirectClose = readE2eConfig(environment);

    const result = {
      isolation: isolations,
      fixtures,
      afterBlurClose: {
        config: {
          download_mode: afterBlurClose.download_mode,
          part_minutes: afterBlurClose.part_minutes
        },
        ui: reopenedAfterBlur
      },
      afterDirectClose: {
        config: {
          download_mode: afterDirectClose.download_mode,
          part_minutes: afterDirectClose.part_minutes
        }
      }
    };

    console.log(JSON.stringify(result, null, 2));

    const blurCaseOk =
      afterBlurClose.download_mode === 'parts' &&
      afterBlurClose.part_minutes === 60 &&
      reopenedAfterBlur.downloadMode === 'parts' &&
      reopenedAfterBlur.partMinutes === '60';

    const directCloseOk =
      afterDirectClose.download_mode === 'parts' &&
      afterDirectClose.part_minutes === 75;

    return blurCaseOk && directCloseOk ? 0 : 1;
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

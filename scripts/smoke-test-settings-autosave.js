const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

const APPDATA_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Twitch_VOD_Manager');
const CONFIG_FILE = path.join(APPDATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  client_id: '',
  client_secret: '',
  download_path: path.join(process.env.USERPROFILE || 'C:\\Users\\ploet', 'Desktop', 'Twitch_VODs'),
  streamers: [],
  theme: 'twitch',
  download_mode: 'full',
  part_minutes: 120,
  language: 'en',
  filename_template_vod: '{title}.mp4',
  filename_template_parts: '{date}_Part{part_padded}.mp4',
  filename_template_clip: '{date}_{part}.mp4',
  smart_queue_scheduler: true,
  performance_mode: 'balanced',
  prevent_duplicate_downloads: true,
  metadata_cache_minutes: 10
};

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

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

async function launchApp() {
  const electronPath = require('electron');
  return electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: process.cwd()
  });
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
  const configBackup = backupFile(CONFIG_FILE);
  const baseConfig = configBackup ? { ...DEFAULT_CONFIG, ...JSON.parse(String(configBackup)) } : { ...DEFAULT_CONFIG };

  let app = null;
  try {
    writeConfig({
      ...baseConfig,
      client_id: '',
      client_secret: '',
      download_mode: 'full',
      part_minutes: 120
    });

    app = await launchApp();
    let win = await app.firstWindow();
    await win.waitForTimeout(2200);
    await setSettingsAndBlur(win, 'parts', 60);
    await app.close();
    app = null;

    const afterBlurClose = readConfig();

    app = await launchApp();
    win = await app.firstWindow();
    await win.waitForTimeout(2200);
    const reopenedAfterBlur = await readSettingsFromUi(win);
    await app.close();
    app = null;

    writeConfig({
      ...baseConfig,
      client_id: '',
      client_secret: '',
      download_mode: 'full',
      part_minutes: 120
    });

    app = await launchApp();
    win = await app.firstWindow();
    await win.waitForTimeout(2200);
    await setSettingsAndCloseImmediately(win, 'parts', 75);
    await app.close();
    app = null;

    const afterDirectClose = readConfig();

    const result = {
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

    process.exit(blurCaseOk && directCloseOk ? 0 : 1);
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // ignore
      }
    }

    restoreFile(CONFIG_FILE, configBackup);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

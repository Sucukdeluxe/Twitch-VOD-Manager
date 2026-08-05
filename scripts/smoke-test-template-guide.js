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
  const failures = [];

  win.on('pageerror', (err) => {
    issues.push(`pageerror: ${String(err)}`);
  });

  win.on('console', (msg) => {
    if (msg.type() === 'error') {
      issues.push(`console.error: ${msg.text()}`);
    }
  });

  const fail = (message) => failures.push(message);

  let settingsPreview = '';
  let variableRows = 0;
  let clipPreviewBefore = '';
  let clipPreviewAfter = '';

  try {
    await win.waitForTimeout(2500);

    await win.evaluate(() => {
      window.showTab('settings');
    });
    await win.waitForTimeout(200);

    await win.click('#settingsTemplateGuideBtn');
    await win.waitForTimeout(180);

    const guideVisibleFromSettings = await win.evaluate(() => {
      return document.getElementById('templateGuideModal')?.classList.contains('show') || false;
    });

    if (!guideVisibleFromSettings) {
      fail('Template guide did not open from settings');
    }

    await win.fill('#templateGuideInput', '{title}_{part_padded}_{date_custom="yyyy-MM-dd"}.mp4');
    await win.waitForTimeout(160);

    settingsPreview = await win.locator('#templateGuideOutput').innerText();
    if (!settingsPreview.includes('.mp4')) {
      fail('Settings template preview missing .mp4 output');
    }
    if (settingsPreview.includes('{title}') || settingsPreview.includes('{part_padded}') || settingsPreview.includes('{date_custom=')) {
      fail('Settings template preview did not replace placeholders');
    }

    variableRows = await win.locator('#templateGuideBody tr').count();
    if (variableRows < 12) {
      fail(`Template variable table too short (${variableRows})`);
    }

    await win.click('#templateGuideUseParts');
    await win.waitForTimeout(150);
    const partsContext = await win.locator('#templateGuideContext').innerText();
    if (!/part|teil/i.test(partsContext)) {
      fail('Template guide parts context text missing');
    }

    await win.click('#templateGuideCloseBtn');
    await win.waitForTimeout(100);

    await win.evaluate(async () => {
      window.showTab('vods');
      await window.selectStreamer('xrohat');
    });
    await win.waitForTimeout(3200);

    const clipButtons = win.locator('.vod-card .vod-btn.secondary');
    const clipCount = await clipButtons.count();
    if (clipCount < 1) {
      fail('No clip buttons found in VOD list');
    } else {
      await clipButtons.first().click();
      await win.waitForTimeout(260);

      await win.locator('input[name="filenameFormat"][value="template"]').check();
      await win.waitForTimeout(140);

      await win.click('#clipTemplateGuideBtn');
      await win.waitForTimeout(140);

      const clipContext = await win.locator('#templateGuideContext').innerText();
      if (!/clip/i.test(clipContext)) {
        fail('Template guide clip context text missing');
      }

      await win.fill('#templateGuideInput', '{trim_start}_{part}.mp4');
      await win.waitForTimeout(120);
      clipPreviewBefore = await win.locator('#templateGuideOutput').innerText();

      await win.fill('#clipStartTime', '00:00:10');
      await win.evaluate(() => {
        window.updateFromInput('start');
      });
      await win.waitForTimeout(240);

      clipPreviewAfter = await win.locator('#templateGuideOutput').innerText();
      if (clipPreviewAfter === clipPreviewBefore) {
        fail('Clip template guide preview did not react to clip start time changes');
      }

      await win.click('#templateGuideCloseBtn');
      await win.evaluate(() => {
        window.closeClipDialog();
      });
    }
  } finally {
    await app.close();
  }

  const summary = {
    failures,
    issues,
    checks: {
      settingsPreview,
      variableRows,
      clipPreviewBefore,
      clipPreviewAfter
    }
  };

  console.log(JSON.stringify(summary, null, 2));

  const hasFailure = failures.length > 0 || issues.length > 0;
  process.exit(hasFailure ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

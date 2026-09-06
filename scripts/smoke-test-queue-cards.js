const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { createE2eEnvironment, getElectronLaunchOptions, verifyE2eIsolation, installOfflineFixtures, cleanupE2eEnvironment } = require('./e2e-test-environment');

async function main() {
  const environment = createE2eEnvironment('queue-cards');
  const artifacts = path.resolve(__dirname, '../tmp_queue-card-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  let app;
  try {
    app = await electron.launch(getElectronLaunchOptions(environment));
    const win = await app.firstWindow();
    await verifyE2eIsolation(app, win, environment);
    await installOfflineFixtures(app);
    const errors = [];
    win.on('pageerror', (error) => errors.push(String(error)));
    await win.waitForFunction(() => typeof window.showTab === 'function' && typeof window.changeLanguage === 'function');
    await win.waitForFunction((version) => appVersion === version, require('../package.json').version);
    const fixtures = await win.evaluate(() => {
      showTab('vods');
      const panel = document.querySelector('[data-context-for="vods"]');
      panel.dataset.vodsLayout = 'tabs';
      panel.dataset.vodsWorkspace = 'queue';
      queue = [
        { id: 'pending', status: 'pending', title: 'Ein langer Streamtitel mit gut lesbaren Download-Details und einer zweiten Zeile', progress: 0, url: 'https://www.twitch.tv/videos/2863358704' },
        { id: 'running', status: 'downloading', title: 'Sommerstream am See – gemeinsam unterwegs', progress: 42, progressStatus: 'Video wird heruntergeladen', speed: '12.5 MB/s', eta: '08:24' },
        { id: 'paused', status: 'paused', title: 'Community-Abend mit Freunden', progress: 23 },
        { id: 'error', status: 'error', title: 'Ein weiterer langer Streamtitel mit einer Fehlermeldung', progress: 10, last_error: 'Die Verbindung wurde unterbrochen. Bitte erneut versuchen.' },
        { id: 'completed', status: 'completed', title: 'Highlights vom Wochenende', progress: 100, outputFiles: ['C:\\fixture\\highlights.mp4'] },
        { id: 'live', status: 'downloading', title: 'Live aus dem Studio', progress: 0, isLive: true, recordingHealth: 'ok', progressStatus: 'Live-Aufnahme läuft' }
      ].map((item) => ({ url: `https://example.invalid/${item.id}`, date: '2026-09-06T10:00:00Z', streamer: 'Beispielkanal', duration_str: '2h 34m', ...item }));
      renderQueue();
      return queue;
    });
    await app.evaluate(({ ipcMain }, items) => {
      ipcMain.removeHandler('get-queue');
      ipcMain.handle('get-queue', async () => items);
    }, fixtures);
    await win.evaluate(async () => {
      await syncQueueAndDownloadState();
      clearTimeout(queueSyncTimer);
      queueSyncTimer = null;
    });
    assert.equal(await win.locator('#queueList .queue-item').count(), fixtures.length, 'Queue fixtures survive background synchronization');
    for (const theme of ['twitch', 'light']) {
      for (const language of ['de', 'en']) {
        await win.setViewportSize({ width: 1280, height: 900 });
        await win.evaluate(({ theme, language }) => {
          document.body.className = `theme-${theme}`;
          changeLanguage(language);
        }, { theme, language });
        const layout = await win.locator('#queueList').evaluate((list) => [...list.querySelectorAll('.queue-item')].map((item) => {
          const rect = (selector) => item.querySelector(selector).getBoundingClientRect();
          const date = rect('.queue-date');
          const bar = rect('.queue-progress-wrap');
          const status = rect('.queue-status-badge');
          const toggle = rect('.queue-details-toggle');
          const remove = rect('.remove');
          return {
            id: item.dataset.id,
            dateBelow: date.top >= bar.bottom,
            dateLeft: date.left >= toggle.right && date.right < status.left,
            statusRight: Math.abs(status.right - bar.right) <= 1,
            dateSize: parseFloat(getComputedStyle(item.querySelector('.queue-date')).fontSize),
            removeSize: Math.min(remove.width, remove.height),
            overflow: item.scrollWidth - item.clientWidth,
            tinyText: [...item.querySelectorAll('*')].filter((element) => element.textContent.trim() && element.getBoundingClientRect().height > 0 && parseFloat(getComputedStyle(element).fontSize) < 10).length,
          };
        }));
        for (const card of layout) {
          assert(card.dateBelow && card.dateLeft && card.statusRight, `Footer placement: ${JSON.stringify(card)}`);
          assert(card.dateSize >= 12 && card.removeSize >= 32 && card.tinyText === 0, `Readability: ${JSON.stringify(card)}`);
          assert(card.overflow <= 1, `Card overflow: ${JSON.stringify(card)}`);
        }
        await win.locator('.queue-section').screenshot({ path: path.join(artifacts, `queue-${theme}-${language}.png`) });
        const expansionLayout = await win.locator('#queueList').evaluate(async (list) => {
          const items = [...list.querySelectorAll('.queue-item')];
          const originalStyles = [list, ...items].map((element) => element.getAttribute('style'));
          const item = items[0];
          const details = item.querySelector('.queue-details');
          const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
          const measure = () => {
            const title = item.querySelector('.title').getBoundingClientRect();
            return { left: title.left, width: title.width, height: title.height, overflowing: list.scrollHeight > list.clientHeight };
          };
          try {
            for (const other of items.slice(2)) other.style.display = 'none';
            list.style.flex = '0 0 auto';
            list.style.height = `${items.slice(0, 2).reduce((height, card) => height + card.getBoundingClientRect().height + parseFloat(getComputedStyle(card).marginBottom), 0) + 20}px`;
            const before = measure();
            const samples = [];
            const animate = async () => {
              toggleQueueDetails(item.dataset.id);
              await frame();
              await frame();
              do {
                samples.push(measure());
                await frame();
              } while (details.getAnimations().length);
              return measure();
            };
            const expanded = await animate();
            const url = item.querySelector('.queue-url-copy');
            const urlLabel = item.querySelector('.queue-url-row .queue-detail-label');
            const urlLayout = {
              belowLabel: url.getBoundingClientRect().top >= urlLabel.getBoundingClientRect().bottom,
              singleLine: getComputedStyle(url).whiteSpace === 'nowrap',
              fullyVisible: url.scrollWidth <= url.clientWidth,
            };
            const collapsed = await animate();
            return { before, expanded, collapsed, samples, urlLayout };
          } finally {
            [list, ...items].forEach((element, index) => {
              if (originalStyles[index] === null) element.removeAttribute('style');
              else element.setAttribute('style', originalStyles[index]);
            });
          }
        });
        assert(!expansionLayout.before.overflowing && expansionLayout.expanded.overflowing && !expansionLayout.collapsed.overflowing, `Expansion fixture crosses the scrollbar threshold (${theme}/${language}): ${JSON.stringify({ before: expansionLayout.before, expanded: expansionLayout.expanded, collapsed: expansionLayout.collapsed })}`);
        assert(Object.values(expansionLayout.urlLayout).every(Boolean), `URL stays fully visible below its label (${theme}/${language}): ${JSON.stringify(expansionLayout.urlLayout)}`);
        for (const sample of [...expansionLayout.samples, expansionLayout.expanded, expansionLayout.collapsed]) {
          for (const dimension of ['left', 'width', 'height']) {
            assert(Math.abs(sample[dimension] - expansionLayout.before[dimension]) <= 0.5, `Title ${dimension} shifts during expansion (${theme}/${language})`);
          }
        }
      }
    }
    const card = win.locator('.queue-item[data-id="pending"]');
    const toggle = card.locator('[data-queue-action="details"]');
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await win.emulateMedia({ reducedMotion });
      const motion = await card.evaluate(async (item) => {
        const details = item.querySelector('.queue-details');
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const sample = async () => {
          await frame();
          await frame();
          const animations = details.getAnimations();
          const slide = animations.find((animation) => animation.transitionProperty === 'grid-template-rows');
          if (!slide) throw new Error('Queue details have no height transition');
          for (const animation of animations) animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
          const middle = details.getBoundingClientRect().height;
          for (const animation of animations) animation.finish();
          await frame();
          return { middle, end: details.getBoundingClientRect().height };
        };
        const collapsed = details.getBoundingClientRect().height;
        toggleQueueDetails(item.dataset.id);
        const opening = await sample();
        toggleQueueDetails(item.dataset.id);
        const closing = await sample();
        return { collapsed, opening, closing, inert: details.inert };
      });
      assert.equal(motion.collapsed, 0);
      assert(motion.opening.middle > 0 && motion.opening.middle < motion.opening.end, 'Details slide open');
      assert(motion.closing.middle > 0 && motion.closing.middle < motion.opening.end, 'Details slide closed');
      assert.equal(motion.closing.end, 0);
      assert(motion.inert, 'Collapsed details cannot receive keyboard input');
    }
    for (const selector of ['.title', '.queue-date', '.queue-progress-wrap', '.queue-status-label']) {
      await card.locator(selector).dblclick();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true', `${selector} expands`);
      await card.locator(selector).dblclick();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false', `${selector} collapses`);
    }
    await card.dblclick({ position: { x: 4, y: 4 } });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'Card padding expands');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'Toggle collapses');
    await toggle.dblclick();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'Both rapid toggle clicks are applied');
    for (const detail of [3, 4, 5]) {
      await toggle.dispatchEvent('click', { detail });
      assert.equal(await toggle.getAttribute('aria-expanded'), String(detail % 2 === 1), 'Rapid repeated clicks are never suppressed');
    }
    await toggle.focus();
    await win.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'Space collapses');
    await win.keyboard.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'Enter expands');
    assert(await toggle.evaluate((button) => document.activeElement === button), 'Toggle retains keyboard focus');
    await win.evaluate(() => {
      queue.find((item) => item.id === 'running').progress = 61;
      renderQueue();
    });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'Expansion survives queue rerender');
    assert.equal(await win.locator('[data-id="running"] .queue-progress-wrap').getAttribute('aria-valuenow'), '61');
    await win.evaluate(() => {
      window.queueCopiedUrls = [];
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (url) => { window.queueCopiedUrls.push(url); },
      });
    });
    const urlButton = card.locator('.queue-url-copy');
    await urlButton.click();
    await urlButton.press('Enter');
    await urlButton.press('Space');
    assert.deepEqual(await win.evaluate(() => window.queueCopiedUrls), Array(3).fill(fixtures[0].url));
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'Copying the URL keeps details open');
    assert(await win.evaluate(() => document.body.innerText.includes(UI_TEXT.queue.ctxCopiedUrl)), 'Copy confirmation is visible');
    for (const theme of ['twitch', 'light']) {
      await win.evaluate((theme) => { document.body.className = `theme-${theme}`; }, theme);
      await card.screenshot({ path: path.join(artifacts, `queue-url-${theme}.png`) });
    }
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('remove-from-queue');
      ipcMain.handle('remove-from-queue', async (_event, id) => {
        if (id !== 'pending') throw new Error('Unexpected removal target');
        ipcMain.removeHandler('get-queue');
        ipcMain.handle('get-queue', async () => []);
        return [];
      });
    });
    await card.locator('.remove svg path').click();
    await win.waitForFunction(() => document.querySelectorAll('#queueList .queue-item').length === 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ failures: [], themes: 2, languages: 2, states: 6, interactions: 'passed', artifacts }));
  } finally {
    if (app) await app.close();
    cleanupE2eEnvironment(environment);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

const { _electron: electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  createE2eEnvironment,
  getElectronLaunchOptions,
  verifyE2eIsolation,
  installOfflineFixtures,
  cleanupE2eEnvironment
} = require('./e2e-test-environment');

const TARGETS = [
  { width: 2048, height: 1094 },
  { width: 1600, height: 900 },
  { width: 1280, height: 800 }
];

const TABS = ['vods', 'clips', 'cutter', 'merge', 'stats', 'archive', 'settings'];

async function run() {
  const environment = createE2eEnvironment('workspace-ui', {
    language: 'en',
    theme: 'twitch'
  });
  const artifactDir = path.join(process.cwd(), 'artifacts', 'ui-overhaul', 'workspace-ui');
  fs.mkdirSync(artifactDir, { recursive: true });

  const failures = [];
  const runtimeIssues = [];
  const checks = {};
  let app;

  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };

  try {
    app = await electron.launch(getElectronLaunchOptions(environment));

    const win = await app.firstWindow();
    const isolation = await verifyE2eIsolation(app, win, environment);
    const offlineFixtures = await installOfflineFixtures(app);
    checks.dataIsolation = {
      expectedUserData: environment.userDataDir,
      actualUserData: isolation.userData,
      expectedDownloadPath: environment.downloadsDir,
      actualDownloadPath: isolation.downloadPath
    };
    checks.offlineFixtures = offlineFixtures;
    check(isolation.userDataIsolated, 'Electron userData is not isolated from the regular application profile');
    check(isolation.downloadPathIsolated, 'Workspace content is not isolated from the regular download folder');
    check(offlineFixtures.network === 'blocked' && offlineFixtures.twitch === 'fixture' && offlineFixtures.updater === 'fixture', 'Workspace UI test is not protected by offline fixtures');
    win.on('pageerror', (error) => runtimeIssues.push(`pageerror: ${String(error)}`));
    win.on('console', (message) => {
      if (message.type() === 'error') runtimeIssues.push(`console.error: ${message.text()}`);
    });

    await win.waitForFunction(() => typeof window.showTab === 'function');

    const shell = await win.evaluate(() => ({
      topbar: Boolean(document.querySelector('.app-topbar')),
      topNavigation: Boolean(document.querySelector('.top-nav')),
      workspace: Boolean(document.querySelector('.workspace-shell')),
      contextSidebar: Boolean(document.querySelector('.context-sidebar')),
      workspaceMain: Boolean(document.querySelector('.workspace-main')),
      toolbar: Boolean(document.querySelector('.workspace-toolbar')),
      updateButton: Boolean(document.getElementById('workspaceUpdateButton')),
      topNavigationItems: document.querySelectorAll('.top-nav button[data-tab]').length,
      nonButtonNavigationItems: document.querySelectorAll('.top-nav [data-tab]:not(button)').length
    }));
    checks.shell = shell;

    check(shell.topbar, 'The persistent application topbar is missing');
    check(shell.topNavigation, 'The primary icon navigation is missing');
    check(shell.workspace, 'The workspace shell is missing');
    check(shell.contextSidebar, 'The contextual sidebar is missing');
    check(shell.workspaceMain, 'The workspace main region is missing');
    check(shell.toolbar, 'The workspace toolbar is missing');
    check(shell.updateButton, 'The persistent update action is missing');
    check(shell.topNavigationItems === 7, `Expected 7 native primary navigation buttons, found ${shell.topNavigationItems}`);
    check(shell.nonButtonNavigationItems === 0, `Expected only native primary navigation buttons, found ${shell.nonButtonNavigationItems} non-buttons`);

    const cutterDropFixturePath = path.join(environment.mediaDir, 'electron-43-cutter-drop.mp4');
    fs.writeFileSync(cutterDropFixturePath, 'electron-43-cutter-drop-fixture', 'utf8');
    await app.evaluate(({ ipcMain }) => {
      globalThis.__workspaceCutterDropPaths = { videoInfo: '', preview: '' };
      ipcMain.removeHandler('get-video-info');
      ipcMain.handle('get-video-info', (_, filePath) => {
        globalThis.__workspaceCutterDropPaths.videoInfo = filePath;
        return { duration: 120, width: 1920, height: 1080, fps: 60 };
      });
      ipcMain.removeHandler('extract-frame');
      ipcMain.handle('extract-frame', (_, filePath) => {
        globalThis.__workspaceCutterDropPaths.preview = filePath;
        return null;
      });
    });
    await win.evaluate(() => {
      window.showTab('cutter');
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'workspaceCutterDropInput';
      document.body.appendChild(input);
    });
    await win.locator('#workspaceCutterDropInput').setInputFiles(cutterDropFixturePath);
    const cutterFileObject = await win.evaluate(() => {
      const input = document.getElementById('workspaceCutterDropInput');
      const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
      if (!file) return { name: '', legacyPathType: 'missing', apiType: typeof window.api.getPathForFile };
      const transfer = new DataTransfer();
      transfer.items.add(file);
      document.getElementById('cutterTab')?.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
      return {
        name: file.name,
        legacyPathType: typeof file.path,
        apiType: typeof window.api.getPathForFile
      };
    });
    await win.waitForTimeout(250);
    const cutterDropPaths = await app.evaluate(() => ({ ...globalThis.__workspaceCutterDropPaths }));
    const cutterDropUi = await win.evaluate(() => ({
      filePath: document.getElementById('cutterFilePath')?.value || '',
      infoVisible: document.getElementById('cutterInfo')?.classList.contains('shown') || false,
      cutEnabled: document.getElementById('btnCut')?.disabled === false
    }));
    checks.cutterDrop = {
      electronVersion: await app.evaluate(() => process.versions.electron),
      expectedPath: cutterDropFixturePath,
      fileObject: cutterFileObject,
      ipc: cutterDropPaths,
      ui: cutterDropUi
    };
    check(cutterFileObject.legacyPathType === 'undefined', `Electron File.path is unexpectedly ${cutterFileObject.legacyPathType}`);
    check(cutterDropUi.filePath === cutterDropFixturePath, `Cutter drop resolved "${cutterDropUi.filePath}" instead of the Electron file path`);
    check(cutterDropPaths.videoInfo === cutterDropFixturePath, `Cutter drop sent "${cutterDropPaths.videoInfo}" to video info instead of the Electron file path`);
    check(cutterDropPaths.preview === cutterDropFixturePath, `Cutter drop sent "${cutterDropPaths.preview}" to preview instead of the Electron file path`);
    check(cutterDropUi.infoVisible && cutterDropUi.cutEnabled, 'Cutter drop did not populate the cutter controls');

    const queueEmptyActions = await win.evaluate(() => ({
      count: document.getElementById('queueCount')?.textContent?.trim() || '',
      startDisabled: document.getElementById('btnStart')?.disabled === true,
      retryDisabled: document.getElementById('btnRetryFailed')?.disabled === true,
      clearDisabled: document.getElementById('btnClear')?.disabled === true
    }));
    checks.queueEmptyActions = queueEmptyActions;
    check(queueEmptyActions.count === '0', `Expected an empty isolated queue, found count ${queueEmptyActions.count}`);
    check(queueEmptyActions.startDisabled, 'Start queue action is enabled while the queue is empty');
    check(queueEmptyActions.retryDisabled, 'Retry queue action is enabled while the queue is empty');
    check(queueEmptyActions.clearDisabled, 'Clear queue action is enabled while the queue is empty');

    await win.evaluate(() => {
      const storagePrototype = Object.getPrototypeOf(localStorage);
      const originalSetItem = storagePrototype.setItem;
      window.__workspaceTabActivations = [];
      storagePrototype.setItem = function setItem(key, value) {
        if (key === 'twitch-vod-manager:active-tab') {
          window.__workspaceTabActivations.push(value);
        }
        return originalSetItem.call(this, key, value);
      };
    });

    const keyboardActivations = {};
    for (const tab of TABS) {
      keyboardActivations[tab] = {};
      for (const key of ['Enter', 'Space']) {
        const button = win.locator(`.top-nav button[data-tab="${tab}"]`);
        await win.evaluate(() => { window.__workspaceTabActivations = []; });
        await button.focus();
        await button.press(key);
        await win.waitForTimeout(30);
        const activations = await win.evaluate(() => [...window.__workspaceTabActivations]);
        keyboardActivations[tab][key] = activations;
        check(activations.length === 1, `${tab} ${key} activation persisted ${activations.length} tab changes instead of exactly one`);
        check(activations[0] === tab, `${tab} ${key} activation persisted the wrong tab: ${activations.join(', ')}`);
      }
    }
    checks.keyboardActivations = keyboardActivations;

    const updateContract = await win.evaluate(() => ({
      action: typeof window.handleWorkspaceUpdateAction,
      available: typeof window.setUpdateBannerAvailableUi,
      downloading: typeof window.setDownloadPendingUi,
      ready: typeof window.setDownloadReadyUi,
      idle: typeof window.hideUpdateBanner
    }));
    checks.updateContract = updateContract;
    check(Object.values(updateContract).every((value) => value === 'function'), 'The workspace updater state contract is incomplete');

    if (Object.values(updateContract).every((value) => value === 'function')) {
      const updaterStates = await win.evaluate(() => {
        const capture = () => ({
          state: document.getElementById('updateBanner')?.dataset.updateState || '',
          label: document.getElementById('workspaceUpdateLabel')?.textContent?.trim() || '',
          description: document.getElementById('updateText')?.textContent?.trim() || '',
          checkLabel: document.getElementById('checkUpdateBtn')?.textContent?.trim() || '',
          disabled: document.getElementById('workspaceUpdateButton')?.disabled || false,
          ariaDisabled: document.getElementById('workspaceUpdateButton')?.getAttribute('aria-disabled') || ''
        });

        window.setUpdateBannerAvailableUi({ version: '9.9.9' });
        const available = capture();
        window.setDownloadPendingUi();
        const downloading = capture();
        window.setDownloadReadyUi({ version: '9.9.9' });
        const ready = capture();
        window.hideUpdateBanner();
        const idle = capture();
        return { available, downloading, ready, idle };
      });

      checks.updaterStates = updaterStates;
      check(updaterStates.available.state === 'available', 'Available update state is not reflected in the topbar');
      check(updaterStates.available.description.includes('9.9.9'), 'Available update version is not announced');
      check(updaterStates.downloading.state === 'downloading', 'Download state is not reflected in the topbar');
      check(!updaterStates.downloading.disabled, 'Downloading update status is not keyboard focusable');
      check(updaterStates.downloading.ariaDisabled === 'true', 'Downloading update action does not expose aria-disabled=true');
      check(updaterStates.ready.state === 'ready', 'Ready-to-install state is not reflected in the topbar');
      check(updaterStates.ready.description.includes('9.9.9'), 'Ready update version is not announced');
      check(updaterStates.idle.state === 'idle', 'Idle update state is not restored in the topbar');
      check(!updaterStates.idle.description.includes('9.9.9'), 'Idle update state keeps stale release information');
      check(updaterStates.idle.description === updaterStates.idle.checkLabel, 'Idle update tooltip does not describe the available action');

      await win.evaluate(() => window.setDownloadPendingUi());
      await win.locator('#workspaceUpdateButton').focus();
      await win.waitForTimeout(80);
      const downloadingKeyboardState = await win.evaluate(() => {
        const button = document.getElementById('workspaceUpdateButton');
        const popover = document.querySelector('.workspace-update-popover');
        const style = popover ? getComputedStyle(popover) : null;
        return {
          focused: document.activeElement === button,
          disabled: button?.disabled || false,
          ariaDisabled: button?.getAttribute('aria-disabled') || '',
          ariaExpanded: button?.getAttribute('aria-expanded') || '',
          visible: Boolean(style && style.visibility === 'visible' && Number(style.opacity) > 0),
          state: document.getElementById('updateBanner')?.dataset.updateState || ''
        };
      });
      await win.keyboard.press('Enter');
      const downloadingStateAfterEnter = await win.evaluate(() => document.getElementById('updateBanner')?.dataset.updateState || '');
      checks.downloadingKeyboardState = { ...downloadingKeyboardState, stateAfterEnter: downloadingStateAfterEnter };
      check(downloadingKeyboardState.focused && !downloadingKeyboardState.disabled, 'Downloading update status cannot receive keyboard focus');
      check(downloadingKeyboardState.ariaDisabled === 'true', 'Downloading update trigger does not communicate its unavailable action');
      check(downloadingKeyboardState.visible && downloadingKeyboardState.ariaExpanded === 'true', 'Downloading progress is hidden from keyboard focus');
      check(downloadingKeyboardState.state === 'downloading' && downloadingStateAfterEnter === 'downloading', 'Keyboard activation changes the downloading state');
      await win.evaluate(() => window.hideUpdateBanner());

      await win.evaluate(() => window.setUpdateBannerAvailableUi({ version: '9.9.9' }));
      await win.locator('#workspaceUpdateButton').hover();
      await win.waitForTimeout(80);
      const popoverActions = await win.evaluate(() => {
        const popover = document.querySelector('.workspace-update-popover');
        const later = document.getElementById('workspaceUpdateLater');
        const dismiss = document.getElementById('workspaceUpdateDismiss');
        const style = popover ? getComputedStyle(popover) : null;
        return {
          visible: Boolean(style && style.visibility === 'visible' && Number(style.opacity) > 0),
          laterExists: later instanceof HTMLButtonElement,
          laterText: later?.textContent?.trim() || '',
          dismissExists: dismiss instanceof HTMLButtonElement,
          dismissLabel: dismiss?.textContent?.trim() || dismiss?.getAttribute('aria-label')?.trim() || dismiss?.getAttribute('title')?.trim() || '',
          expanded: document.getElementById('workspaceUpdateButton')?.getAttribute('aria-expanded') || ''
        };
      });
      checks.popoverActions = popoverActions;
      check(popoverActions.visible, 'Available update popover is not visible on hover');
      check(popoverActions.laterExists, 'Available update popover has no Later action');
      check(/^later$/i.test(popoverActions.laterText), `Available update Later action is labelled "${popoverActions.laterText}"`);
      check(popoverActions.dismissExists, 'Available update popover has no Close action');
      check(/^close$/i.test(popoverActions.dismissLabel), `Available update Close action is labelled "${popoverActions.dismissLabel}"`);
      check(popoverActions.expanded === 'true', 'Available update trigger does not expose aria-expanded=true while the popover is visible');

      if (popoverActions.laterExists) {
        await win.locator('#workspaceUpdateLater').click();
        await win.waitForTimeout(160);
        const laterState = await win.evaluate(() => ({
          state: document.getElementById('updateBanner')?.dataset.updateState || '',
          shown: document.getElementById('updateBanner')?.classList.contains('show') || false,
          visibility: getComputedStyle(document.querySelector('.workspace-update-popover')).visibility,
          pointerEvents: getComputedStyle(document.querySelector('.workspace-update-popover')).pointerEvents,
          opacity: getComputedStyle(document.querySelector('.workspace-update-popover')).opacity,
          ariaExpanded: document.getElementById('workspaceUpdateButton')?.getAttribute('aria-expanded') || ''
        }));
        checks.updateLaterState = laterState;
        check(laterState.state === 'available', 'Later action discards the available update state');
        check(!laterState.shown, 'Later action does not hide the current update announcement');
        check(laterState.visibility === 'hidden' && laterState.pointerEvents === 'none' && Number(laterState.opacity) === 0, 'Later action leaves the update popover visibly interactive');
        check(laterState.ariaExpanded === 'false', 'Later action leaves aria-expanded=true on a hidden popover');

        await win.evaluate(() => window.setDownloadReadyUi({ version: '9.9.9' }));
        const readyAfterPostpone = await win.evaluate(() => ({
          state: document.getElementById('updateBanner')?.dataset.updateState || '',
          shown: document.getElementById('updateBanner')?.classList.contains('show') || false,
          dismissed: document.getElementById('updateBanner')?.classList.contains('popover-dismissed') || false
        }));
        await win.evaluate(() => {
          window.changeLanguage('de');
          window.changeLanguage('en');
        });
        const readyAfterLanguageRefresh = await win.evaluate(() => ({
          state: document.getElementById('updateBanner')?.dataset.updateState || '',
          shown: document.getElementById('updateBanner')?.classList.contains('show') || false,
          dismissed: document.getElementById('updateBanner')?.classList.contains('popover-dismissed') || false
        }));
        checks.readyAfterPostpone = { immediate: readyAfterPostpone, afterLanguageRefresh: readyAfterLanguageRefresh };
        check(readyAfterPostpone.state === 'ready' && readyAfterPostpone.shown && !readyAfterPostpone.dismissed, 'Ready update remains postponed after download completion');
        check(readyAfterLanguageRefresh.state === 'ready' && readyAfterLanguageRefresh.shown && !readyAfterLanguageRefresh.dismissed, 'Language refresh hides or postpones a ready update');
      }

      await win.evaluate(() => window.setUpdateBannerAvailableUi({ version: '9.9.9' }));
      if (popoverActions.dismissExists) {
        await win.locator('#workspaceUpdateButton').hover();
        await win.locator('#workspaceUpdateDismiss').click();
        await win.waitForTimeout(160);
        const dismissState = await win.evaluate(() => ({
          state: document.getElementById('updateBanner')?.dataset.updateState || '',
          shown: document.getElementById('updateBanner')?.classList.contains('show') || false,
          visibility: getComputedStyle(document.querySelector('.workspace-update-popover')).visibility,
          pointerEvents: getComputedStyle(document.querySelector('.workspace-update-popover')).pointerEvents,
          opacity: getComputedStyle(document.querySelector('.workspace-update-popover')).opacity,
          ariaExpanded: document.getElementById('workspaceUpdateButton')?.getAttribute('aria-expanded') || ''
        }));
        checks.updateDismissState = dismissState;
        check(dismissState.state === 'idle', 'Close action does not dismiss the available update state');
        check(!dismissState.shown, 'Close action leaves the update announcement visible');
        check(dismissState.visibility === 'hidden' && dismissState.pointerEvents === 'none' && Number(dismissState.opacity) === 0, 'Close action leaves the update popover visibly interactive');
        check(dismissState.ariaExpanded === 'false', 'Close action leaves aria-expanded=true on a hidden popover');
      }
      await win.evaluate(() => window.hideUpdateBanner());
    }

    await win.evaluate(() => window.showTab('clips'));
    const clipContextLinks = win.locator('[data-context-for="clips"] .context-link');
    if (await clipContextLinks.count() >= 2) {
      await clipContextLinks.nth(1).click();
      await win.waitForTimeout(30);
      const contextNavigation = await win.evaluate(() => {
        const panel = document.querySelector('[data-context-for="clips"]');
        const links = [...(panel?.querySelectorAll('.context-link') || [])];
        return {
          activeCount: links.filter((link) => link.classList.contains('active')).length,
          currentCount: links.filter((link) => link.getAttribute('aria-current') === 'page').length,
          secondActive: links[1]?.classList.contains('active') || false,
          secondCurrent: links[1]?.getAttribute('aria-current') === 'page'
        };
      });
      checks.contextNavigation = contextNavigation;
      check(contextNavigation.activeCount === 1, `Context navigation exposes ${contextNavigation.activeCount} active items after a click`);
      check(contextNavigation.currentCount === 1, `Context navigation exposes ${contextNavigation.currentCount} aria-current items after a click`);
      check(contextNavigation.secondActive && contextNavigation.secondCurrent, 'Clicked context navigation item is not active and current');
    } else {
      check(false, 'Clip context navigation does not expose at least two items');
    }

    await win.evaluate(() => window.showTab('settings'));
    const settingsSearchExists = await win.locator('#settingsSearchInput').count() === 1;
    check(settingsSearchExists, 'Settings search input is missing');
    if (settingsSearchExists) {
      const beforeCount = await win.locator('#settingsTab .settings-card').evaluateAll((cards) => cards.filter((card) => {
        const style = getComputedStyle(card);
        return !card.hidden && style.display !== 'none' && style.visibility !== 'hidden';
      }).length);
      await win.locator('#settingsSearchInput').fill('download');
      await win.waitForTimeout(40);
      const filtered = await win.locator('#settingsTab .settings-card').evaluateAll((cards) => {
        const visible = cards.filter((card) => {
          const style = getComputedStyle(card);
          return !card.hidden && style.display !== 'none' && style.visibility !== 'hidden';
        });
        return {
          count: visible.length,
          headings: visible.map((card) => card.querySelector('h3')?.textContent?.trim() || '')
        };
      });
      await win.locator('#settingsSearchInput').fill('');
      await win.waitForTimeout(40);
      const restoredCount = await win.locator('#settingsTab .settings-card').evaluateAll((cards) => cards.filter((card) => {
        const style = getComputedStyle(card);
        return !card.hidden && style.display !== 'none' && style.visibility !== 'hidden';
      }).length);
      checks.settingsSearch = { beforeCount, filtered, restoredCount };
      check(filtered.count > 0, 'Settings search hides every settings card for a matching query');
      check(filtered.count < beforeCount, 'Settings search does not filter any settings cards');
      check(filtered.headings.some((heading) => /download/i.test(heading)), `Settings search has no matching Downloads card: ${filtered.headings.join(', ')}`);
      check(restoredCount === beforeCount, `Clearing settings search restores ${restoredCount} of ${beforeCount} cards`);
    }

    const dynamicQueue = await win.evaluate(() => {
      queue = [
        { id: 'pending-fixture', title: 'Pending fixture', url: 'https://example.invalid/pending', date: '2026-08-10T12:00:00Z', streamer: 'fixture', duration_str: '1h', status: 'pending', progress: 0 },
        { id: 'downloading-fixture', title: 'Downloading fixture', url: 'https://example.invalid/downloading', date: '2026-08-10T12:00:00Z', streamer: 'fixture', duration_str: '1h', status: 'downloading', progress: 42 },
        { id: 'completed-fixture', title: 'Completed fixture', url: 'https://example.invalid/completed', date: '2026-08-10T12:00:00Z', streamer: 'fixture', duration_str: '1h', status: 'completed', progress: 100 },
        { id: 'error-fixture', title: 'Error fixture', url: 'https://example.invalid/error', date: '2026-08-10T12:00:00Z', streamer: 'fixture', duration_str: '1h', status: 'error', progress: 0, last_error: 'Fixture failure' }
      ];
      renderQueue();
      return {
        rows: document.querySelectorAll('#queueList .queue-item').length,
        pending: document.querySelectorAll('#queueList .status.pending').length,
        downloading: document.querySelectorAll('#queueList .status.downloading').length,
        completed: document.querySelectorAll('#queueList .status.completed').length,
        error: document.querySelectorAll('#queueList .status.error').length,
        determinateProgress: document.querySelector('#queueList [data-id="downloading-fixture"] .queue-progress-wrap')?.getAttribute('aria-valuenow') || '',
        retryEnabled: document.getElementById('btnRetryFailed')?.disabled === false
      };
    });
    checks.dynamicQueue = dynamicQueue;
    check(dynamicQueue.rows === 4, `Dynamic queue fixture rendered ${dynamicQueue.rows} of 4 rows`);
    check(dynamicQueue.pending === 1 && dynamicQueue.downloading === 1 && dynamicQueue.completed === 1 && dynamicQueue.error === 1, 'Dynamic queue fixture does not expose all representative states');
    check(dynamicQueue.determinateProgress === '42', `Dynamic queue progress is ${dynamicQueue.determinateProgress} instead of 42`);
    check(dynamicQueue.retryEnabled, 'Dynamic queue error state does not enable Retry');

    await win.evaluate(() => {
      queue = [];
      renderQueue();
      renderVODs([{
        id: 'locale-fixture',
        title: 'Locale fixture',
        created_at: '2026-08-10T12:00:00Z',
        duration: '1h2m3s',
        thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        url: 'https://example.invalid/vod',
        view_count: 1234
      }], 'fixture');
    });

    await win.evaluate(() => window.changeLanguage('en'));
    await win.keyboard.press('Control+K');
    await win.waitForSelector('#commandPaletteModal.show');
    const englishPalette = await win.evaluate(() => ({
      labels: [...document.querySelectorAll('#commandPaletteList .cp-item-label')].map((item) => item.textContent?.trim() || ''),
      hints: [...document.querySelectorAll('#commandPaletteList .cp-item-hint')].map((item) => item.textContent?.trim() || '')
    }));
    await win.keyboard.press('Escape');
    await win.evaluate(() => window.showTab('archive'));
    const englishChrome = await win.evaluate(() => ({
      navSettings: document.getElementById('navSettingsText')?.textContent?.trim() || '',
      contextHeading: document.querySelector('[data-context-for="archive"] [data-context-heading]')?.textContent?.trim() || '',
      archiveResults: document.getElementById('archiveResultsNavText')?.textContent?.trim() || '',
      selectFolder: document.getElementById('selectFolderBtn')?.textContent?.trim() || '',
      later: document.getElementById('workspaceUpdateLater')?.textContent?.trim() || '',
      dismiss: document.getElementById('workspaceUpdateDismiss')?.textContent?.trim() || document.getElementById('workspaceUpdateDismiss')?.getAttribute('aria-label')?.trim() || '',
      mainNavigation: document.querySelector('.top-nav')?.getAttribute('aria-label') || '',
      workspaceContext: document.querySelector('.context-sidebar')?.getAttribute('aria-label') || '',
      vodWorkspace: document.querySelector('[data-context-for="vods"] .context-switcher')?.getAttribute('aria-label') || '',
      clipSections: document.querySelector('[data-context-for="clips"] .context-list')?.getAttribute('aria-label') || '',
      cutterSections: document.querySelector('[data-context-for="cutter"] .context-list')?.getAttribute('aria-label') || '',
      mergeSections: document.querySelector('[data-context-for="merge"] .context-list')?.getAttribute('aria-label') || '',
      statisticsSections: document.querySelector('[data-context-for="stats"] .context-list')?.getAttribute('aria-label') || '',
      archiveSections: document.querySelector('[data-context-for="archive"] .context-list')?.getAttribute('aria-label') || '',
      settingsSections: document.querySelector('[data-context-for="settings"] .context-list')?.getAttribute('aria-label') || '',
      cutVideo: document.querySelector('button[onclick="startCutting()"]')?.getAttribute('aria-label') || '',
      mergeVideos: document.querySelector('button[onclick="startMerging()"]')?.getAttribute('aria-label') || '',
      streamerWorkspaceSwitch: document.querySelector('.context-switcher button:first-child')?.textContent?.trim() || '',
      queueWorkspaceSwitch: document.querySelector('.context-switcher button:nth-child(2)')?.textContent?.trim() || '',
      commandTitle: document.getElementById('commandPaletteTitle')?.textContent?.trim() || '',
      commandPalette: document.getElementById('commandPaletteInput')?.getAttribute('aria-label') || '',
      commandResults: document.getElementById('commandPaletteList')?.getAttribute('aria-label') || ''
    }));
    await win.evaluate(() => window.showTab('vods'));
    const englishDate = await win.locator('.vod-card .vod-meta span').first().textContent();
    const expectedEnglishDate = await win.evaluate(() => new Date('2026-08-10T12:00:00Z').toLocaleDateString('en-US'));

    await win.evaluate(() => window.changeLanguage('de'));
    await win.keyboard.press('Control+K');
    await win.waitForSelector('#commandPaletteModal.show');
    const germanPalette = await win.evaluate(() => ({
      labels: [...document.querySelectorAll('#commandPaletteList .cp-item-label')].map((item) => item.textContent?.trim() || ''),
      hints: [...document.querySelectorAll('#commandPaletteList .cp-item-hint')].map((item) => item.textContent?.trim() || '')
    }));
    await win.keyboard.press('Escape');
    await win.evaluate(() => window.showTab('archive'));
    const germanChrome = await win.evaluate(() => ({
      navSettings: document.getElementById('navSettingsText')?.textContent?.trim() || '',
      contextHeading: document.querySelector('[data-context-for="archive"] [data-context-heading]')?.textContent?.trim() || '',
      archiveResults: document.getElementById('archiveResultsNavText')?.textContent?.trim() || '',
      selectFolder: document.getElementById('selectFolderBtn')?.textContent?.trim() || '',
      later: document.getElementById('workspaceUpdateLater')?.textContent?.trim() || '',
      dismiss: document.getElementById('workspaceUpdateDismiss')?.textContent?.trim() || document.getElementById('workspaceUpdateDismiss')?.getAttribute('aria-label')?.trim() || '',
      mainNavigation: document.querySelector('.top-nav')?.getAttribute('aria-label') || '',
      workspaceContext: document.querySelector('.context-sidebar')?.getAttribute('aria-label') || '',
      vodWorkspace: document.querySelector('[data-context-for="vods"] .context-switcher')?.getAttribute('aria-label') || '',
      clipSections: document.querySelector('[data-context-for="clips"] .context-list')?.getAttribute('aria-label') || '',
      cutterSections: document.querySelector('[data-context-for="cutter"] .context-list')?.getAttribute('aria-label') || '',
      mergeSections: document.querySelector('[data-context-for="merge"] .context-list')?.getAttribute('aria-label') || '',
      statisticsSections: document.querySelector('[data-context-for="stats"] .context-list')?.getAttribute('aria-label') || '',
      archiveSections: document.querySelector('[data-context-for="archive"] .context-list')?.getAttribute('aria-label') || '',
      settingsSections: document.querySelector('[data-context-for="settings"] .context-list')?.getAttribute('aria-label') || '',
      cutVideo: document.querySelector('button[onclick="startCutting()"]')?.getAttribute('aria-label') || '',
      mergeVideos: document.querySelector('button[onclick="startMerging()"]')?.getAttribute('aria-label') || '',
      streamerWorkspaceSwitch: document.querySelector('.context-switcher button:first-child')?.textContent?.trim() || '',
      queueWorkspaceSwitch: document.querySelector('.context-switcher button:nth-child(2)')?.textContent?.trim() || '',
      commandTitle: document.getElementById('commandPaletteTitle')?.textContent?.trim() || '',
      commandPalette: document.getElementById('commandPaletteInput')?.getAttribute('aria-label') || '',
      commandResults: document.getElementById('commandPaletteList')?.getAttribute('aria-label') || ''
    }));
    await win.evaluate(() => window.showTab('vods'));
    const germanDate = await win.locator('.vod-card .vod-meta span').first().textContent();
    const expectedGermanDate = await win.evaluate(() => new Date('2026-08-10T12:00:00Z').toLocaleDateString('de-DE'));
    checks.locale = { englishChrome, germanChrome, englishPalette, germanPalette, englishDate, expectedEnglishDate, germanDate, expectedGermanDate };
    check(englishChrome.navSettings === 'Settings', `English top navigation says "${englishChrome.navSettings}"`);
    check(englishChrome.contextHeading === 'Archive', `English context heading says "${englishChrome.contextHeading}"`);
    check(englishChrome.archiveResults === 'Results', `English archive context action says "${englishChrome.archiveResults}"`);
    check(/^later$/i.test(englishChrome.later), `English update Later action says "${englishChrome.later}"`);
    check(/^close$/i.test(englishChrome.dismiss), `English update Close action says "${englishChrome.dismiss}"`);
    check(englishChrome.mainNavigation === 'Main navigation', `English main navigation aria-label says "${englishChrome.mainNavigation}"`);
    check(englishChrome.workspaceContext === 'Workspace context', `English workspace context aria-label says "${englishChrome.workspaceContext}"`);
    check(englishChrome.vodWorkspace === 'VOD workspace', `English VOD workspace aria-label says "${englishChrome.vodWorkspace}"`);
    check(englishChrome.clipSections === 'Clip sections', `English clip sections aria-label says "${englishChrome.clipSections}"`);
    check(englishChrome.cutterSections === 'Video cutter sections', `English cutter sections aria-label says "${englishChrome.cutterSections}"`);
    check(englishChrome.mergeSections === 'Video merge sections', `English merge sections aria-label says "${englishChrome.mergeSections}"`);
    check(englishChrome.statisticsSections === 'Statistics sections', `English statistics sections aria-label says "${englishChrome.statisticsSections}"`);
    check(englishChrome.archiveSections === 'Archive sections', `English archive sections aria-label says "${englishChrome.archiveSections}"`);
    check(englishChrome.settingsSections === 'Settings sections', `English settings sections aria-label says "${englishChrome.settingsSections}"`);
    check(englishChrome.cutVideo === 'Cut video', `English cut action aria-label says "${englishChrome.cutVideo}"`);
    check(englishChrome.mergeVideos === 'Merge videos', `English merge action aria-label says "${englishChrome.mergeVideos}"`);
    check(englishChrome.streamerWorkspaceSwitch === 'Streamer', `English streamer workspace switch says "${englishChrome.streamerWorkspaceSwitch}"`);
    check(englishChrome.queueWorkspaceSwitch === 'Queue', `English queue workspace switch says "${englishChrome.queueWorkspaceSwitch}"`);
    check(JSON.stringify(englishPalette.labels) === JSON.stringify(['VODs', 'Clips', 'Video cutter', 'Merge videos', 'Statistics', 'Archive', 'Settings']), `English command palette labels are [${englishPalette.labels.join(', ')}]`);
    check(englishPalette.hints.length === 7 && englishPalette.hints.every((hint) => hint === 'Open'), `English command palette hints are [${englishPalette.hints.join(', ')}]`);
    check(englishChrome.commandTitle === 'Command palette', `English command palette title says "${englishChrome.commandTitle}"`);
    check(englishChrome.commandPalette === 'Command palette', `English command palette aria-label says "${englishChrome.commandPalette}"`);
    check(englishChrome.commandResults === 'Command results', `English command results aria-label says "${englishChrome.commandResults}"`);
    check(germanChrome.navSettings === 'Einstellungen', `German top navigation says "${germanChrome.navSettings}"`);
    check(germanChrome.contextHeading === 'Archiv', `German context heading says "${germanChrome.contextHeading}"`);
    check(/^Ergebnisse$/i.test(germanChrome.archiveResults), `German archive context action says "${germanChrome.archiveResults}"`);
    check(/^(Später|Spaeter)$/i.test(germanChrome.later), `German update Later action says "${germanChrome.later}"`);
    check(/^(Schließen|Schliessen)$/i.test(germanChrome.dismiss), `German update Close action says "${germanChrome.dismiss}"`);
    check(Boolean(englishChrome.selectFolder) && Boolean(germanChrome.selectFolder) && englishChrome.selectFolder !== germanChrome.selectFolder, 'Folder chooser action does not switch between English and German');
    check(germanChrome.mainNavigation === 'Hauptnavigation', `German main navigation aria-label says "${germanChrome.mainNavigation}"`);
    check(germanChrome.workspaceContext === 'Arbeitsbereichskontext', `German workspace context aria-label says "${germanChrome.workspaceContext}"`);
    check(germanChrome.vodWorkspace === 'VOD-Arbeitsbereich', `German VOD workspace aria-label says "${germanChrome.vodWorkspace}"`);
    check(germanChrome.clipSections === 'Clip-Bereiche', `German clip sections aria-label says "${germanChrome.clipSections}"`);
    check(germanChrome.cutterSections === 'Videoschnitt-Bereiche', `German cutter sections aria-label says "${germanChrome.cutterSections}"`);
    check(germanChrome.mergeSections === 'Zusammenfügen-Bereiche', `German merge sections aria-label says "${germanChrome.mergeSections}"`);
    check(germanChrome.statisticsSections === 'Statistik-Bereiche', `German statistics sections aria-label says "${germanChrome.statisticsSections}"`);
    check(germanChrome.archiveSections === 'Archiv-Bereiche', `German archive sections aria-label says "${germanChrome.archiveSections}"`);
    check(germanChrome.settingsSections === 'Einstellungsbereiche', `German settings sections aria-label says "${germanChrome.settingsSections}"`);
    check(germanChrome.cutVideo === 'Video schneiden', `German cut action aria-label says "${germanChrome.cutVideo}"`);
    check(germanChrome.mergeVideos === 'Videos zusammenfügen', `German merge action aria-label says "${germanChrome.mergeVideos}"`);
    check(germanChrome.streamerWorkspaceSwitch === 'Streamer', `German streamer workspace switch says "${germanChrome.streamerWorkspaceSwitch}"`);
    check(germanChrome.queueWorkspaceSwitch === 'Warteschlange', `German queue workspace switch says "${germanChrome.queueWorkspaceSwitch}"`);
    check(JSON.stringify(germanPalette.labels) === JSON.stringify(['VODs', 'Clips', 'Videoschnitt', 'Videos zusammenfügen', 'Statistiken', 'Archiv', 'Einstellungen']), `German command palette labels are [${germanPalette.labels.join(', ')}]`);
    check(germanPalette.hints.length === 7 && germanPalette.hints.every((hint) => hint === 'Öffnen'), `German command palette hints are [${germanPalette.hints.join(', ')}]`);
    check(germanChrome.commandTitle === 'Befehlspalette', `German command palette title says "${germanChrome.commandTitle}"`);
    check(germanChrome.commandPalette === 'Befehlspalette', `German command palette aria-label says "${germanChrome.commandPalette}"`);
    check(germanChrome.commandResults === 'Befehlsergebnisse', `German command results aria-label says "${germanChrome.commandResults}"`);
    check(englishDate === expectedEnglishDate, `English VOD date is "${englishDate}" instead of "${expectedEnglishDate}"`);
    check(germanDate === expectedGermanDate, `German VOD date is "${germanDate}" instead of "${expectedGermanDate}"`);

    await win.waitForFunction(() => !document.getElementById('btnStatsRefresh')?.disabled && !document.getElementById('btnArchiveSearch')?.disabled);
    await app.evaluate(({ ipcMain }) => {
      globalThis.__workspaceLocalizedErrorCalls = { stats: 0, archive: 0 };
      ipcMain.removeHandler('get-archive-stats');
      ipcMain.handle('get-archive-stats', () => {
        globalThis.__workspaceLocalizedErrorCalls.stats += 1;
        throw new Error('localized stats fixture');
      });
      ipcMain.removeHandler('search-archive');
      ipcMain.handle('search-archive', () => {
        globalThis.__workspaceLocalizedErrorCalls.archive += 1;
        throw new Error('localized archive fixture');
      });
    });
    const captureLocalizedErrors = async (language, statsPrefix, archivePrefix, expectedStatsCalls, expectedArchiveCalls) => {
      await win.evaluate((nextLanguage) => {
        window.changeLanguage(nextLanguage);
        window.showTab('stats');
      }, language);
      await win.waitForFunction((prefix) => document.getElementById('statsSummaryGrid')?.textContent?.trim().startsWith(prefix), statsPrefix);
      await win.waitForFunction(() => !document.getElementById('btnStatsRefresh')?.disabled);
      const statsCalls = await app.evaluate(() => globalThis.__workspaceLocalizedErrorCalls.stats);
      check(statsCalls === expectedStatsCalls, `${language} statistics error path made ${statsCalls} IPC calls instead of ${expectedStatsCalls}`);
      const stats = await win.locator('#statsSummaryGrid').textContent();
      await win.evaluate(() => window.showTab('archive'));
      await win.waitForFunction((prefix) => document.getElementById('archiveSearchSummary')?.textContent?.trim().startsWith(prefix), archivePrefix);
      await win.waitForFunction(() => !document.getElementById('btnArchiveSearch')?.disabled);
      const archiveCalls = await app.evaluate(() => globalThis.__workspaceLocalizedErrorCalls.archive);
      check(archiveCalls === expectedArchiveCalls, `${language} archive error path made ${archiveCalls} IPC calls instead of ${expectedArchiveCalls}`);
      const archive = await win.locator('#archiveSearchSummary').textContent();
      return { stats: stats?.trim() || '', archive: archive?.trim() || '' };
    };
    const localizedErrors = {
      english: await captureLocalizedErrors('en', 'Error:', 'Error:', 1, 1),
      german: await captureLocalizedErrors('de', 'Fehler:', 'Fehler:', 2, 2)
    };
    checks.localizedErrors = localizedErrors;
    check(localizedErrors.english.stats.startsWith('Error:'), `English statistics error says "${localizedErrors.english.stats}"`);
    check(localizedErrors.english.archive.startsWith('Error:'), `English archive error says "${localizedErrors.english.archive}"`);
    check(localizedErrors.german.stats.startsWith('Fehler:'), `German statistics error says "${localizedErrors.german.stats}"`);
    check(localizedErrors.german.archive.startsWith('Fehler:'), `German archive error says "${localizedErrors.german.archive}"`);

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('get-archive-stats');
      ipcMain.handle('get-archive-stats', () => ({
        totalFiles: 0,
        totalBytes: 0,
        liveCount: 0,
        liveBytes: 0,
        vodCount: 0,
        vodBytes: 0,
        chatCount: 0,
        chatBytes: 0,
        eventsCount: 0,
        streamerCount: 0,
        avgRecordingSizeBytes: 0,
        topStreamers: [],
        dailyActivity: [],
        sizeBuckets: [],
        scannedAt: '2026-08-10T12:00:00Z',
        downloadPath: '',
        rootExists: true
      }));
      ipcMain.removeHandler('search-archive');
      ipcMain.handle('search-archive', () => ({
        rootExists: true,
        totalScanned: 0,
        matchCount: 0,
        truncated: false,
        hits: []
      }));
    });

    await win.evaluate(() => window.changeLanguage('en'));
    await win.setViewportSize(TARGETS[0]);
    await win.evaluate(() => window.showTab('vods'));
    await win.waitForTimeout(160);
    await win.screenshot({
      path: path.join(artifactDir, `workspace-vods-fixture-${TARGETS[0].width}x${TARGETS[0].height}.png`),
      fullPage: true
    });
    await win.evaluate(() => {
      vodRenderTaskId += 1;
      lastLoadedVods = [];
      lastLoadedStreamer = null;
      setVodGridEmptyState(document.getElementById('vodGrid'), UI_TEXT.vods.noneTitle, UI_TEXT.vods.noneText);
      updateVodFilterCount(0, 0);
    });
    await win.evaluate(() => window.showTab('settings'));

    const captureTheme = async () => win.evaluate(() => {
      const parse = (value) => {
        const parts = value.match(/[\d.]+/g)?.map(Number) || [];
        return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts.length > 3 ? parts[3] : 1 };
      };
      const linear = (channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (color) => 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
      const contrast = (foreground, background) => {
        const lighter = Math.max(luminance(foreground), luminance(background));
        const darker = Math.min(luminance(foreground), luminance(background));
        return (lighter + 0.05) / (darker + 0.05);
      };
      const effectiveBackground = (element) => {
        let current = element;
        while (current) {
          const value = getComputedStyle(current).backgroundColor;
          if (parse(value).a > 0) return value;
          current = current.parentElement;
        }
        return 'rgb(255, 255, 255)';
      };
      const pair = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const foreground = getComputedStyle(element).color;
        const background = effectiveBackground(element);
        return { foreground, background, contrast: contrast(parse(foreground), parse(background)) };
      };
      return {
        bodyClass: document.body.className,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
        title: pair('#pageTitle'),
        contextHeading: pair('[data-context-for="settings"] [data-context-heading]'),
        settingsSearch: pair('#settingsSearchInput'),
        toolbarAction: pair('#toolbarCheckUpdateBtn')
      };
    });

    await win.emulateMedia({ colorScheme: 'dark' });
    await win.locator('#workspaceThemePicker [data-theme="twitch"]').click();
    await win.waitForTimeout(160);
    const darkTheme = await captureTheme();
    await win.locator('#workspaceThemePicker [data-theme="light"]').click();
    await win.waitForTimeout(160);
    const lightTheme = await captureTheme();
    await win.emulateMedia({ colorScheme: 'light' });
    await win.locator('#workspaceThemePicker [data-theme="system"]').click();
    await win.waitForTimeout(160);
    const systemLightTheme = await captureTheme();
    checks.themes = { darkTheme, lightTheme, systemLightTheme };

    for (const [name, theme] of Object.entries({ dark: darkTheme, light: lightTheme, systemLight: systemLightTheme })) {
      check(Boolean(theme.title && theme.contextHeading && theme.settingsSearch && theme.toolbarAction), `${name} theme is missing a representative computed-style target`);
      for (const [pairName, pair] of Object.entries({ title: theme.title, contextHeading: theme.contextHeading, settingsSearch: theme.settingsSearch, toolbarAction: theme.toolbarAction })) {
        if (pair) check(pair.contrast >= 4.5, `${name} ${pairName} contrast is ${pair.contrast.toFixed(2)}:1`);
      }
    }
    check(darkTheme.bodyClass === 'theme-twitch', `Dark theme body class is ${darkTheme.bodyClass}`);
    check(lightTheme.bodyClass === 'theme-light', `Light theme body class is ${lightTheme.bodyClass}`);
    check(systemLightTheme.bodyClass === 'theme-system', `System theme body class is ${systemLightTheme.bodyClass}`);
    check(darkTheme.bodyBackground !== lightTheme.bodyBackground, 'Explicit Dark and Light themes compute the same body background');
    check(systemLightTheme.bodyBackground === lightTheme.bodyBackground, `System-Light background ${systemLightTheme.bodyBackground} does not match Light ${lightTheme.bodyBackground}`);
    check(systemLightTheme.bodyColor === lightTheme.bodyColor, `System-Light text ${systemLightTheme.bodyColor} does not match Light ${lightTheme.bodyColor}`);

    await win.screenshot({
      path: path.join(artifactDir, `workspace-settings-system-light-${TARGETS[0].width}x${TARGETS[0].height}.png`),
      fullPage: true
    });
    await win.locator('#workspaceThemePicker [data-theme="light"]').click();
    await win.waitForTimeout(160);
    await win.screenshot({
      path: path.join(artifactDir, `workspace-settings-light-${TARGETS[0].width}x${TARGETS[0].height}.png`),
      fullPage: true
    });
    await win.emulateMedia({ colorScheme: 'dark' });
    await win.locator('#workspaceThemePicker [data-theme="twitch"]').click();
    const finalScreenshotTheme = await win.evaluate(() => ({
      bodyClass: document.body.className,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      vodFixtureCards: document.querySelectorAll('#vodGrid .vod-card').length
    }));
    checks.finalScreenshotTheme = finalScreenshotTheme;
    check(finalScreenshotTheme.bodyClass === 'theme-twitch', `Canonical screenshots use ${finalScreenshotTheme.bodyClass} instead of Dark`);
    check(finalScreenshotTheme.bodyBackground === darkTheme.bodyBackground, `Canonical screenshot background ${finalScreenshotTheme.bodyBackground} does not match Dark ${darkTheme.bodyBackground}`);
    check(finalScreenshotTheme.vodFixtureCards === 0, `Canonical screenshots retain ${finalScreenshotTheme.vodFixtureCards} VOD fixture cards`);

    await win.evaluate(() => window.setUpdateBannerAvailableUi({ version: '9.9.9' }));
    await win.locator('#workspaceUpdateButton').hover();
    await win.waitForFunction(() => {
      const popover = document.getElementById('workspaceUpdatePopover');
      const style = popover ? getComputedStyle(popover) : null;
      return Boolean(style && style.visibility === 'visible' && Number(style.opacity) > 0);
    });
    const updateScreenshotState = await win.evaluate(() => ({
      bodyClass: document.body.className,
      state: document.getElementById('updateBanner')?.dataset.updateState || '',
      laterVisible: document.getElementById('workspaceUpdateLater')?.hidden === false,
      dismissVisible: document.getElementById('workspaceUpdateDismiss')?.hidden === false
    }));
    checks.updateScreenshotState = updateScreenshotState;
    check(updateScreenshotState.bodyClass === 'theme-twitch', `Update screenshot uses ${updateScreenshotState.bodyClass} instead of Dark`);
    check(updateScreenshotState.state === 'available', `Update screenshot uses ${updateScreenshotState.state} instead of available state`);
    check(updateScreenshotState.laterVisible && updateScreenshotState.dismissVisible, 'Update screenshot does not expose both Later and Close');
    await win.waitForTimeout(160);
    await win.screenshot({
      path: path.join(artifactDir, `workspace-update-${TARGETS[0].width}x${TARGETS[0].height}.png`),
      fullPage: true
    });
    await win.mouse.move(Math.floor(TARGETS[0].width / 2), Math.floor(TARGETS[0].height / 2));
    await win.evaluate(() => window.hideUpdateBanner());

    const responsiveQueueFixtures = [
      { id: 'responsive-pending', title: 'Responsive pending fixture with a deliberately long title that must remain contained inside the queue row', url: 'https://example.invalid/responsive-pending', date: '2026-08-10T12:00:00Z', streamer: 'fixture_streamer', duration_str: '12h34m56s', status: 'pending', progress: 0 },
      { id: 'responsive-downloading', title: 'Responsive downloading fixture with a deliberately long title that must not widen the workspace', url: 'https://example.invalid/responsive-downloading', date: '2026-08-10T12:00:00Z', streamer: 'fixture_streamer', duration_str: '12h34m56s', status: 'downloading', progress: 67 },
      { id: 'responsive-completed', title: 'Responsive completed fixture with a deliberately long title for overflow coverage', url: 'https://example.invalid/responsive-completed', date: '2026-08-10T12:00:00Z', streamer: 'fixture_streamer', duration_str: '12h34m56s', status: 'completed', progress: 100 },
      { id: 'responsive-error', title: 'Responsive error fixture with a deliberately long title and representative failure state', url: 'https://example.invalid/responsive-error', date: '2026-08-10T12:00:00Z', streamer: 'fixture_streamer', duration_str: '12h34m56s', status: 'error', progress: 0, last_error: 'Offline responsive fixture failure' }
    ];
    await app.evaluate(({ ipcMain }, queueFixtures) => {
      globalThis.__workspaceResponsiveQueueSyncCalls = 0;
      ipcMain.removeHandler('get-queue');
      ipcMain.handle('get-queue', () => {
        globalThis.__workspaceResponsiveQueueSyncCalls += 1;
        return queueFixtures.map((item) => ({ ...item }));
      });
    }, responsiveQueueFixtures);
    await win.evaluate((queueFixtures) => {
      const vodFixtures = [
        { id: 'responsive-vod-one', title: 'Responsive VOD fixture with a deliberately long title that must stay inside its card at every supported width', created_at: '2026-08-10T12:00:00Z', duration: '12h34m56s', thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', url: 'https://example.invalid/responsive-vod-one', view_count: 987654 },
        { id: 'responsive-vod-two', title: 'Second responsive VOD fixture covering multi-card layout and long metadata without horizontal overflow', created_at: '2026-08-09T12:00:00Z', duration: '9h8m7s', thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', url: 'https://example.invalid/responsive-vod-two', view_count: 123456 }
      ];
      window.__restoreResponsiveFixtures = () => {
        queue = queueFixtures.map((item) => ({ ...item }));
        renderQueue();
        renderVODs(vodFixtures.map((item) => ({ ...item })), 'fixture_streamer');
      };
      window.__restoreResponsiveFixtures();
    }, responsiveQueueFixtures);
    await win.evaluate(() => syncQueueAndDownloadState());
    const responsiveQueueSyncCalls = await app.evaluate(() => globalThis.__workspaceResponsiveQueueSyncCalls);
    const responsiveFixtures = await win.evaluate(() => {
      return {
        queueRows: document.querySelectorAll('#queueList .queue-item').length,
        vodCards: document.querySelectorAll('#vodGrid .vod-card').length
      };
    });
    checks.responsiveFixtures = { ...responsiveFixtures, syncCalls: responsiveQueueSyncCalls };
    check(responsiveQueueSyncCalls >= 1, 'Responsive queue fixtures were not observed through the queue sync IPC path');
    check(responsiveFixtures.queueRows === 4, `Responsive fixture rendered ${responsiveFixtures.queueRows} queue rows instead of 4`);
    check(responsiveFixtures.vodCards === 2, `Responsive fixture rendered ${responsiveFixtures.vodCards} VOD cards instead of 2`);

    const responsiveTabs = {};
    for (const target of TARGETS) {
      await win.setViewportSize(target);
      await win.evaluate(() => window.__restoreResponsiveFixtures());
      await win.waitForTimeout(50);
      responsiveTabs[`${target.width}x${target.height}`] = {};
      for (const tab of TABS) {
        await win.evaluate((tabId) => window.showTab(tabId), tab);
        await win.waitForTimeout(160);
        const state = await win.evaluate((tabId) => {
          const isVisible = (element) => {
            if (!element || element.hidden) return false;
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
          };
          const navItem = document.querySelector(`.top-nav button[data-tab="${tabId}"]`);
          const contextPanels = [...document.querySelectorAll('[data-context-for]')].filter(isVisible);
          const toolbars = [...document.querySelectorAll('[data-toolbar-for]')].filter(isVisible);
          const tabContents = [...document.querySelectorAll('.tab-content')].filter(isVisible);
          return {
            current: navItem?.getAttribute('aria-current') === 'page',
            contextPanels: contextPanels.map((panel) => panel.dataset.contextFor || ''),
            toolbars: toolbars.map((toolbar) => toolbar.dataset.toolbarFor || ''),
            tabContents: tabContents.map((content) => content.id || ''),
            viewportWidth: document.documentElement.clientWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            bodyScrollWidth: document.body.scrollWidth,
            workspaceScrollWidth: document.querySelector('.workspace-shell')?.scrollWidth || 0,
            workspaceClientWidth: document.querySelector('.workspace-shell')?.clientWidth || 0,
            queueRows: document.querySelectorAll('#queueList .queue-item').length,
            vodCards: document.querySelectorAll('#vodGrid .vod-card').length
          };
        }, tab);
        responsiveTabs[`${target.width}x${target.height}`][tab] = state;
        check(state.current, `${tab} is not current at ${target.width}x${target.height}`);
        check(state.contextPanels.length === 1 && state.contextPanels[0] === tab, `${tab} exposes context panels [${state.contextPanels.join(', ')}] at ${target.width}x${target.height}`);
        check(state.toolbars.length === 1 && state.toolbars[0] === tab, `${tab} exposes toolbars [${state.toolbars.join(', ')}] at ${target.width}x${target.height}`);
        check(state.tabContents.length === 1 && state.tabContents[0] === `${tab}Tab`, `${tab} exposes tab contents [${state.tabContents.join(', ')}] at ${target.width}x${target.height}`);
        check(state.documentScrollWidth <= state.viewportWidth + 1, `${tab} document overflows horizontally at ${target.width}x${target.height}`);
        check(state.bodyScrollWidth <= state.viewportWidth + 1, `${tab} body overflows horizontally at ${target.width}x${target.height}`);
        check(state.workspaceScrollWidth <= state.workspaceClientWidth + 1, `${tab} workspace overflows horizontally at ${target.width}x${target.height}`);
        if (tab === 'vods') {
          check(state.queueRows === 4, `VOD workspace lost responsive queue fixtures at ${target.width}x${target.height}`);
          check(state.vodCards === 2, `VOD workspace lost responsive VOD fixtures at ${target.width}x${target.height}`);
        }

        if (target.width === TARGETS[0].width) {
          await win.screenshot({
            path: path.join(artifactDir, `workspace-${tab}-${target.width}x${target.height}.png`),
            fullPage: true
          });
        }
      }

      const geometry = await win.evaluate(() => {
        const topbar = document.querySelector('.app-topbar')?.getBoundingClientRect();
        const sidebar = document.querySelector('.context-sidebar')?.getBoundingClientRect();
        const toolbar = document.querySelector('.workspace-toolbar')?.getBoundingClientRect();
        const updateButton = document.getElementById('workspaceUpdateButton')?.getBoundingClientRect();
        return {
          topbarHeight: topbar?.height || 0,
          sidebarWidth: sidebar?.width || 0,
          toolbarHeight: toolbar?.height || 0,
          updateVisible: Boolean(updateButton && updateButton.width > 0 && updateButton.height > 0)
        };
      });
      responsiveTabs[`${target.width}x${target.height}`].geometry = geometry;
      check(geometry.topbarHeight >= 39 && geometry.topbarHeight <= 41, `Topbar height is ${geometry.topbarHeight}px at ${target.width}x${target.height}`);
      check(geometry.sidebarWidth >= 260 && geometry.sidebarWidth <= 272, `Context sidebar width is ${geometry.sidebarWidth}px at ${target.width}x${target.height}`);
      check(geometry.toolbarHeight >= 59 && geometry.toolbarHeight <= 61, `Workspace toolbar height is ${geometry.toolbarHeight}px at ${target.width}x${target.height}`);
      check(geometry.updateVisible, `Update action is not visible at ${target.width}x${target.height}`);
      await win.screenshot({
        path: path.join(artifactDir, `workspace-${target.width}x${target.height}.png`),
        fullPage: true
      });
    }
    checks.responsiveTabs = responsiveTabs;

    await app.evaluate(({ ipcMain }) => {
      globalThis.__workspaceClipIpcState = { calls: 0, resolve: null };
      globalThis.__workspaceStatsIpcState = { calls: 0, resolve: null };
      ipcMain.removeHandler('download-clip');
      ipcMain.handle('download-clip', () => {
        globalThis.__workspaceClipIpcState.calls += 1;
        return new Promise((resolve) => {
          globalThis.__workspaceClipIpcState.resolve = resolve;
        });
      });
      ipcMain.removeHandler('get-archive-stats');
      ipcMain.handle('get-archive-stats', () => {
        globalThis.__workspaceStatsIpcState.calls += 1;
        return new Promise((resolve) => {
          globalThis.__workspaceStatsIpcState.resolve = resolve;
        });
      });
    });

    await win.evaluate(() => {
      document.getElementById('clipUrl').value = 'https://clips.twitch.tv/ContractFixture';
      document.getElementById('btnClip').click();
      void window.downloadClip();
      document.getElementById('toolbarClipDownloadBtn').click();
    });
    await win.waitForFunction(() => document.getElementById('btnClip')?.disabled && document.getElementById('toolbarClipDownloadBtn')?.disabled);
    const clipPending = await win.evaluate(() => ({
      mainDisabled: document.getElementById('btnClip')?.disabled === true,
      toolbarDisabled: document.getElementById('toolbarClipDownloadBtn')?.disabled === true
    }));
    const clipIpcCalls = await app.evaluate(() => globalThis.__workspaceClipIpcState.calls);
    checks.clipConcurrency = { ...clipPending, ipcCalls: clipIpcCalls };
    check(clipIpcCalls === 1, `Parallel downloadClip activation produced ${clipIpcCalls} IPC calls instead of one`);
    check(clipPending.mainDisabled && clipPending.toolbarDisabled, 'Clip main and toolbar triggers are not both disabled while the IPC call is pending');
    await app.evaluate(() => globalThis.__workspaceClipIpcState.resolve({ success: true }));
    await win.waitForFunction(() => !document.getElementById('btnClip')?.disabled && !document.getElementById('toolbarClipDownloadBtn')?.disabled);

    await win.evaluate(() => {
      document.getElementById('btnStatsRefresh').click();
      void window.refreshArchiveStats();
      document.getElementById('toolbarStatsRefreshBtn').click();
    });
    await win.waitForFunction(() => document.getElementById('btnStatsRefresh')?.disabled && document.getElementById('toolbarStatsRefreshBtn')?.disabled);
    const statsPending = await win.evaluate(() => ({
      mainDisabled: document.getElementById('btnStatsRefresh')?.disabled === true,
      toolbarDisabled: document.getElementById('toolbarStatsRefreshBtn')?.disabled === true
    }));
    const statsIpcCalls = await app.evaluate(() => globalThis.__workspaceStatsIpcState.calls);
    checks.statsConcurrency = { ...statsPending, ipcCalls: statsIpcCalls };
    check(statsIpcCalls === 1, `Parallel refreshArchiveStats activation produced ${statsIpcCalls} IPC calls instead of one`);
    check(statsPending.mainDisabled && statsPending.toolbarDisabled, 'Statistics main and toolbar triggers are not both disabled while the IPC call is pending');
    await app.evaluate(() => globalThis.__workspaceStatsIpcState.resolve({
      totalFiles: 0,
      totalBytes: 0,
      liveCount: 0,
      liveBytes: 0,
      vodCount: 0,
      vodBytes: 0,
      chatCount: 0,
      chatBytes: 0,
      eventsCount: 0,
      streamerCount: 0,
      avgRecordingSizeBytes: 0,
      topStreamers: [],
      dailyActivity: [],
      sizeBuckets: [],
      scannedAt: new Date().toISOString(),
      downloadPath: '',
      rootExists: true
    }));
    await win.waitForFunction(() => !document.getElementById('btnStatsRefresh')?.disabled && !document.getElementById('toolbarStatsRefreshBtn')?.disabled);
  } finally {
    if (app) await app.close();
    cleanupE2eEnvironment(environment);
  }

  const result = { checks, failures, runtimeIssues };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = failures.length || runtimeIssues.length ? 1 : 0;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const { _electron: electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TARGETS = [
  { width: 2048, height: 1094 },
  { width: 1600, height: 900 },
  { width: 1280, height: 800 }
];

const TABS = ['vods', 'clips', 'cutter', 'merge', 'stats', 'archive', 'settings'];

async function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-ui-contract-'));
  const tempProgramData = path.join(tempRoot, 'programdata');
  const tempUserData = path.join(tempRoot, 'userdata');
  const tempDownloadPath = path.join(tempRoot, 'downloads');
  const tempAppData = path.join(tempProgramData, 'Twitch_VOD_Manager');
  fs.mkdirSync(tempProgramData, { recursive: true });
  fs.mkdirSync(tempUserData, { recursive: true });
  fs.mkdirSync(tempDownloadPath, { recursive: true });
  fs.mkdirSync(tempAppData, { recursive: true });
  fs.writeFileSync(path.join(tempAppData, 'config.json'), JSON.stringify({
    download_path: tempDownloadPath,
    streamers: [],
    language: 'en',
    theme: 'twitch'
  }));
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
    app = await electron.launch({
      executablePath: require('electron'),
      args: [`--user-data-dir=${tempUserData}`, '.'],
      cwd: process.cwd(),
      env: { ...process.env, PROGRAMDATA: tempProgramData }
    });

    const win = await app.firstWindow();
    const actualUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    const runtimeConfig = await win.evaluate(() => window.api.getConfig());
    checks.dataIsolation = {
      expectedUserData: tempUserData,
      actualUserData,
      expectedDownloadPath: tempDownloadPath,
      actualDownloadPath: runtimeConfig.download_path
    };
    check(path.resolve(actualUserData) === path.resolve(tempUserData), 'Electron userData is not isolated from the regular application profile');
    check(path.resolve(runtimeConfig.download_path) === path.resolve(tempDownloadPath), 'Workspace content is not isolated from the regular download folder');
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
      topNavigationItems: document.querySelectorAll('.top-nav [data-tab]').length
    }));
    checks.shell = shell;

    check(shell.topbar, 'The persistent application topbar is missing');
    check(shell.topNavigation, 'The primary icon navigation is missing');
    check(shell.workspace, 'The workspace shell is missing');
    check(shell.contextSidebar, 'The contextual sidebar is missing');
    check(shell.workspaceMain, 'The workspace main region is missing');
    check(shell.toolbar, 'The workspace toolbar is missing');
    check(shell.updateButton, 'The persistent update action is missing');
    check(shell.topNavigationItems === 7, `Expected 7 primary navigation items, found ${shell.topNavigationItems}`);

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
          disabled: document.getElementById('workspaceUpdateButton')?.disabled || false
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
      check(updaterStates.downloading.disabled, 'Update action remains enabled while downloading');
      check(updaterStates.ready.state === 'ready', 'Ready-to-install state is not reflected in the topbar');
      check(updaterStates.ready.description.includes('9.9.9'), 'Ready update version is not announced');
      check(updaterStates.idle.state === 'idle', 'Idle update state is not restored in the topbar');
      check(!updaterStates.idle.description.includes('9.9.9'), 'Idle update state keeps stale release information');
      check(updaterStates.idle.description === updaterStates.idle.checkLabel, 'Idle update tooltip does not describe the available action');
    }

    if (shell.topNavigation && shell.workspace) {
      await win.setViewportSize(TARGETS[0]);
      const tabChecks = {};
      for (const tab of TABS) {
        const button = win.locator(`.top-nav [data-tab="${tab}"]`);
        await button.focus();
        await button.press('Enter');
        await win.waitForTimeout(50);

        const state = await win.evaluate((tabId) => {
          const navItem = document.querySelector(`.top-nav [data-tab="${tabId}"]`);
          const content = document.getElementById(`${tabId}Tab`);
          const context = document.querySelector(`[data-context-for="${tabId}"]`);
          const title = document.getElementById('pageTitle');
          return {
            current: navItem?.getAttribute('aria-current') === 'page',
            contentVisible: Boolean(content?.classList.contains('active')),
            contextVisible: Boolean(context && !context.hidden),
            title: title?.textContent?.trim() || '',
            focused: document.activeElement === navItem
          };
        }, tab);

        tabChecks[tab] = state;
        check(state.current, `Primary navigation does not mark ${tab} as current`);
        check(state.contentVisible, `The ${tab} workspace is not visible after activation`);
        check(state.contextVisible, `The ${tab} contextual sidebar is not visible after activation`);
        check(Boolean(state.title), `The ${tab} workspace title is empty`);
        check(state.focused, `Keyboard focus was lost while activating ${tab}`);

        await win.screenshot({
          path: path.join(artifactDir, `workspace-${tab}-${TARGETS[0].width}x${TARGETS[0].height}.png`),
          fullPage: true
        });
      }
      checks.tabs = tabChecks;

      const themePicker = win.locator('#workspaceThemePicker [data-theme]');
      const themeCount = await themePicker.count();
      check(themeCount === 3, `Expected 3 workspace theme choices, found ${themeCount}`);
      if (themeCount === 3) {
        await win.locator('#workspaceThemePicker [data-theme="light"]').click();
        const lightTheme = await win.evaluate(() => ({
          bodyClass: document.body.className,
          selected: document.getElementById('themeSelect')?.value || '',
          pressed: document.querySelector('#workspaceThemePicker [data-theme="light"]')?.getAttribute('aria-pressed')
        }));
        check(lightTheme.bodyClass === 'theme-light', 'Light theme choice does not update the application theme');
        check(lightTheme.selected === 'light', 'Light theme choice does not update the settings value');
        check(lightTheme.pressed === 'true', 'Light theme choice is not exposed as selected');

        await win.locator('#workspaceThemePicker [data-theme="system"]').click();
        const systemTheme = await win.evaluate(() => ({
          bodyClass: document.body.className,
          selected: document.getElementById('themeSelect')?.value || '',
          pressed: document.querySelector('#workspaceThemePicker [data-theme="system"]')?.getAttribute('aria-pressed')
        }));
        check(systemTheme.bodyClass === 'theme-system', 'System theme choice does not update the application theme');
        check(systemTheme.selected === 'system', 'System theme choice does not update the settings value');
        check(systemTheme.pressed === 'true', 'System theme choice is not exposed as selected');

        await win.locator('#workspaceThemePicker [data-theme="twitch"]').click();
      }

      await win.evaluate(() => window.setUpdateBannerAvailableUi({ version: '9.9.9' }));
      await win.locator('#workspaceUpdateButton').hover();
      await win.waitForTimeout(100);
      await win.screenshot({
        path: path.join(artifactDir, `workspace-update-${TARGETS[0].width}x${TARGETS[0].height}.png`),
        fullPage: true
      });
      await win.evaluate(() => window.hideUpdateBanner());
    }

    const targetChecks = [];
    for (const target of TARGETS) {
      await win.setViewportSize(target);
      await win.waitForTimeout(100);
      const geometry = await win.evaluate(() => {
        const topbar = document.querySelector('.app-topbar')?.getBoundingClientRect();
        const sidebar = document.querySelector('.context-sidebar')?.getBoundingClientRect();
        const toolbar = document.querySelector('.workspace-toolbar')?.getBoundingClientRect();
        const updateButton = document.getElementById('workspaceUpdateButton')?.getBoundingClientRect();
        return {
          viewportWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          topbarHeight: topbar?.height || 0,
          sidebarWidth: sidebar?.width || 0,
          toolbarHeight: toolbar?.height || 0,
          updateVisible: Boolean(updateButton && updateButton.width > 0 && updateButton.height > 0)
        };
      });

      targetChecks.push({ ...target, ...geometry });
      check(geometry.scrollWidth <= geometry.viewportWidth + 1, `Horizontal overflow at ${target.width}x${target.height}`);
      check(geometry.topbarHeight >= 39 && geometry.topbarHeight <= 41, `Topbar height is ${geometry.topbarHeight}px at ${target.width}x${target.height}`);
      check(geometry.sidebarWidth >= 260 && geometry.sidebarWidth <= 272, `Context sidebar width is ${geometry.sidebarWidth}px at ${target.width}x${target.height}`);
      check(geometry.toolbarHeight >= 59 && geometry.toolbarHeight <= 61, `Workspace toolbar height is ${geometry.toolbarHeight}px at ${target.width}x${target.height}`);
      check(geometry.updateVisible, `Update action is not visible at ${target.width}x${target.height}`);

      await win.screenshot({
        path: path.join(artifactDir, `workspace-${target.width}x${target.height}.png`),
        fullPage: true
      });
    }
    checks.targets = targetChecks;
  } finally {
    if (app) await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const result = { checks, failures, runtimeIssues };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = failures.length || runtimeIssues.length ? 1 : 0;
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

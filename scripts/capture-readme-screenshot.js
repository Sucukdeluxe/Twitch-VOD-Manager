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

async function run() {
  const environment = createE2eEnvironment('readme-screenshot', {
    language: 'en',
    theme: 'twitch',
    sidebar_split_view: true
  });
  const outputPath = path.resolve('docs', 'images', 'twitch-vod-manager-overview.png');
  let app;

  try {
    app = await electron.launch(getElectronLaunchOptions(environment));
    const win = await app.firstWindow();
    await verifyE2eIsolation(app, win, environment);
    await installOfflineFixtures(app);
    await app.evaluate(({ ipcMain }) => {
      const image = (label, from, to) => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="520" cy="80" r="110" fill="rgba(255,255,255,.09)"/><circle cx="100" cy="320" r="170" fill="rgba(0,0,0,.12)"/><text x="34" y="300" fill="white" font-family="Segoe UI,Arial" font-size="34" font-weight="700">${label}</text></svg>`;
        return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      };
      const vods = [
        ['Ranked highlights and community games', '5h13m20s', 155331, '#6441a5', '#1f7ae0'],
        ['Late night challenge run', '7h39m0s', 241394, '#172554', '#7c3aed'],
        ['Tournament watch party', '5h59m10s', 183557, '#0f766e', '#2563eb'],
        ['Creative stream and Q&A', '3h40m3s', 94821, '#7c2d12', '#db2777'],
        ['Weekend co-op session', '4h50m0s', 127644, '#1e3a8a', '#0891b2'],
        ['Best moments from the week', '2h54m23s', 119663, '#581c87', '#be123c']
      ].map(([title, duration, viewCount, from, to], index) => ({
        id: `demo-vod-${index + 1}`,
        title,
        created_at: `2026-08-${String(9 - index).padStart(2, '0')}T18:00:00Z`,
        duration,
        thumbnail_url: image(`DEMO VOD ${index + 1}`, from, to),
        url: `https://www.twitch.tv/videos/demo-${index + 1}`,
        view_count: viewCount,
        stream_id: `demo-stream-${index + 1}`
      }));
      ipcMain.removeHandler('get-user-id');
      ipcMain.handle('get-user-id', async () => 'demo-user');
      ipcMain.removeHandler('get-vods');
      ipcMain.handle('get-vods', async () => vods);
      ipcMain.removeHandler('get-streamer-profile');
      ipcMain.handle('get-streamer-profile', async () => ({
        login: 'demo_channel',
        displayName: 'DemoChannel',
        avatarUrl: image('TVM', '#7c3aed', '#0ea5e9'),
        bannerUrl: '',
        description: 'Example profile for the public product screenshot',
        broadcasterType: 'partner',
        followerCount: 1250000,
        vodCount: vods.length,
        lastStreamAt: '2026-08-09T18:00:00Z',
        isLive: false,
        currentTitle: null,
        currentGame: null,
        currentStreamPreviewUrl: '',
        currentStreamViewers: null,
        twitchUrl: 'https://www.twitch.tv/demo_channel',
        fetchedAt: Date.now()
      }));
      ipcMain.removeHandler('get-streamer-display-names');
      ipcMain.handle('get-streamer-display-names', async () => ({ demo_channel: 'DemoChannel' }));
    });
    await win.waitForFunction(() => typeof window.showTab === 'function');
    await win.setViewportSize({ width: 1600, height: 900 });
    await win.evaluate(async () => {
      window.changeLanguage('en');
      showTab('vods');
      isConnected = true;
      config.streamers = ['demo_channel'];
      config.streamer_display_names = { demo_channel: 'DemoChannel' };
      config.sidebar_split_view = true;
      streamerVodCache.clear();
      streamerProfileCache.clear();
      await window.hydrateStreamerDisplayNames();
      await selectStreamer('demo_channel');
    });
    await win.waitForTimeout(700);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await win.screenshot({ path: outputPath, type: 'png' });
    process.stdout.write(`${outputPath}\n`);
  } finally {
    if (app) await app.close();
    cleanupE2eEnvironment(environment);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

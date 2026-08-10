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

async function fetchImageDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image request failed with ${response.status}`);
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const bytes = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${bytes.toString('base64')}`;
}

async function run() {
  const environment = createE2eEnvironment('readme-screenshot', {
    language: 'en',
    theme: 'twitch',
    sidebar_split_view: true
  });
  const outputPath = path.resolve('docs', 'images', 'twitch-vod-manager-overview.png');
  let app;

  try {
    const publicImages = await Promise.all([
      'https://static-cdn.jtvnw.net/jtv_user_pictures/xqc-profile_image-9298dca608632101-150x150.jpeg',
      'https://static-cdn.jtvnw.net/cf_vods/d1m7jfoe9zdc1j/73cded95867be2fe9ed5_xqc_320952179547_1786313143//thumb/thumb0-640x360.jpg',
      'https://static-cdn.jtvnw.net/cf_vods/d2vi6trrdongqn/a50a886595e03e3ef6ea_xqc_319796892764_1786132273//thumb/thumb0-640x360.jpg',
      'https://static-cdn.jtvnw.net/cf_vods/d2vi6trrdongqn/94030284cfbb93ede7b8_xqc_319780491228_1786042905//thumb/thumb0-640x360.jpg',
      'https://static-cdn.jtvnw.net/cf_vods/d1m7jfoe9zdc1j/f7d01c3a73dacdb116b3_xqc_320763288922_1785952851//thumb/thumb0-640x360.jpg',
      'https://static-cdn.jtvnw.net/cf_vods/d1m7jfoe9zdc1j/d0086ce0b50cded348bb_xqc_320745551322_1785869163//thumb/thumb0-640x360.jpg',
      'https://static-cdn.jtvnw.net/cf_vods/d2vi6trrdongqn/94d9a9b26ecc5891d8a0_xqc_319661776222_1785780125//thumb/thumb0-640x360.jpg'
    ].map(fetchImageDataUrl));
    app = await electron.launch(getElectronLaunchOptions(environment));
    const win = await app.firstWindow();
    await verifyE2eIsolation(app, win, environment);
    await installOfflineFixtures(app);
    await app.evaluate(({ ipcMain }, images) => {
      const image = (label, from, to) => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="520" cy="80" r="110" fill="rgba(255,255,255,.09)"/><circle cx="100" cy="320" r="170" fill="rgba(0,0,0,.12)"/><text x="34" y="300" fill="white" font-family="Segoe UI,Arial" font-size="34" font-weight="700">${label}</text></svg>`;
        return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      };
      const vods = [
        ['🍝LIVE🍝DRAMA🍝NEWS🍝VIDEOS🍝GAMES🍝REACTS🍝VIDEOGAMES🍝FUN🍝COOL🍝THINGS🍝IMPORTANT🍝BROADCAST🍝SESSION🍝WICKED🍝', '2026-08-09T22:05:48Z', '9h3m44s', 627553],
        ['🦴LIVE🦴DRAMA🦴NEWS🦴VIDEOS🦴IMPORTANT🦴COBBLEMON TOURNAMENT🦴WINNER🦴POV🦴WICKED🦴LETS GO YAY🦴IM HERE🦴', '2026-08-07T19:51:18Z', '5h26m23s', 464926],
        ['🤒LIVE🤒DRAMA🤒NEWS🤒COBBLEMON🤒IS LIVE🤒DAY4 IMPORTANT🤒LOCK IN🤒QUICKLY🤒BIG THINGS TODAY🤒DONT SLEEP IN🤒', '2026-08-06T19:01:50Z', '11h49m41s', 878537],
        ['👈LIVE👈CLICK👈HERE👈DRAMA👈NEWS👈VIDEOS👈GAMES👈COBBLEMON DAY3👈ALSO👈LONG WALK GAME👈FINISHSING?👈HOPEFULY👈LOCK IN👈', '2026-08-05T18:00:55Z', '12h11m17s', 877336],
        ['👨‍🎨LIVE👨‍🎨CLICK👨‍🎨DRAMA👨‍🎨NEWS👨‍🎨GAMES👨‍🎨VIDEOS👨‍🎨IM LATE👨‍🎨BUT COBBLEMON IS BACK👨‍🎨LOCK IN👨‍🎨WOOO👨‍🎨PULL UP👨‍🎨', '2026-08-04T18:46:08Z', '12h17m10s', 868187],
        ['🔮LIVE🔮CLICK🔮DRAMA🔮NEWS🔮VIDEOS🔮CLIPS🔮GAMES🔮VIDEOGAMES🔮THINGS🔮IMPORTANT🔮DAY🔮COBBLEMON SERVER🔮LETS GET IT🔮YIPEE🔮TEAM ROCKET POV', '2026-08-03T18:02:10Z', '10h59m24s', 950330]
      ].map(([title, createdAt, duration, viewCount], index) => ({
        id: ['2841886176', '2839940123', '2839002231', '2838068542', '2837216764', '2836308921'][index],
        title,
        created_at: createdAt,
        duration,
        thumbnail_url: images[index + 1] || image(`xQc VOD ${index + 1}`, '#6441a5', '#1f7ae0'),
        url: `https://www.twitch.tv/videos/${['2841886176', '2839940123', '2839002231', '2838068542', '2837216764', '2836308921'][index]}`,
        view_count: viewCount,
        stream_id: ''
      }));
      ipcMain.removeHandler('get-user-id');
      ipcMain.handle('get-user-id', async () => '71092938');
      ipcMain.removeHandler('get-vods');
      ipcMain.handle('get-vods', async () => vods);
      ipcMain.removeHandler('get-streamer-profile');
      ipcMain.handle('get-streamer-profile', async () => ({
        login: 'xqc',
        displayName: 'xQc',
        avatarUrl: images[0] || image('xQc', '#7c3aed', '#0ea5e9'),
        bannerUrl: '',
        description: 'THE BEST AT ABSOLUTELY EVERYTHING. THE JUICER. LEADER OF THE JUICERS.',
        broadcasterType: 'partner',
        followerCount: 12534104,
        vodCount: vods.length,
        lastStreamAt: '2026-08-09T22:05:48Z',
        isLive: false,
        currentTitle: null,
        currentGame: null,
        currentStreamPreviewUrl: '',
        currentStreamViewers: null,
        twitchUrl: 'https://www.twitch.tv/xqc',
        fetchedAt: Date.now()
      }));
      ipcMain.removeHandler('get-streamer-display-names');
      ipcMain.handle('get-streamer-display-names', async () => ({ xqc: 'xQc' }));
    }, publicImages);
    await win.waitForFunction(() => typeof window.showTab === 'function');
    await win.setViewportSize({ width: 1600, height: 900 });
    await win.evaluate(async () => {
      window.changeLanguage('en');
      showTab('vods');
      isConnected = true;
      config.streamers = ['xqc'];
      config.streamer_display_names = { xqc: 'xQc' };
      config.sidebar_split_view = true;
      streamerVodCache.clear();
      streamerProfileCache.clear();
      await window.hydrateStreamerDisplayNames();
      await selectStreamer('xqc');
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

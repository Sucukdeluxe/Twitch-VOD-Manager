const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertActionsWindowsCi,
  assertPathInside,
  corruptInstalledTools,
  findFileRecursive
} = require('./smoke-test-managed-tools-live');

test('accepts GitHub and Gitea Windows Actions while rejecting local opt-in', () => {
  assert.doesNotThrow(() => assertActionsWindowsCi({ CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_TEMP: 'C:\\runner-temp', GITHUB_RUN_ID: '123' }, 'win32'));
  assert.doesNotThrow(() => assertActionsWindowsCi({ CI: 'true', GITEA_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://git.24-music.de', RUNNER_OS: 'Windows', RUNNER_TEMP: 'C:\\runner-temp', GITHUB_RUN_ID: '456' }, 'win32'));
  assert.throws(() => assertActionsWindowsCi({ CI: 'true', RUNNER_OS: 'Windows' }, 'win32'), /Windows Actions runner/);
  assert.throws(() => assertActionsWindowsCi({ TWITCH_VOD_MANAGER_MANAGED_TOOLS_LIVE: '1' }, 'win32'), /Windows Actions runner/);
  assert.throws(() => assertActionsWindowsCi({ CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://ci.example.test', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_TEMP: 'C:\\runner-temp', GITHUB_RUN_ID: '123' }, 'win32'), /Windows Actions runner/);
  assert.throws(() => assertActionsWindowsCi({ CI: 'true', GITEA_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://other.example.test', RUNNER_OS: 'Windows', RUNNER_TEMP: 'C:\\runner-temp', GITHUB_RUN_ID: '456' }, 'win32'), /Windows Actions runner/);
  assert.throws(() => assertActionsWindowsCi({ CI: 'true', GITHUB_SERVER_URL: 'https://git.24-music.de', RUNNER_OS: 'Windows', RUNNER_TEMP: 'C:\\runner-temp', GITHUB_RUN_ID: '456' }, 'win32'), /Windows Actions runner/);
});

test('rejects cleanup targets outside the owned runner directory', () => {
  assert.doesNotThrow(() => assertPathInside('C:\\runner\\temp\\managed-tools-1', 'C:\\runner\\temp'));
  assert.throws(() => assertPathInside('C:\\runner\\other', 'C:\\runner\\temp'), /outside/);
  assert.throws(() => assertPathInside('C:\\runner\\temp', 'C:\\runner\\temp'), /outside/);
});

test('damages both managed installations without touching unrelated files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-managed-tools-contract-'));
  try {
    const streamlinkDirectory = path.join(root, 'streamlink', 'bin');
    const ffmpegDirectory = path.join(root, 'ffmpeg', 'bin');
    fs.mkdirSync(streamlinkDirectory, { recursive: true });
    fs.mkdirSync(ffmpegDirectory, { recursive: true });
    const streamlinkPath = path.join(streamlinkDirectory, 'streamlink.exe');
    const ffmpegPath = path.join(ffmpegDirectory, 'ffmpeg.exe');
    const ffprobePath = path.join(ffmpegDirectory, 'ffprobe.exe');
    fs.writeFileSync(streamlinkPath, 'streamlink');
    fs.writeFileSync(ffmpegPath, 'ffmpeg');
    fs.writeFileSync(ffprobePath, 'ffprobe');

    const damaged = corruptInstalledTools(path.join(root, 'streamlink'), path.join(root, 'ffmpeg'));

    assert.equal(fs.existsSync(streamlinkPath), false);
    assert.equal(fs.readFileSync(ffmpegPath, 'utf8'), 'ffmpegcorrupt');
    assert.equal(fs.readFileSync(ffprobePath, 'utf8'), 'ffprobe');
    assert.deepEqual(damaged, { ffmpegPath, streamlinkPath });
    assert.equal(findFileRecursive(path.join(root, 'ffmpeg'), 'ffprobe.exe'), ffprobePath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function assertActionsWindowsCi(environment = process.env, platform = process.platform) {
  const serverUrl = String(environment.GITHUB_SERVER_URL || '').replace(/\/+$/, '').toLowerCase();
  const isGitHubActions = environment.GITHUB_ACTIONS === 'true' && environment.GITEA_ACTIONS !== 'true' && environment.RUNNER_ENVIRONMENT === 'github-hosted' && serverUrl === 'https://github.com';
  const isGiteaActions = environment.GITEA_ACTIONS === 'true' && serverUrl === 'https://git.24-music.de';
  const runnerOs = String(environment.RUNNER_OS || '').toLowerCase();
  if (platform !== 'win32' || environment.CI !== 'true' || runnerOs !== 'windows' || !environment.RUNNER_TEMP || !environment.GITHUB_RUN_ID || (!isGitHubActions && !isGiteaActions)) {
    throw new Error('Live managed-tool smoke is restricted to an approved Windows Actions runner');
  }
}

function assertPathInside(targetPath, parentPath) {
  const relative = path.win32.relative(path.win32.resolve(parentPath), path.win32.resolve(targetPath));
  if (!relative || relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)) {
    throw new Error(`Refusing cleanup outside the owned runner directory: ${targetPath}`);
  }
}

function findFileRecursive(directory, fileName) {
  if (!fs.existsSync(directory)) return '';
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return entryPath;
    if (entry.isDirectory()) {
      const nested = findFileRecursive(entryPath, fileName);
      if (nested) return nested;
    }
  }
  return '';
}

function corruptInstalledTools(streamlinkDirectory, ffmpegDirectory) {
  const streamlinkPath = findFileRecursive(streamlinkDirectory, 'streamlink.exe');
  const ffmpegPath = findFileRecursive(ffmpegDirectory, 'ffmpeg.exe');
  if (!streamlinkPath || !ffmpegPath) throw new Error('Managed executables are missing before corruption check');
  fs.rmSync(streamlinkPath);
  fs.appendFileSync(ffmpegPath, 'corrupt');
  return { ffmpegPath, streamlinkPath };
}

function runVersionCheck(executablePath, args, label) {
  const result = spawnSync(executablePath, args, {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} version check failed: ${JSON.stringify({ status: result.status, stderr: result.stderr })}`);
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (!output) throw new Error(`${label} version check produced no output`);
  return output.split(/\r?\n/, 1)[0];
}

function assertPinnedVersion(output, version, label) {
  if (!output.toLowerCase().includes(version.toLowerCase())) {
    throw new Error(`${label} version output does not match the pinned ${version}: ${output}`);
  }
}

function assertVerified(statuses, manifest, phase) {
  for (const id of ['streamlink', 'ffmpeg']) {
    if (!statuses[id]?.verified || statuses[id]?.state !== 'verified' || statuses[id]?.version !== manifest[id].version) {
      throw new Error(`${id} is not verified after ${phase}: ${JSON.stringify(statuses[id])}`);
    }
  }
}

async function main() {
  assertActionsWindowsCi();
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp || !path.win32.isAbsolute(runnerTemp) || !fs.statSync(runnerTemp).isDirectory()) {
    throw new Error(`Actions runner temp directory is invalid: ${runnerTemp || ''}`);
  }
  const smokeRoot = fs.mkdtempSync(path.join(runnerTemp, 'tvm-managed-tools-'));
  assertPathInside(smokeRoot, runnerTemp);

  try {
    const streamlinkDirectory = path.join(smokeRoot, 'tools', 'streamlink');
    const ffmpegDirectory = path.join(smokeRoot, 'tools', 'ffmpeg');
    const temporaryDirectory = path.join(smokeRoot, 'temporary');
    fs.mkdirSync(temporaryDirectory, { recursive: true });
    const toolsPath = path.join(root, 'dist', 'tools.js');
    const manifestPath = path.join(root, 'dist', 'main', 'domain', 'tool-manifest.js');
    if (!fs.existsSync(toolsPath)) throw new Error('Build output is missing; run npm run build first');
    if (!fs.existsSync(manifestPath)) throw new Error('Built tool manifest is missing; run npm run build first');
    const tools = require(toolsPath);
    const { APPLICATION_TOOL_MANIFEST: manifest } = require(manifestPath);
    tools.initToolDirs(streamlinkDirectory, ffmpegDirectory, () => temporaryDirectory);

    const initial = await tools.getManagedToolStatuses();
    if (initial.streamlink.state !== 'missing' || initial.ffmpeg.state !== 'missing') {
      throw new Error(`Clean managed-tool surface is not empty: ${JSON.stringify(initial)}`);
    }

    const firstRepair = await tools.repairManagedTools();
    if (!firstRepair.success) throw new Error(`Initial managed-tool provisioning failed: ${JSON.stringify(firstRepair.statuses)}`);
    assertVerified(firstRepair.statuses, manifest, 'initial provisioning');
    const initialPaths = {
      streamlink: fs.realpathSync.native(tools.getStreamlinkPath()),
      ffmpeg: fs.realpathSync.native(tools.getFFmpegPath()),
      ffprobe: fs.realpathSync.native(tools.getFFprobePath())
    };
    assertPathInside(initialPaths.streamlink, streamlinkDirectory);
    assertPathInside(initialPaths.ffmpeg, ffmpegDirectory);
    assertPathInside(initialPaths.ffprobe, ffmpegDirectory);
    const initialVersions = {
      streamlink: runVersionCheck(initialPaths.streamlink, ['--version'], 'Streamlink'),
      ffmpeg: runVersionCheck(initialPaths.ffmpeg, ['-version'], 'FFmpeg'),
      ffprobe: runVersionCheck(initialPaths.ffprobe, ['-version'], 'FFprobe')
    };
    assertPinnedVersion(initialVersions.streamlink, manifest.streamlink.version, 'Streamlink');
    assertPinnedVersion(initialVersions.ffmpeg, manifest.ffmpeg.version, 'FFmpeg');
    assertPinnedVersion(initialVersions.ffprobe, manifest.ffmpeg.version, 'FFprobe');

    corruptInstalledTools(streamlinkDirectory, ffmpegDirectory);
    tools.invalidateVerifiedToolCaches();
    const damaged = await tools.getManagedToolStatuses();
    if (damaged.streamlink.state !== 'corrupt' || damaged.ffmpeg.state !== 'corrupt') {
      throw new Error(`Damaged managed tools were not detected: ${JSON.stringify(damaged)}`);
    }

    const secondRepair = await tools.repairManagedTools();
    if (!secondRepair.success) throw new Error(`Managed-tool repair failed: ${JSON.stringify(secondRepair.statuses)}`);
    assertVerified(secondRepair.statuses, manifest, 'corruption repair');
    const repairedPaths = {
      streamlink: fs.realpathSync.native(tools.getStreamlinkPath()),
      ffmpeg: fs.realpathSync.native(tools.getFFmpegPath()),
      ffprobe: fs.realpathSync.native(tools.getFFprobePath())
    };
    assertPathInside(repairedPaths.streamlink, streamlinkDirectory);
    assertPathInside(repairedPaths.ffmpeg, ffmpegDirectory);
    assertPathInside(repairedPaths.ffprobe, ffmpegDirectory);
    const repairedVersions = {
      streamlink: runVersionCheck(repairedPaths.streamlink, ['--version'], 'Repaired Streamlink'),
      ffmpeg: runVersionCheck(repairedPaths.ffmpeg, ['-version'], 'Repaired FFmpeg'),
      ffprobe: runVersionCheck(repairedPaths.ffprobe, ['-version'], 'Repaired FFprobe')
    };
    assertPinnedVersion(repairedVersions.streamlink, manifest.streamlink.version, 'Repaired Streamlink');
    assertPinnedVersion(repairedVersions.ffmpeg, manifest.ffmpeg.version, 'Repaired FFmpeg');
    assertPinnedVersion(repairedVersions.ffprobe, manifest.ffmpeg.version, 'Repaired FFprobe');

    console.log(JSON.stringify({ failures: [], initialVersions, repairedVersions }, null, 2));
  } finally {
    assertPathInside(smokeRoot, runnerTemp);
    await fs.promises.rm(smokeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  assertActionsWindowsCi,
  assertPathInside,
  corruptInstalledTools,
  findFileRecursive
};

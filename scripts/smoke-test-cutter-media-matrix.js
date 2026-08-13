const { _electron: electron } = require('playwright');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { requireFileCapability } = require('./file-capability-contract');
const {
  cleanupE2eEnvironment,
  createE2eEnvironment,
  getElectronLaunchOptions,
  verifyE2eIsolation
} = require('./e2e-test-environment');

const fixtureDuration = 3;
const exportTrimStart = 0.25;
const exportTrimEnd = 2.75;
const expectedExportDuration = exportTrimEnd - exportTrimStart;
const projectRoot = path.resolve(__dirname, '..');
const offlineProxy = 'http://127.0.0.1:1';
const cutterMatrixTimeouts = Object.freeze({
  prepareSource: 90000,
  exportSource: 180000,
  appClose: 15000,
  appProcessExit: 5000,
  diagnostics: 30000
});
const markerFrequencies = Object.freeze({
  initial: 220,
  start: 440,
  end: 1760
});
const markerTimes = Object.freeze({
  initialEnd: 0.2,
  startEnd: 0.55,
  endStart: 2.55,
  sourceStartSample: 0.3,
  sourceEndSample: 2.65,
  outputStartSample: 0.05,
  outputEndSample: expectedExportDuration - 0.15
});
const markerAudioSampleRate = 48000;

function assertPathInside(targetPath, parentPath, label) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedParent = path.resolve(parentPath);
  const relative = path.relative(resolvedParent, resolvedTarget);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside the owned managed-tool directory: ${resolvedTarget}`);
  }
}

function isDigitCharacter(character) {
  return character >= '0' && character <= '9';
}

function isBuildSuffixCharacter(character) {
  return isDigitCharacter(character)
    || (character >= 'A' && character <= 'Z')
    || (character >= 'a' && character <= 'z')
    || character === '.'
    || character === '_'
    || character === '-'
    || character === '+';
}

function parseVersionToken(versionToken) {
  if (!versionToken) return null;
  const delimiterIndexes = [versionToken.indexOf('-'), versionToken.indexOf('+')].filter((index) => index >= 0);
  const delimiterIndex = delimiterIndexes.length > 0 ? Math.min(...delimiterIndexes) : -1;
  const numericVersion = delimiterIndex >= 0 ? versionToken.slice(0, delimiterIndex) : versionToken;
  const suffix = delimiterIndex >= 0 ? versionToken.slice(delimiterIndex + 1) : null;
  const delimiter = delimiterIndex >= 0 ? versionToken[delimiterIndex] : null;
  const numericSegments = numericVersion.split('.');
  if (numericSegments.length < 2 || numericSegments.some((segment) => segment.length === 0 || [...segment].some((character) => !isDigitCharacter(character)))) return null;
  if (suffix !== null && (suffix.length === 0 || [...suffix].some((character) => !isBuildSuffixCharacter(character)))) return null;
  return { numericVersion, delimiter, suffix };
}

function assertPinnedVersion(output, version, label) {
  const executable = String(label).toLowerCase().includes('streamlink')
    ? 'streamlink'
    : String(label).toLowerCase().includes('ffprobe')
      ? 'ffprobe'
      : 'ffmpeg';
  const firstLine = String(output).split(/\r?\n/, 1)[0].trim();
  const tokens = firstLine.split(/\s+/);
  const versionToken = executable === 'streamlink' ? tokens[1] : tokens[2];
  const hasExpectedFormat = executable === 'streamlink' || tokens[1]?.toLowerCase() === 'version';
  const parsedVersion = parseVersionToken(versionToken);
  if (tokens[0]?.toLowerCase() !== executable || !hasExpectedFormat || !parsedVersion) {
    throw new Error(`${label} does not expose a parseable version: ${output}`);
  }
  if (parsedVersion.numericVersion !== String(version)) {
    throw new Error(`${label} version output does not match pinned ${version}: ${output}`);
  }
  const expectedGyanSuffix = executable === 'streamlink' ? null : 'essentials_build-www.gyan.dev';
  if (parsedVersion.suffix !== null && (parsedVersion.delimiter !== '-' || parsedVersion.suffix !== expectedGyanSuffix)) {
    throw new Error(`${label} does not expose a parseable version: ${output}`);
  }
}

async function withOperationTimeout(operation, label, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function runBinary(binary, args, timeout = 120000, execute = spawnSync) {
  const result = execute(binary, args, {
    windowsHide: true,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.slice(0, 2000) || `${binary} exited with ${result.status}`);
  return result.stdout;
}

function runBinaryBuffer(binary, args, timeout = 120000, execute = spawnSync) {
  const result = execute(binary, args, {
    windowsHide: true,
    stdio: 'pipe',
    encoding: null,
    timeout
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(Buffer.from(result.stderr || '').toString('utf8').slice(0, 2000) || `${binary} exited with ${result.status}`);
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
}

function runVersionCheck(executablePath, args, label) {
  const output = runBinary(executablePath, args, 60000);
  if (!output.trim()) throw new Error(`${label} version check produced no output`);
  return output.split(/\r?\n/, 1)[0];
}

function loadBuiltToolArtifacts() {
  const toolsPath = path.join(projectRoot, 'dist', 'tools.js');
  const manifestPath = path.join(projectRoot, 'dist', 'main', 'domain', 'tool-manifest.js');
  if (!fs.existsSync(toolsPath)) throw new Error('Build output is missing; run npm run build first');
  if (!fs.existsSync(manifestPath)) throw new Error('Built tool manifest is missing; run npm run build first');
  return {
    tools: require(toolsPath),
    manifest: require(manifestPath).APPLICATION_TOOL_MANIFEST
  };
}

function assertVerifiedManagedStatus(status, expectedVersion, label) {
  if (!status?.verified || status.state !== 'verified' || status.version !== expectedVersion) {
    throw new Error(`${label} is not verified at pinned ${expectedVersion}: ${JSON.stringify(status)}`);
  }
}

async function provisionManagedCutterTools(environment, options = {}) {
  const streamlinkDirectory = path.join(environment.appDataDir, 'tools', 'streamlink');
  const ffmpegDirectory = path.join(environment.appDataDir, 'tools', 'ffmpeg');
  const temporaryDirectory = path.join(environment.rootDir, 'managed-tools-temp');
  for (const directory of [streamlinkDirectory, ffmpegDirectory, temporaryDirectory]) {
    assertPathInside(directory, environment.rootDir, 'Managed-tool directory');
    fs.mkdirSync(directory, { recursive: true });
  }
  const loadArtifacts = options.loadBuiltArtifacts || loadBuiltToolArtifacts;
  const checkVersion = options.runVersionCheck || runVersionCheck;
  const { tools, manifest } = loadArtifacts();
  tools.initToolDirs(streamlinkDirectory, ffmpegDirectory, () => temporaryDirectory);
  const repair = await tools.repairManagedTools();
  if (!repair.success) throw new Error(`Pinned product-tool provisioning failed: ${JSON.stringify(repair.statuses)}`);
  assertVerifiedManagedStatus(repair.statuses.streamlink, manifest.streamlink.version, 'Streamlink');
  assertVerifiedManagedStatus(repair.statuses.ffmpeg, manifest.ffmpeg.version, 'FFmpeg');
  const paths = {
    streamlink: fs.realpathSync.native(tools.getStreamlinkPath()),
    ffmpeg: fs.realpathSync.native(tools.getFFmpegPath()),
    ffprobe: fs.realpathSync.native(tools.getFFprobePath())
  };
  assertPathInside(paths.streamlink, streamlinkDirectory, 'Streamlink path');
  assertPathInside(paths.ffmpeg, ffmpegDirectory, 'FFmpeg path');
  assertPathInside(paths.ffprobe, ffmpegDirectory, 'FFprobe path');
  const versions = {
    streamlink: checkVersion(paths.streamlink, ['--version'], 'Streamlink'),
    ffmpeg: checkVersion(paths.ffmpeg, ['-version'], 'FFmpeg'),
    ffprobe: checkVersion(paths.ffprobe, ['-version'], 'FFprobe')
  };
  assertPinnedVersion(versions.streamlink, manifest.streamlink.version, 'Streamlink');
  assertPinnedVersion(versions.ffmpeg, manifest.ffmpeg.version, 'FFmpeg');
  assertPinnedVersion(versions.ffprobe, manifest.ffmpeg.version, 'FFprobe');
  return { manifest, paths, statuses: repair.statuses, versions };
}

function createManagedMediaRuntime(paths, execute = spawnSync) {
  if (!path.isAbsolute(paths.ffmpeg) || !path.isAbsolute(paths.ffprobe)) {
    throw new Error('Managed media runtime requires absolute product-tool paths');
  }
  return {
    ffmpeg: (args, timeout) => runBinary(paths.ffmpeg, args, timeout, execute),
    ffmpegBuffer: (args, timeout) => runBinaryBuffer(paths.ffmpeg, args, timeout, execute),
    ffprobe: (args, timeout) => runBinary(paths.ffprobe, args, timeout, execute)
  };
}

function setEnvironmentValue(environmentVariables, expectedKey, value, snapshots) {
  const key = Object.keys(environmentVariables).find((candidate) => candidate.toLowerCase() === expectedKey.toLowerCase()) || expectedKey;
  snapshots.push({ key, existed: Object.prototype.hasOwnProperty.call(environmentVariables, key), value: environmentVariables[key] });
  environmentVariables[key] = value;
}

function getEnvironmentValue(environmentVariables, expectedKey) {
  const key = Object.keys(environmentVariables).find((candidate) => candidate.toLowerCase() === expectedKey.toLowerCase());
  return key ? environmentVariables[key] : undefined;
}

function activateOfflineRunnerEnvironment(environment, environmentVariables = process.env) {
  const directories = {
    path: path.join(environment.rootDir, 'offline-path'),
    localAppData: path.join(environment.rootDir, 'localappdata'),
    roamingAppData: path.join(environment.rootDir, 'roamingappdata'),
    temp: path.join(environment.rootDir, 'runtime-temp')
  };
  for (const directory of Object.values(directories)) {
    assertPathInside(directory, environment.rootDir, 'Offline runner directory');
    fs.mkdirSync(directory, { recursive: true });
  }
  const snapshots = [];
  const values = {
    PATH: directories.path,
    HTTP_PROXY: offlineProxy,
    HTTPS_PROXY: offlineProxy,
    ALL_PROXY: offlineProxy,
    NO_PROXY: '',
    http_proxy: offlineProxy,
    https_proxy: offlineProxy,
    all_proxy: offlineProxy,
    no_proxy: '',
    LOCALAPPDATA: directories.localAppData,
    APPDATA: directories.roamingAppData,
    TEMP: directories.temp,
    TMP: directories.temp,
    PROGRAMDATA: environment.programDataDir || path.dirname(environment.appDataDir)
  };
  for (const [key, value] of Object.entries(values)) setEnvironmentValue(environmentVariables, key, value, snapshots);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const snapshot of snapshots.reverse()) {
      if (snapshot.existed) environmentVariables[snapshot.key] = snapshot.value;
      else delete environmentVariables[snapshot.key];
    }
  };
}

function resolvePowerShellExecutable() {
  const windowsDirectory = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const executable = path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(executable)) throw new Error(`PowerShell is missing: ${executable}`);
  return fs.realpathSync.native(executable);
}

function probeMedia(runtime, filePath) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams'];
  args.push(filePath);
  return JSON.parse(runtime.ffprobe(args));
}

function probeVideoTimestamps(runtime, filePath) {
  const output = runtime.ffprobe([
    '-v', 'error', '-print_format', 'json', '-select_streams', 'v:0',
    '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', filePath
  ]);
  const frames = JSON.parse(output).frames || [];
  return frames.map((frame) => Number(frame.best_effort_timestamp_time)).filter(Number.isFinite);
}

function assertVideoCadence(runtime, definition, filePath) {
  const timestamps = probeVideoTimestamps(runtime, filePath);
  assertCondition(timestamps.length > 1, `${definition.name} output has fewer than two decoded video frames`);
  assertCondition(timestamps.every((timestamp, index) => index === 0 || timestamp > timestamps[index - 1]), `${definition.name} output frame timestamps are not strictly monotone`);
  const deltas = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]);
  const expectedDelta = 1 / definition.expectedOutputRealFps;
  const cadenceTolerance = Math.max(0.0015, expectedDelta * 0.08);
  if (definition.variableFrameRate) {
    const cadenceMultiples = deltas.map((delta) => Math.round(delta / expectedDelta));
    assertCondition(new Set(cadenceMultiples).size >= 2, `${definition.name} output lost its variable frame cadence`);
    assertCondition(deltas.every((delta, index) => cadenceMultiples[index] >= 1 && cadenceMultiples[index] <= 2 && Math.abs(delta - cadenceMultiples[index] * expectedDelta) <= cadenceTolerance), `${definition.name} output cadence contains unexpected VFR deltas: ${JSON.stringify([...new Set(deltas.map((delta) => Number(delta.toFixed(6))))])}`);
  } else {
    assertCondition(deltas.every((delta) => Math.abs(delta - expectedDelta) <= cadenceTolerance), `${definition.name} output cadence contains unexpected CFR deltas: ${JSON.stringify([...new Set(deltas.map((delta) => Number(delta.toFixed(6))))])}`);
  }
  return {
    frames: timestamps.length,
    start: timestamps[0],
    end: timestamps.at(-1) + expectedDelta,
    distinctDeltas: [...new Set(deltas.map((delta) => Number(delta.toFixed(6))))]
  };
}

function probePacketTimeline(runtime, filePath, streamSelector) {
  const output = runtime.ffprobe([
    '-v', 'error', '-print_format', 'json', '-select_streams', streamSelector,
    '-show_packets', '-show_entries', 'packet=pts_time,duration_time', filePath
  ]);
  const packets = (JSON.parse(output).packets || []).map((packet) => ({
    start: Number(packet.pts_time),
    duration: Number(packet.duration_time)
  })).filter((packet) => Number.isFinite(packet.start));
  assertCondition(packets.length > 0, `${path.basename(filePath)} has no ${streamSelector} packets`);
  return {
    start: packets[0].start,
    end: Math.max(...packets.map((packet) => packet.start + (Number.isFinite(packet.duration) ? packet.duration : 0))),
    packets: packets.length
  };
}

function decodeMedia(runtime, filePath) {
  runtime.ffmpeg(['-v', 'error', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-']);
}

function sha256(filePath) {
  return nodeCrypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function mediaDuration(probe) {
  return Number(probe.format?.duration || probe.streams?.find((stream) => stream.codec_type === 'video')?.duration || 0);
}

function parseRate(value) {
  if (typeof value !== 'string') return 0;
  const [numerator, denominator = '1'] = value.split('/').map(Number);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0 ? numerator / denominator : 0;
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoExportArtifacts(directory, outputName) {
  const outputExtension = path.extname(outputName);
  const outputStem = path.basename(outputName, outputExtension);
  const artifacts = fs.readdirSync(directory).filter((name) =>
    name.includes(`${outputStem}.`) && (name.includes('.tvm-edit') || name.includes('.tvm-backup'))
  );
  assertCondition(artifacts.length === 0, `Temporary export artifacts remain for ${outputName}: ${JSON.stringify(artifacts)}`);
}

function createVideoMarkerSource(rate) {
  return [
    `color=c=blue:size=320x180:rate=${rate}:duration=${fixtureDuration}`,
    `drawbox=color=red:t=fill:enable='lt(t,${markerTimes.initialEnd})'`,
    `drawbox=color=lime:t=fill:enable='between(t,${markerTimes.initialEnd},${markerTimes.startEnd})'`,
    `drawbox=color=magenta:t=fill:enable='between(t,2.2,${markerTimes.endStart})'`,
    `drawbox=color=cyan:t=fill:enable='gte(t,${markerTimes.endStart})'`
  ].join(',');
}

function createAudioMarkerSource(middleFrequency) {
  const expression = [
    `if(lt(t\\,${markerTimes.initialEnd})\\,sin(2*PI*${markerFrequencies.initial}*t)`,
    `if(lt(t\\,${markerTimes.startEnd})\\,sin(2*PI*${markerFrequencies.start}*t)`,
    `if(lt(t\\,${markerTimes.endStart})\\,sin(2*PI*${middleFrequency}*t)`,
    `sin(2*PI*${markerFrequencies.end}*t))))`
  ].join('\\,');
  return `aevalsrc=${expression}:s=${markerAudioSampleRate}:d=${fixtureDuration}`;
}

function sampleVideoRgb(runtime, filePath, time) {
  const output = runtime.ffmpegBuffer([
    '-v', 'error', '-i', filePath, '-ss', String(time),
    '-frames:v', '1', '-vf', 'scale=1:1:flags=area,format=rgb24',
    '-f', 'rawvideo', 'pipe:1'
  ]);
  assertCondition(output.length >= 3, `${path.basename(filePath)} produced no decoded RGB marker`);
  return [output[0], output[1], output[2]];
}

function estimatePcmFrequency(buffer, sampleRate = markerAudioSampleRate) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length % 2 !== 0) return 0;
  const crossings = [];
  let state = 0;
  for (let index = 0; index < buffer.length / 2; index += 1) {
    const sample = buffer.readInt16LE(index * 2);
    if (sample <= -500) state = -1;
    else if (sample >= 500 && state === -1) {
      crossings.push(index);
      state = 1;
    }
  }
  if (crossings.length < 2) return 0;
  return sampleRate * (crossings.length - 1) / (crossings.at(-1) - crossings[0]);
}

function sampleAudioFrequency(runtime, filePath, time) {
  const output = runtime.ffmpegBuffer([
    '-v', 'error', '-i', filePath, '-ss', String(time), '-t', '0.1',
    '-map', '0:a:0', '-ac', '1', '-ar', String(markerAudioSampleRate),
    '-f', 's16le', 'pipe:1'
  ]);
  return estimatePcmFrequency(output, markerAudioSampleRate);
}

function classifyVideoMarker(rgb) {
  const [red, green, blue] = rgb;
  if (green > red + 35 && green > blue + 35) return 'green';
  if (green > red + 35 && blue > red + 35 && Math.abs(green - blue) <= 80) return 'cyan';
  if (red > green + 35 && red > blue + 35) return 'red';
  if (red > green + 35 && blue > green + 35) return 'magenta';
  return 'unknown';
}

function assertTrimBoundaryMarkers(observation, label) {
  const startVideoMarker = classifyVideoMarker(observation.startVideoRgb);
  const endVideoMarker = classifyVideoMarker(observation.endVideoRgb);
  assertCondition(startVideoMarker === 'green', `${label} start video marker is ${startVideoMarker}: ${JSON.stringify(observation.startVideoRgb)}`);
  assertCondition(endVideoMarker === 'cyan', `${label} end video marker is ${endVideoMarker}: ${JSON.stringify(observation.endVideoRgb)}`);
  assertCondition(Math.abs(observation.startAudioFrequency - markerFrequencies.start) <= markerFrequencies.start * 0.12, `${label} start audio marker is ${observation.startAudioFrequency}`);
  assertCondition(Math.abs(observation.endAudioFrequency - markerFrequencies.end) <= markerFrequencies.end * 0.12, `${label} end audio marker is ${observation.endAudioFrequency}`);
}

function observeTrimBoundaryMarkers(runtime, filePath, startTime, endTime) {
  return {
    startVideoRgb: sampleVideoRgb(runtime, filePath, startTime),
    endVideoRgb: sampleVideoRgb(runtime, filePath, endTime),
    startAudioFrequency: sampleAudioFrequency(runtime, filePath, startTime),
    endAudioFrequency: sampleAudioFrequency(runtime, filePath, endTime)
  };
}

function createFixture(environment, runtime, definition) {
  const filePath = path.join(environment.mediaDir, definition.fileName);
  runtime.ffmpeg(definition.ffmpegArgs(filePath));
  const probe = probeMedia(runtime, filePath);
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams.filter((stream) => stream.codec_type === 'audio');
  assertCondition(video?.codec_name === definition.sourceVideoCodec, `${definition.name} source codec is ${video?.codec_name}`);
  assertCondition(audio.length === definition.audioFrequencies.length, `${definition.name} source has ${audio.length} audio streams`);
  assertCondition(JSON.stringify(audio.map((stream) => stream.channels)) === JSON.stringify(definition.sourceAudioChannels), `${definition.name} source audio channels are ${JSON.stringify(audio.map((stream) => stream.channels))}`);
  assertCondition(Math.abs(mediaDuration(probe) - fixtureDuration) <= 0.25, `${definition.name} source duration is ${mediaDuration(probe)}`);
  const averageRate = parseRate(video.avg_frame_rate);
  const realRate = parseRate(video.r_frame_rate);
  assertCondition(Math.abs(averageRate - definition.sourceFps) <= definition.sourceFpsTolerance, `${definition.name} source FPS is ${averageRate}`);
  assertCondition(Math.abs(realRate - definition.sourceRealFps) <= definition.sourceFpsTolerance, `${definition.name} source real FPS is ${realRate}`);
  if (definition.variableFrameRate) {
    assertCondition(Math.abs(averageRate - realRate) / Math.max(averageRate, realRate) > 0.005, `${definition.name} source rates do not satisfy production VFR detection: ${averageRate}/${realRate}`);
    const timestamps = probeVideoTimestamps(runtime, filePath);
    const deltas = timestamps.slice(1).map((timestamp, index) => Number((timestamp - timestamps[index]).toFixed(6)));
    assertCondition(new Set(deltas).size >= 2, `${definition.name} fixture is not variable frame rate: ${JSON.stringify([...new Set(deltas)])}`);
  }
  const trimMarkers = observeTrimBoundaryMarkers(runtime, filePath, markerTimes.sourceStartSample, markerTimes.sourceEndSample);
  assertTrimBoundaryMarkers(trimMarkers, `${definition.name} source`);
  return { filePath, probe, hash: sha256(filePath), trimMarkers };
}

function createMatrixDefinitions() {
  const createInputs = (rate, audioFrequencies) => [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', createVideoMarkerSource(rate),
    ...audioFrequencies.flatMap((frequency) => ['-f', 'lavfi', '-i', createAudioMarkerSource(frequency)])
  ];
  return [
    {
      id: 'av1-multi',
      name: 'MKV AV1 29.97 multi-audio',
      fileName: 'matrix-av1-2997-multi.mkv',
      outputName: 'matrix-av1-2997-multi-export.mp4',
      profile: 'quality',
      audioStreamIndex: 1,
      audioFrequencies: [440, 880],
      sourceAudioChannels: [1, 2],
      expectedAudioChannels: 2,
      sourceVideoCodec: 'av1',
      sourceFps: 30000 / 1001,
      sourceRealFps: 30000 / 1001,
      sourceFpsTolerance: 0.01,
      expectedOutputRealFps: 30000 / 1001,
      outputFpsTolerance: 0.02,
      variableFrameRate: false,
      ffmpegArgs: (filePath) => [
        ...createInputs('30000/1001', [440, 880]),
        '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
        '-t', String(fixtureDuration), '-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '42', '-b:v', '0', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ac:a:0', '1', '-ac:a:1', '2', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=deu', '-shortest', '-y', filePath
      ]
    },
    {
      id: 'hevc-ts',
      name: 'MPEG-TS HEVC 59.94',
      fileName: 'matrix-hevc-5994.ts',
      outputName: 'matrix-hevc-5994-export.mp4',
      profile: 'fast',
      audioStreamIndex: 0,
      audioFrequencies: [660],
      sourceAudioChannels: [1],
      expectedAudioChannels: 1,
      sourceVideoCodec: 'hevc',
      sourceFps: 60000 / 1001,
      sourceRealFps: 60000 / 1001,
      sourceFpsTolerance: 0.01,
      expectedOutputRealFps: 60000 / 1001,
      outputFpsTolerance: 0.02,
      variableFrameRate: false,
      ffmpegArgs: (filePath) => [
        ...createInputs('60000/1001', [660]),
        '-t', String(fixtureDuration), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-crf', '35', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ac', '1', '-f', 'mpegts', '-shortest', '-y', filePath
      ]
    },
    {
      id: 'avi',
      name: 'AVI MPEG-4',
      fileName: 'matrix-mpeg4.avi',
      outputName: 'matrix-mpeg4-export.mkv',
      profile: 'archive',
      audioStreamIndex: 0,
      audioFrequencies: [330],
      sourceAudioChannels: [1],
      expectedAudioChannels: 1,
      sourceVideoCodec: 'mpeg4',
      sourceFps: 25,
      sourceRealFps: 25,
      sourceFpsTolerance: 0.01,
      expectedOutputRealFps: 25,
      outputFpsTolerance: 0.01,
      variableFrameRate: false,
      ffmpegArgs: (filePath) => [
        ...createInputs('25', [330]),
        '-t', String(fixtureDuration), '-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p',
        '-c:a', 'libmp3lame', '-ac', '1', '-shortest', '-y', filePath
      ]
    },
    {
      id: 'vfr',
      name: 'MP4 H.264 VFR',
      fileName: 'matrix-vfr.mp4',
      outputName: 'matrix-vfr-export.mp4',
      profile: 'balanced',
      audioStreamIndex: 0,
      audioFrequencies: [550],
      sourceAudioChannels: [1],
      expectedAudioChannels: 1,
      sourceVideoCodec: 'h264',
      sourceFps: 50,
      sourceRealFps: 60,
      sourceFpsTolerance: 1,
      expectedOutputRealFps: 60,
      outputFpsTolerance: 3,
      variableFrameRate: true,
      ffmpegArgs: (filePath) => [
        ...createInputs('60', [550]),
        '-vf', "select='if(lt(t,1),not(mod(n,2)),1)'", '-fps_mode', 'vfr',
        '-t', String(fixtureDuration), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ac', '1', '-shortest', '-y', filePath
      ]
    }
  ];
}

async function createCutterCapability(win, filePath) {
  const inputId = `cutter-matrix-${nodeCrypto.randomUUID()}`;
  await win.evaluate((id) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = id;
    document.body.appendChild(input);
  }, inputId);
  await win.locator(`#${inputId}`).setInputFiles(filePath);
  const capability = await win.evaluate(async (id) => {
    const input = document.getElementById(id);
    const file = input instanceof HTMLInputElement ? input.files?.[0] : null;
    const selection = file ? await window.api.selectDroppedVideo(file) : null;
    input?.remove();
    return selection;
  }, inputId);
  return requireFileCapability(capability);
}

async function prepareSource(win, filePath, options = {}) {
  const timeoutMs = options.timeoutMs ?? cutterMatrixTimeouts.prepareSource;
  const createCapability = options.createCapability || createCutterCapability;
  return await withOperationTimeout(async () => {
    const capability = await createCapability(win, filePath);
    const media = await win.evaluate((selection) => window.api.prepareVideoEditorMedia(selection.token), capability);
    return { capability, media };
  }, 'prepareSource', timeoutMs);
}

async function exportSource(win, definition, source, timeoutMs = cutterMatrixTimeouts.exportSource) {
  return await withOperationTimeout(() => win.evaluate(({ inputCapability, outputName, trimStart, trimEnd, profile, audioStreamIndex }) => window.api.exportVideoEdit({
      inputCapability,
      outputName,
      trimStart,
      trimEnd,
      cuts: [],
      profile,
      encoder: 'software',
      audioStreamIndex
    }), {
      inputCapability: source.capability.token,
      outputName: definition.outputName,
      trimStart: exportTrimStart,
      trimEnd: exportTrimEnd,
      profile: definition.profile,
      audioStreamIndex: definition.audioStreamIndex
    }), 'exportSource', timeoutMs);
}

function analyzeExport(environment, runtime, definition, source) {
  const outputFile = path.join(environment.mediaDir, definition.outputName);
  assertCondition(fs.existsSync(outputFile), `${definition.name} output was not created`);
  const probe = probeMedia(runtime, outputFile);
  const videoStreams = probe.streams.filter((stream) => stream.codec_type === 'video');
  const audioStreams = probe.streams.filter((stream) => stream.codec_type === 'audio');
  assertCondition(videoStreams.length === 1, `${definition.name} output has ${videoStreams.length} video streams`);
  assertCondition(audioStreams.length === 1, `${definition.name} output has ${audioStreams.length} audio streams`);
  assertCondition(videoStreams[0].codec_name === (definition.profile === 'archive' ? 'ffv1' : 'h264'), `${definition.name} output video codec is ${videoStreams[0].codec_name}`);
  assertCondition(audioStreams[0].codec_name === (definition.profile === 'archive' ? 'flac' : 'aac'), `${definition.name} output audio codec is ${audioStreams[0].codec_name}`);
  assertCondition(audioStreams[0].channels === definition.expectedAudioChannels, `${definition.name} selected audio stream has ${audioStreams[0].channels} channels instead of ${definition.expectedAudioChannels}`);
  const duration = mediaDuration(probe);
  assertCondition(Math.abs(duration - expectedExportDuration) <= 0.16, `${definition.name} output duration is ${duration}`);
  const realRate = parseRate(videoStreams[0].r_frame_rate);
  assertCondition(Math.abs(realRate - definition.expectedOutputRealFps) <= definition.outputFpsTolerance, `${definition.name} output real FPS is ${realRate}`);
  const videoCadence = assertVideoCadence(runtime, definition, outputFile);
  const audioTimeline = probePacketTimeline(runtime, outputFile, 'a:0');
  assertCondition(Math.abs(videoCadence.start - audioTimeline.start) <= 0.08, `${definition.name} A/V start differs by ${Math.abs(videoCadence.start - audioTimeline.start)}`);
  assertCondition(Math.abs(videoCadence.end - audioTimeline.end) <= 0.12, `${definition.name} A/V end differs by ${Math.abs(videoCadence.end - audioTimeline.end)}`);
  assertCondition(videoStreams[0].width === 320 && videoStreams[0].height === 180, `${definition.name} output dimensions are ${videoStreams[0].width}x${videoStreams[0].height}`);
  decodeMedia(runtime, outputFile);
  const trimMarkers = observeTrimBoundaryMarkers(runtime, outputFile, markerTimes.outputStartSample, markerTimes.outputEndSample);
  assertTrimBoundaryMarkers(trimMarkers, `${definition.name} output`);
  assertCondition(sha256(source.filePath) === source.hash, `${definition.name} source changed during export`);
  assertNoExportArtifacts(environment.mediaDir, definition.outputName);
  return {
    outputName: definition.outputName,
    duration,
    videoCodec: videoStreams[0].codec_name,
    audioCodec: audioStreams[0].codec_name,
    videoRate: videoStreams[0].avg_frame_rate,
    realVideoRate: videoStreams[0].r_frame_rate,
    audioChannels: audioStreams[0].channels,
    videoCadence,
    audioTimeline,
    trimMarkers
  };
}

function sameResolvedPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function assertManagedExecutionDiagnostics(options) {
  const {
    diagnostics,
    expectedPaths,
    streamlinkDirectory,
    ffmpegDirectory,
    electronPath,
    expectedElectronPath,
    previousDiagnostics = null,
    requiredTools = [],
    label
  } = options;
  assertCondition(diagnostics !== null && typeof diagnostics === 'object', `${label} managed execution diagnostics are unavailable`);
  const tools = [
    { key: 'ffmpeg', name: 'FFmpeg', expectedPath: expectedPaths.ffmpeg, directory: ffmpegDirectory },
    { key: 'ffprobe', name: 'FFprobe', expectedPath: expectedPaths.ffprobe, directory: ffmpegDirectory },
    { key: 'streamlink', name: 'Streamlink', expectedPath: expectedPaths.streamlink, directory: streamlinkDirectory }
  ];
  for (const tool of tools) {
    const record = diagnostics[tool.key];
    assertCondition(record !== null && typeof record === 'object' && Number.isInteger(record.count) && record.count >= 0, `${label} ${tool.name} execution record is invalid: ${JSON.stringify(record)}`);
    if (record.count === 0) {
      assertCondition(record.path === null, `${label} ${tool.name} reported a path without an execution: ${record.path}`);
    } else {
      assertCondition(sameResolvedPath(record.path, tool.expectedPath), `${label} did not execute the provisioned ${tool.name} path: ${record.path}`);
      assertPathInside(record.path, tool.directory, `${label} ${tool.name} path`);
    }
    if (previousDiagnostics) {
      const previousRecord = previousDiagnostics[tool.key];
      assertCondition(previousRecord !== null && typeof previousRecord === 'object' && Number.isInteger(previousRecord.count) && previousRecord.count >= 0, `${label} previous ${tool.name} execution record is invalid: ${JSON.stringify(previousRecord)}`);
      assertCondition(record.count >= previousRecord.count, `${label} ${tool.name} execution count regressed from ${previousRecord.count} to ${record.count}`);
      if (requiredTools.includes(tool.key)) assertCondition(record.count > previousRecord.count, `${label} did not record a new ${tool.name} execution`);
    }
  }
  assertCondition(sameResolvedPath(electronPath, expectedElectronPath), `${label} Electron PATH escaped isolation: ${electronPath}`);
}

async function readManagedExecutionDiagnostics(win, timeoutMs = cutterMatrixTimeouts.diagnostics) {
  return await withOperationTimeout(
    () => win.evaluate(() => window.api.getManagedToolExecutionDiagnostics()),
    'managed tool execution diagnostics',
    timeoutMs
  );
}

async function readDebugLog(win, timeoutMs = cutterMatrixTimeouts.diagnostics) {
  return await withOperationTimeout(
    () => win.evaluate(() => window.api.getDebugLog(1000)),
    'debug log read',
    timeoutMs
  );
}

function assertLockedTargetFailure({ result, debugBefore, debugAfter, outputFile, runtimeIssues }) {
  assertCondition(!result?.rejected, `Locked target export must resolve through the product IPC: ${result?.rejected}`);
  assertCondition(result?.success === false, `Locked target export unexpectedly succeeded: ${JSON.stringify(result)}`);
  assertCondition(result.cancelled !== true, `Locked target export must not be reported as cancelled: ${JSON.stringify(result)}`);
  assertCondition(runtimeIssues.length === 0, `Locked target export produced runtime issues: ${runtimeIssues.join(' | ')}`);
  const delta = debugAfter.startsWith(debugBefore) ? debugAfter.slice(debugBefore.length) : debugAfter;
  const hasMatchingFailure = delta.split(/\r?\n/).some((line) => {
    if (!/video-editor-export-failed/.test(line)
      || !/(?:EPERM|EBUSY|EACCES|operation not permitted|being used by another process|cannot access)/i.test(line)) return false;
    const paths = extractRenamePaths(line);
    if (!paths) return false;
    const outputDirectory = path.dirname(outputFile);
    const stagingPublish = sameResolvedPath(paths.destination, outputFile)
      && sameResolvedPath(path.dirname(paths.source), outputDirectory)
      && path.basename(paths.source).toLowerCase().includes('.tvm-edit');
    const backupPublish = sameResolvedPath(paths.source, outputFile)
      && sameResolvedPath(path.dirname(paths.destination), outputDirectory)
      && path.basename(paths.destination).startsWith(`${path.basename(outputFile)}.`)
      && path.basename(paths.destination).toLowerCase().endsWith('.tvm-backup');
    return stagingPublish || backupPublish;
  });
  assertCondition(hasMatchingFailure, `Locked target export did not emit an atomic publish lock diagnostic: ${delta}`);
}

function extractRenamePaths(line) {
  const renameIndex = line.toLowerCase().lastIndexOf('rename ');
  if (renameIndex < 0) return null;
  const remainder = line.slice(renameIndex + 7).trim();
  const sourceQuote = remainder[0];
  if (sourceQuote !== "'" && sourceQuote !== '"') return null;
  const sourceEnd = remainder.indexOf(sourceQuote, 1);
  if (sourceEnd < 1) return null;
  const afterSource = remainder.slice(sourceEnd + 1).trim();
  if (!afterSource.startsWith('->')) return null;
  const destinationPart = afterSource.slice(2).trim();
  const destinationQuote = destinationPart[0];
  if (destinationQuote !== "'" && destinationQuote !== '"') return null;
  const destinationEnd = destinationPart.indexOf(destinationQuote, 1);
  if (destinationEnd < 1 || destinationPart.slice(destinationEnd + 1).trim()) return null;
  return {
    source: remainder.slice(1, sourceEnd),
    destination: destinationPart.slice(1, destinationEnd)
  };
}

async function stopLockProcess(lockProcess, timeoutMs = 5000) {
  const processExit = new Promise((resolve) => lockProcess.once('exit', resolve));
  lockProcess.kill();
  await withOperationTimeout(() => processExit, 'locked target helper exit', timeoutMs);
}

async function runLockedTargetCase(win, environment, powerShellExecutable, definition, source, runtimeIssues) {
  const outputFile = path.join(environment.mediaDir, definition.outputName);
  const sentinel = Buffer.from(`locked-target-${nodeCrypto.randomUUID()}`);
  fs.writeFileSync(outputFile, sentinel);
  let lockProcess = null;
  const originalDirectoryMode = fs.statSync(environment.mediaDir).mode & 0o777;
  try {
    if (process.platform === 'win32') {
      const lockScript = "$stream=[IO.File]::Open($env:TWITCH_VOD_MANAGER_LOCK_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);[Console]::Out.WriteLine('ready');[Console]::Out.Flush();while($true){Start-Sleep -Milliseconds 250}";
      lockProcess = spawn(powerShellExecutable, ['-NoProfile', '-Command', lockScript], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TWITCH_VOD_MANAGER_LOCK_TARGET: outputFile }
      });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Locked target helper did not start')), 5000);
        lockProcess.stdout.once('data', () => {
          clearTimeout(timeout);
          resolve();
        });
        lockProcess.once('exit', (code) => reject(new Error(`Locked target helper exited with ${code}`)));
      });
    } else {
      fs.chmodSync(environment.mediaDir, 0o500);
    }
    const debugBefore = await readDebugLog(win);
    const result = await exportSource(win, definition, source);
    const debugAfter = await readDebugLog(win);
    assertLockedTargetFailure({ result, debugBefore, debugAfter, outputFile, runtimeIssues });
    if (lockProcess) {
      await stopLockProcess(lockProcess);
      lockProcess = null;
    }
    assertCondition(fs.readFileSync(outputFile).equals(sentinel), 'Locked target contents changed after failed export');
    assertNoExportArtifacts(environment.mediaDir, definition.outputName);
    return result;
  } finally {
    if (lockProcess) await stopLockProcess(lockProcess).catch(() => {});
    if (process.platform !== 'win32' && fs.existsSync(environment.mediaDir)) fs.chmodSync(environment.mediaDir, originalDirectoryMode);
  }
}

async function runCorruptSourceCase(win, environment) {
  const corruptFile = path.join(environment.mediaDir, 'matrix-corrupt.mkv');
  fs.writeFileSync(corruptFile, nodeCrypto.randomBytes(2048));
  const corruptHash = sha256(corruptFile);
  const outputName = 'matrix-corrupt-export.mp4';
  const target = path.join(environment.mediaDir, outputName);
  const sentinel = Buffer.from(`corrupt-target-${nodeCrypto.randomUUID()}`);
  fs.writeFileSync(target, sentinel);
  const prepared = await prepareSource(win, corruptFile);
  assertCondition(prepared.media === null, `Corrupt source unexpectedly prepared: ${JSON.stringify(prepared.media)}`);
  const result = await exportSource(win, { outputName, profile: 'balanced', audioStreamIndex: 0 }, prepared);
  assertCondition(!result.success, `Corrupt source export unexpectedly succeeded: ${JSON.stringify(result)}`);
  assertCondition(sha256(corruptFile) === corruptHash, 'Corrupt source changed during failed export');
  assertCondition(fs.readFileSync(target).equals(sentinel), 'Existing corrupt-source target changed after failed export');
  assertNoExportArtifacts(environment.mediaDir, outputName);
  return result;
}

async function terminateElectronProcess(app, timeoutMs) {
  const child = app.process?.();
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const settle = (error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => settle();
    const onError = (error) => settle(error);
    child.once('exit', onExit);
    child.once('error', onError);
    timeout = setTimeout(() => settle(new Error(`Electron process exit timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      child.kill();
      if (child.exitCode !== null) settle();
    } catch (error) {
      settle(error);
    }
  });
}

async function closeElectronApp(app, closeTimeoutMs = cutterMatrixTimeouts.appClose, processExitTimeoutMs = cutterMatrixTimeouts.appProcessExit) {
  try {
    return await withOperationTimeout(() => app.close(), 'app.close', closeTimeoutMs);
  } catch (error) {
    await terminateElectronProcess(app, processExitTimeoutMs);
    throw error;
  }
}

async function runCutterMatrixLifecycle(options) {
  const environment = options.createEnvironment();
  let app = null;
  let restoreEnvironment = () => {};
  const closeApp = async () => {
    const activeApp = app;
    app = null;
    if (activeApp) await options.closeApp(activeApp);
  };
  try {
    return await options.execute({
      environment,
      closeApp,
      setApp: (value) => { app = value; },
      setRestoreEnvironment: (value) => { restoreEnvironment = value; }
    });
  } finally {
    try {
      await closeApp();
    } finally {
      try {
        restoreEnvironment();
      } finally {
        options.cleanupEnvironment(environment);
      }
    }
  }
}

async function executeCutterMatrix({ environment, closeApp, setApp, setRestoreEnvironment }) {
  assertCondition(process.platform === 'win32', 'Cutter media matrix requires the Windows product toolchain');
  let app;
  const provisionedTools = await provisionManagedCutterTools(environment);
    const runtime = createManagedMediaRuntime(provisionedTools.paths);
    const powerShellExecutable = resolvePowerShellExecutable();
    setRestoreEnvironment(activateOfflineRunnerEnvironment(environment));
    const definitions = createMatrixDefinitions();
    const caseArgument = process.argv.find((argument) => argument.startsWith('--case='));
    const requestedCases = caseArgument ? new Set(caseArgument.slice('--case='.length).split(',').filter(Boolean)) : null;
    const knownCases = new Set([...definitions.map((definition) => definition.id), 'errors']);
    if (requestedCases) {
      const unknownCases = [...requestedCases].filter((id) => !knownCases.has(id));
      assertCondition(unknownCases.length === 0, `Unknown matrix cases: ${unknownCases.join(', ')}`);
    }
    const selectedDefinitions = requestedCases ? definitions.filter((definition) => requestedCases.has(definition.id)) : definitions;
    const includeErrors = !requestedCases || requestedCases.has('errors');
    const fixtureDefinitions = [...selectedDefinitions];
    if (includeErrors && !fixtureDefinitions.some((definition) => definition.id === definitions[0].id)) fixtureDefinitions.push(definitions[0]);
    assertCondition(selectedDefinitions.length > 0 || includeErrors, 'No cutter matrix cases selected');
    const fixtures = fixtureDefinitions.map((definition) => ({ definition, source: createFixture(environment, runtime, definition) }));
    if (process.argv.includes('--fixtures-only')) {
      console.log(JSON.stringify({
        fixtures: fixtures.map((fixture) => ({
          case: fixture.definition.name,
          fileName: path.basename(fixture.source.filePath),
          duration: mediaDuration(fixture.source.probe),
          videoRate: fixture.source.probe.streams.find((stream) => stream.codec_type === 'video')?.avg_frame_rate,
          realVideoRate: fixture.source.probe.streams.find((stream) => stream.codec_type === 'video')?.r_frame_rate,
          audioChannels: fixture.source.probe.streams.filter((stream) => stream.codec_type === 'audio').map((stream) => stream.channels)
        }))
      }, null, 2));
      return;
    }
    const launchOptions = getElectronLaunchOptions(environment);
    launchOptions.env = {
      ...launchOptions.env,
      TWITCH_VOD_MANAGER_E2E_CUTTER_OUTPUT_ROOT: environment.mediaDir
    };
    app = await electron.launch(launchOptions);
    setApp(app);
    const appProcessId = app.process().pid;
    const win = await app.firstWindow();
    const runtimeIssues = [];
    win.on('pageerror', (error) => runtimeIssues.push(`pageerror: ${String(error)}`));
    win.on('console', (message) => {
      if (message.type() === 'error') runtimeIssues.push(`console.error: ${message.text()}`);
    });
    await verifyE2eIsolation(app, win, environment);
    const productToolStatuses = await win.evaluate(() => window.api.getManagedToolStatus());
    assertVerifiedManagedStatus(productToolStatuses.streamlink, provisionedTools.manifest.streamlink.version, 'Electron Streamlink');
    assertVerifiedManagedStatus(productToolStatuses.ffmpeg, provisionedTools.manifest.ffmpeg.version, 'Electron FFmpeg');
    const expectedElectronPath = path.join(environment.rootDir, 'offline-path');
    const electronPath = getEnvironmentValue(launchOptions.env, 'PATH');
    const streamlinkDirectory = path.join(environment.appDataDir, 'tools', 'streamlink');
    const ffmpegDirectory = path.join(environment.appDataDir, 'tools', 'ffmpeg');
    const verifyManagedExecution = async (label, previousDiagnostics = null, requiredTools = []) => {
      const diagnostics = await readManagedExecutionDiagnostics(win);
      assertManagedExecutionDiagnostics({
        diagnostics,
        expectedPaths: provisionedTools.paths,
        streamlinkDirectory,
        ffmpegDirectory,
        electronPath,
        expectedElectronPath,
        previousDiagnostics,
        requiredTools,
        label
      });
      return diagnostics;
    };
    let executionDiagnostics = await verifyManagedExecution('Cutter startup');
    const matrix = [];
    for (const entry of fixtures.filter((fixture) => selectedDefinitions.includes(fixture.definition))) {
      const prepared = await prepareSource(win, entry.source.filePath);
      assertCondition(prepared.media !== null, `${entry.definition.name} source was rejected during production media preparation`);
      assertCondition(prepared.media.info.videoCodec === entry.definition.sourceVideoCodec, `${entry.definition.name} production probe reported ${prepared.media.info.videoCodec}`);
      assertCondition(prepared.media.info.audioStreams.length === entry.definition.audioFrequencies.length, `${entry.definition.name} production probe found ${prepared.media.info.audioStreams.length} audio streams`);
      if (entry.definition.variableFrameRate) assertCondition(prepared.media.info.variableFrameRate, `${entry.definition.name} production probe did not report VFR`);
      const prepareDiagnostics = await verifyManagedExecution(`${entry.definition.name} after prepare`, executionDiagnostics, ['ffprobe']);
      executionDiagnostics = prepareDiagnostics;
      const result = await exportSource(win, entry.definition, prepared);
      assertCondition(result.success, `${entry.definition.name} production export failed: ${JSON.stringify(result)}`);
      const exportDiagnostics = await verifyManagedExecution(`${entry.definition.name} after export`, executionDiagnostics, ['ffmpeg', 'ffprobe']);
      executionDiagnostics = exportDiagnostics;
      matrix.push({
        case: entry.definition.name,
        prepared: {
          duration: prepared.media.info.duration,
          fps: prepared.media.info.fps,
          variableFrameRate: prepared.media.info.variableFrameRate,
          audioStreams: prepared.media.info.audioStreams
        },
        result,
        output: analyzeExport(environment, runtime, entry.definition, entry.source),
        executionDiagnostics: { prepare: prepareDiagnostics, export: exportDiagnostics }
      });
    }
    let lockedTarget = null;
    let corruptSource = null;
    if (includeErrors) {
      const lockedDefinition = { ...definitions[0], outputName: 'matrix-locked-existing.mp4' };
      const lockedSource = fixtures.find((fixture) => fixture.definition.id === definitions[0].id).source;
      const lockedPrepared = await prepareSource(win, lockedSource.filePath);
      assertCondition(lockedPrepared.media !== null, 'Locked target source could not be prepared');
      executionDiagnostics = await verifyManagedExecution('Locked target after prepare', executionDiagnostics, ['ffprobe']);
      lockedTarget = await runLockedTargetCase(win, environment, powerShellExecutable, lockedDefinition, { ...lockedSource, capability: lockedPrepared.capability }, runtimeIssues);
      executionDiagnostics = await verifyManagedExecution('Locked target after export', executionDiagnostics, ['ffmpeg', 'ffprobe']);
      corruptSource = await runCorruptSourceCase(win, environment);
      await verifyManagedExecution('Corrupt source after export', executionDiagnostics, ['ffprobe']);
    }
    assertCondition(runtimeIssues.length === 0, `Cutter matrix runtime issues occurred: ${runtimeIssues.join(' | ')}`);
    await closeApp();
    const cutterTempPrefixes = ['media', 'waveform', 'preview'].map((kind) => `tvm-editor-${kind}-${appProcessId}-`);
    const cutterTempDirectoriesAfterShutdown = fs.readdirSync(os.tmpdir()).filter((name) => cutterTempPrefixes.some((prefix) => name.startsWith(prefix)));
    assertCondition(cutterTempDirectoriesAfterShutdown.length === 0, `Cutter matrix left temporary directories after shutdown: ${JSON.stringify(cutterTempDirectoriesAfterShutdown)}`);
    console.log(JSON.stringify({
      toolchain: {
        statuses: provisionedTools.statuses,
        versions: provisionedTools.versions,
        paths: provisionedTools.paths
      },
      matrix,
      lockedTarget,
      corruptSource,
      runtimeIssues,
      cutterTempDirectoriesAfterShutdown
    }, null, 2));
}

async function run() {
  return await runCutterMatrixLifecycle({
    createEnvironment: () => createE2eEnvironment('cutter-media-matrix', { language: 'en', theme: 'twitch' }),
    cleanupEnvironment: cleanupE2eEnvironment,
    closeApp: closeElectronApp,
    execute: executeCutterMatrix
  });
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  activateOfflineRunnerEnvironment,
  assertLockedTargetFailure,
  assertManagedExecutionDiagnostics,
  assertPinnedVersion,
  assertTrimBoundaryMarkers,
  closeElectronApp,
  createManagedMediaRuntime,
  estimatePcmFrequency,
  exportSource,
  prepareSource,
  provisionManagedCutterTools,
  runCutterMatrixLifecycle,
  sampleVideoRgb
};

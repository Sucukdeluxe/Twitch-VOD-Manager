const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
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
} = require('./smoke-test-cutter-media-matrix');

function createEnvironment() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-cutter-toolchain-contract-'));
  const appDataDir = path.join(rootDir, 'programdata', 'Twitch_VOD_Manager');
  fs.mkdirSync(appDataDir, { recursive: true });
  return { rootDir, appDataDir };
}

function createProvisioningFixture() {
  const manifest = {
    streamlink: { id: 'streamlink', version: '8.4.0' },
    ffmpeg: { id: 'ffmpeg', version: '8.1.2' }
  };
  let initializedDirectories = null;
  const tools = {
    initToolDirs(streamlinkDirectory, ffmpegDirectory, getTemporaryDirectory) {
      initializedDirectories = {
        streamlinkDirectory,
        ffmpegDirectory,
        temporaryDirectory: getTemporaryDirectory()
      };
    },
    async repairManagedTools() {
      const streamlinkPath = path.join(initializedDirectories.streamlinkDirectory, 'bin', 'streamlink.exe');
      const ffmpegPath = path.join(initializedDirectories.ffmpegDirectory, 'bin', 'ffmpeg.exe');
      const ffprobePath = path.join(initializedDirectories.ffmpegDirectory, 'bin', 'ffprobe.exe');
      for (const filePath of [streamlinkPath, ffmpegPath, ffprobePath]) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, path.basename(filePath));
      }
      return {
        success: true,
        statuses: {
          streamlink: { state: 'verified', verified: true, version: manifest.streamlink.version },
          ffmpeg: { state: 'verified', verified: true, version: manifest.ffmpeg.version }
        }
      };
    },
    getStreamlinkPath() {
      return path.join(initializedDirectories.streamlinkDirectory, 'bin', 'streamlink.exe');
    },
    getFFmpegPath() {
      return path.join(initializedDirectories.ffmpegDirectory, 'bin', 'ffmpeg.exe');
    },
    getFFprobePath() {
      return path.join(initializedDirectories.ffmpegDirectory, 'bin', 'ffprobe.exe');
    }
  };
  return {
    manifest,
    tools,
    getInitializedDirectories: () => initializedDirectories
  };
}

test('provisions and verifies the pinned product toolchain inside the isolated AppData tree', async (t) => {
  const environment = createEnvironment();
  t.after(() => fs.rmSync(environment.rootDir, { recursive: true, force: true }));
  const fixture = createProvisioningFixture(environment);

  const result = await provisionManagedCutterTools(environment, {
    loadBuiltArtifacts: () => ({ tools: fixture.tools, manifest: fixture.manifest }),
    runVersionCheck: (executablePath, _args, label) => {
      if (label.includes('Streamlink')) return 'Streamlink 8.4.0';
      if (path.basename(executablePath).toLowerCase() === 'ffprobe.exe') return 'ffprobe version 8.1.2';
      return 'ffmpeg version 8.1.2';
    }
  });

  const initialized = fixture.getInitializedDirectories();
  assert.deepEqual(initialized, {
    streamlinkDirectory: path.join(environment.appDataDir, 'tools', 'streamlink'),
    ffmpegDirectory: path.join(environment.appDataDir, 'tools', 'ffmpeg'),
    temporaryDirectory: path.join(environment.rootDir, 'managed-tools-temp')
  });
  assert.equal(result.statuses.streamlink.verified, true);
  assert.equal(result.statuses.ffmpeg.verified, true);
  assert.equal(result.versions.streamlink, 'Streamlink 8.4.0');
  assert.equal(result.versions.ffmpeg, 'ffmpeg version 8.1.2');
  assert.equal(result.versions.ffprobe, 'ffprobe version 8.1.2');
  assert.equal(result.paths.ffmpeg, fs.realpathSync.native(path.join(initialized.ffmpegDirectory, 'bin', 'ffmpeg.exe')));
  assert.equal(result.paths.ffprobe, fs.realpathSync.native(path.join(initialized.ffmpegDirectory, 'bin', 'ffprobe.exe')));
  assert.equal(result.paths.streamlink, fs.realpathSync.native(path.join(initialized.streamlinkDirectory, 'bin', 'streamlink.exe')));
});

test('rejects a product tool path that escapes the owned installation directory', async (t) => {
  const environment = createEnvironment();
  t.after(() => fs.rmSync(environment.rootDir, { recursive: true, force: true }));
  const fixture = createProvisioningFixture(environment);
  const outsidePath = path.join(environment.rootDir, 'outside-ffmpeg.exe');
  fs.writeFileSync(outsidePath, 'outside');
  fixture.tools.getFFmpegPath = () => outsidePath;

  await assert.rejects(() => provisionManagedCutterTools(environment, {
    loadBuiltArtifacts: () => ({ tools: fixture.tools, manifest: fixture.manifest }),
    runVersionCheck: () => '8.1.2'
  }), /outside the owned managed-tool directory/);
});

test('rejects a managed tool that is not verified at the manifest version', async (t) => {
  const environment = createEnvironment();
  t.after(() => fs.rmSync(environment.rootDir, { recursive: true, force: true }));
  const fixture = createProvisioningFixture();
  const repairManagedTools = fixture.tools.repairManagedTools;
  fixture.tools.repairManagedTools = async () => {
    const result = await repairManagedTools();
    result.statuses.ffmpeg.verified = false;
    result.statuses.ffmpeg.state = 'corrupt';
    return result;
  };

  await assert.rejects(() => provisionManagedCutterTools(environment, {
    loadBuiltArtifacts: () => ({ tools: fixture.tools, manifest: fixture.manifest }),
    runVersionCheck: () => '8.1.2'
  }), /FFmpeg is not verified at pinned 8\.1\.2/);
});

test('rejects executable version output that differs from the pinned manifest', async (t) => {
  const environment = createEnvironment();
  t.after(() => fs.rmSync(environment.rootDir, { recursive: true, force: true }));
  const fixture = createProvisioningFixture();

  await assert.rejects(() => provisionManagedCutterTools(environment, {
    loadBuiltArtifacts: () => ({ tools: fixture.tools, manifest: fixture.manifest }),
    runVersionCheck: (_executablePath, _args, label) => label === 'FFmpeg' ? 'ffmpeg version 7.0.0' : label === 'FFprobe' ? 'ffprobe version 8.1.2' : 'Streamlink 8.4.0'
  }), /FFmpeg version output does not match pinned 8\.1\.2/);
});

test('media runtime always executes the verified absolute product paths', () => {
  const calls = [];
  const runtime = createManagedMediaRuntime({
    ffmpeg: 'C:\\owned\\tools\\ffmpeg.exe',
    ffprobe: 'C:\\owned\\tools\\ffprobe.exe'
  }, (binary, args) => {
    calls.push({ binary, args });
    return { status: 0, stdout: `${path.win32.basename(binary)}:${args.join(',')}`, stderr: '' };
  });

  assert.equal(runtime.ffmpeg(['-i', 'fixture.mkv']), 'ffmpeg.exe:-i,fixture.mkv');
  assert.equal(runtime.ffprobe(['-show_streams', 'fixture.mkv']), 'ffprobe.exe:-show_streams,fixture.mkv');
  assert.deepEqual(calls, [
    { binary: 'C:\\owned\\tools\\ffmpeg.exe', args: ['-i', 'fixture.mkv'] },
    { binary: 'C:\\owned\\tools\\ffprobe.exe', args: ['-show_streams', 'fixture.mkv'] }
  ]);
});

test('offline runner environment removes PATH and network fallback until restored', (t) => {
  const environment = createEnvironment();
  t.after(() => fs.rmSync(environment.rootDir, { recursive: true, force: true }));
  const variables = {
    PATH: 'C:\\system-tools',
    HTTP_PROXY: 'http://proxy.example.test:8080',
    HTTPS_PROXY: 'http://proxy.example.test:8080',
    ALL_PROXY: 'http://proxy.example.test:8080',
    NO_PROXY: 'localhost',
    LOCALAPPDATA: 'C:\\Users\\regular\\AppData\\Local',
    APPDATA: 'C:\\Users\\regular\\AppData\\Roaming',
    TEMP: 'C:\\Windows\\Temp',
    TMP: 'C:\\Windows\\Temp'
  };

  const restore = activateOfflineRunnerEnvironment(environment, variables);
  assert.equal(variables.PATH, path.join(environment.rootDir, 'offline-path'));
  assert.equal(variables.HTTP_PROXY, 'http://127.0.0.1:1');
  assert.equal(variables.HTTPS_PROXY, 'http://127.0.0.1:1');
  assert.equal(variables.ALL_PROXY, 'http://127.0.0.1:1');
  assert.equal(variables.NO_PROXY, '');
  assert.equal(variables.LOCALAPPDATA, path.join(environment.rootDir, 'localappdata'));
  assert.equal(variables.APPDATA, path.join(environment.rootDir, 'roamingappdata'));
  assert.equal(variables.TEMP, path.join(environment.rootDir, 'runtime-temp'));
  assert.equal(variables.TMP, path.join(environment.rootDir, 'runtime-temp'));
  assert.equal(fs.statSync(variables.PATH).isDirectory(), true);

  restore();
  assert.deepEqual(variables, {
    PATH: 'C:\\system-tools',
    HTTP_PROXY: 'http://proxy.example.test:8080',
    HTTPS_PROXY: 'http://proxy.example.test:8080',
    ALL_PROXY: 'http://proxy.example.test:8080',
    NO_PROXY: 'localhost',
    LOCALAPPDATA: 'C:\\Users\\regular\\AppData\\Local',
    APPDATA: 'C:\\Users\\regular\\AppData\\Roaming',
    TEMP: 'C:\\Windows\\Temp',
    TMP: 'C:\\Windows\\Temp'
  });
});

test('requires the exact pinned executable version instead of a substring match', () => {
  assert.doesNotThrow(() => assertPinnedVersion('ffmpeg version 8.1.2 Copyright FFmpeg developers', '8.1.2', 'FFmpeg'));
  assert.doesNotThrow(() => assertPinnedVersion('ffmpeg version 8.1.2-essentials_build-www.gyan.dev Copyright FFmpeg developers', '8.1.2', 'FFmpeg'));
  assert.doesNotThrow(() => assertPinnedVersion('ffprobe version 8.1.2 Copyright FFmpeg developers', '8.1.2', 'FFprobe'));
  assert.doesNotThrow(() => assertPinnedVersion('ffprobe version 8.1.2-essentials_build-www.gyan.dev Copyright FFmpeg developers', '8.1.2', 'FFprobe'));
  assert.doesNotThrow(() => assertPinnedVersion('Streamlink 8.4.0', '8.4.0', 'Streamlink'));
  assert.throws(() => assertPinnedVersion('ffmpeg version 8.1.20-essentials_build-www.gyan.dev', '8.1.2', 'FFmpeg'), /does not match pinned 8\.1\.2/);
  assert.throws(() => assertPinnedVersion('ffmpeg version 18.1.2-essentials_build-www.gyan.dev', '8.1.2', 'FFmpeg'), /does not match pinned 8\.1\.2/);
  assert.throws(() => assertPinnedVersion('ffmpeg version 8.1.2-evil', '8.1.2', 'FFmpeg'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('ffmpeg version 8.1.2+evil', '8.1.2', 'FFmpeg'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('ffmpeg version 8.1.2---', '8.1.2', 'FFmpeg'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('ffmpeg version 8.1.2evil', '8.1.2', 'FFmpeg'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('ffmpeg version 8.1.2-', '8.1.2', 'FFmpeg'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('ffmpeg version 8.1.2-evil!', '8.1.2', 'FFmpeg'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('ffmpeg version v8.1.2', '8.1.2', 'FFmpeg'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('ffmpeg version 08.1.2', '8.1.2', 'FFmpeg'), /does not match pinned 8\.1\.2/);
  assert.throws(() => assertPinnedVersion('ffmpeg version 8.1.2.0', '8.1.2', 'FFmpeg'), /does not match pinned 8\.1\.2/);
  assert.throws(() => assertPinnedVersion('ffprobe version 8.1.2evil', '8.1.2', 'FFprobe'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('ffprobe version 8.1.2-evil', '8.1.2', 'FFprobe'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('ffprobe version v8.1.2', '8.1.2', 'FFprobe'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('ffprobe version 08.1.2', '8.1.2', 'FFprobe'), /does not match pinned 8\.1\.2/);
  assert.throws(() => assertPinnedVersion('ffprobe version 8.1.2.0', '8.1.2', 'FFprobe'), /does not match pinned 8\.1\.2/);
  assert.throws(() => assertPinnedVersion('Streamlink 8.4.0evil', '8.4.0', 'Streamlink'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('Streamlink 8.4.0-evil', '8.4.0', 'Streamlink'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('Streamlink 8.4.0+evil', '8.4.0', 'Streamlink'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('Streamlink 8.4.0-essentials_build-www.gyan.dev', '8.4.0', 'Streamlink'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('Streamlink 8.4.0+', '8.4.0', 'Streamlink'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('Streamlink v8.4.0', '8.4.0', 'Streamlink'), /does not expose a parseable version/);
  assert.throws(() => assertPinnedVersion('Streamlink 08.4.0', '8.4.0', 'Streamlink'), /does not match pinned 8\.4\.0/);
  assert.throws(() => assertPinnedVersion('Streamlink 8.4.0.1', '8.4.0', 'Streamlink'), /does not match pinned 8\.4\.0/);
  assert.throws(() => assertPinnedVersion('custom wrapper contains 8.1.2', '8.1.2', 'FFmpeg'), /does not expose a parseable version/);
});

test('prepare source has its own bounded operation timeout', async () => {
  const win = { evaluate: () => new Promise(() => {}) };
  await assert.rejects(() => prepareSource(win, 'C:\\media\\source.mp4', {
    timeoutMs: 15,
    createCapability: async () => ({ token: 'a'.repeat(32), name: 'source.mp4' })
  }), /prepareSource timed out after 15ms/);
});

test('export source has its own bounded operation timeout', async () => {
  const win = { evaluate: () => new Promise(() => {}) };
  await assert.rejects(() => exportSource(win, {
    outputName: 'result.mp4',
    profile: 'balanced',
    audioStreamIndex: 0
  }, {
    capability: { token: 'b'.repeat(32), name: 'source.mp4' }
  }, 15), /exportSource timed out after 15ms/);
});

test('Electron app close has its own bounded operation timeout', async () => {
  const app = { close: () => new Promise(() => {}) };
  await assert.rejects(() => closeElectronApp(app, 15), /app.close timed out after 15ms/);
});

test('runner exposes a bounded success shutdown that cannot hang and is not retried', async () => {
  const environment = createEnvironment();
  const child = new EventEmitter();
  child.exitCode = null;
  const events = [];
  let closeCalls = 0;
  let receivedClose = false;
  child.kill = () => {
    events.push('kill');
    setTimeout(() => {
      child.exitCode = 1;
      events.push('exit');
      child.emit('exit', 1, null);
    }, 5);
    return true;
  };
  await assert.rejects(() => runCutterMatrixLifecycle({
    createEnvironment: () => environment,
    cleanupEnvironment: (value) => {
      events.push('cleanup');
      fs.rmSync(value.rootDir, { recursive: true, force: true });
    },
    closeApp: async (app) => {
      closeCalls += 1;
      await closeElectronApp(app, 15, 30);
    },
    execute: async ({ setApp, closeApp }) => {
      setApp({
        close: () => {
          events.push('close');
          return new Promise(() => {});
        },
        process: () => child
      });
      receivedClose = typeof closeApp === 'function';
      await closeApp();
    }
  }), /app\.close timed out after 15ms/);
  assert.equal(receivedClose, true);
  assert.equal(closeCalls, 1);
  assert.deepEqual(events, ['close', 'kill', 'exit', 'cleanup']);
  assert.equal(fs.existsSync(environment.rootDir), false);
});

test('process exit fallback after app close timeout has its own bound', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => true;
  const app = {
    close: () => new Promise(() => {}),
    process: () => child
  };
  await assert.rejects(() => closeElectronApp(app, 10, 15), /Electron process exit timed out after 15ms/);
  assert.equal(child.listenerCount('exit'), 0);
});

test('runner releases a successfully closed app before lifecycle cleanup', async () => {
  const environment = createEnvironment();
  let closeCalls = 0;
  let closedBeforeExecuteReturned = false;
  await runCutterMatrixLifecycle({
    createEnvironment: () => environment,
    cleanupEnvironment: (value) => fs.rmSync(value.rootDir, { recursive: true, force: true }),
    closeApp: async () => { closeCalls += 1; },
    execute: async ({ setApp, closeApp }) => {
      setApp({});
      await closeApp();
      closedBeforeExecuteReturned = true;
    }
  });
  assert.equal(closedBeforeExecuteReturned, true);
  assert.equal(closeCalls, 1);
  assert.equal(fs.existsSync(environment.rootDir), false);
});

test('runner lifecycle restores the process environment and removes its tree after failure', async () => {
  const environment = createEnvironment();
  const variables = { PATH: 'C:\\original-tools' };
  const failure = new Error('matrix failed');
  await assert.rejects(() => runCutterMatrixLifecycle({
    createEnvironment: () => environment,
    cleanupEnvironment: (value) => fs.rmSync(value.rootDir, { recursive: true, force: true }),
    closeApp: async () => {},
    execute: async ({ setApp, setRestoreEnvironment }) => {
      setApp({});
      setRestoreEnvironment(activateOfflineRunnerEnvironment(environment, variables));
      assert.equal(variables.PATH, path.join(environment.rootDir, 'offline-path'));
      throw failure;
    }
  }), (error) => error === failure);
  assert.deepEqual(variables, { PATH: 'C:\\original-tools' });
  assert.equal(fs.existsSync(environment.rootDir), false);
});

test('runner lifecycle still restores and cleans up when bounded app close fails', async () => {
  const environment = createEnvironment();
  const variables = { PATH: 'C:\\original-tools' };
  await assert.rejects(() => runCutterMatrixLifecycle({
    createEnvironment: () => environment,
    cleanupEnvironment: (value) => fs.rmSync(value.rootDir, { recursive: true, force: true }),
    closeApp: async () => { throw new Error('app.close timed out after 15ms'); },
    execute: async ({ setApp, setRestoreEnvironment }) => {
      setApp({});
      setRestoreEnvironment(activateOfflineRunnerEnvironment(environment, variables));
    }
  }), /app\.close timed out after 15ms/);
  assert.deepEqual(variables, { PATH: 'C:\\original-tools' });
  assert.equal(fs.existsSync(environment.rootDir), false);
});

test('locked target requires a resolved production publish failure with a Windows lock diagnostic', () => {
  const before = '[2026-08-13T00:00:00.000Z] startup';
  const outputFile = 'C:\\media\\result.mp4';
  const after = `${before}\n[2026-08-13T00:00:01.000Z] video-editor-export-failed | Error: EPERM: operation not permitted, rename 'C:\\media\\.result.tvm-edit.mp4' -> '${outputFile}'`;
  assert.doesNotThrow(() => assertLockedTargetFailure({
    result: { success: false, outputName: null },
    debugBefore: before,
    debugAfter: after,
    outputFile,
    runtimeIssues: []
  }));
  assert.doesNotThrow(() => assertLockedTargetFailure({
    result: { success: false, outputName: null },
    debugBefore: before,
    debugAfter: `${before}\n[2026-08-13T00:00:01.000Z] video-editor-export-failed | Error: EBUSY: resource busy or locked, rename '${outputFile}' -> '${outputFile}.42.123.tvm-backup'`,
    outputFile,
    runtimeIssues: []
  }));
  assert.throws(() => assertLockedTargetFailure({
    result: { success: false, rejected: 'Error: IPC connection closed' },
    debugBefore: before,
    debugAfter: after,
    outputFile,
    runtimeIssues: []
  }), /must resolve through the product IPC/);
  assert.throws(() => assertLockedTargetFailure({
    result: { success: false, outputName: null },
    debugBefore: before,
    debugAfter: `${before}\n[2026-08-13T00:00:01.000Z] unrelated-failure`,
    outputFile,
    runtimeIssues: []
  }), /atomic publish lock diagnostic/);
  assert.throws(() => assertLockedTargetFailure({
    result: { success: false, cancelled: true, outputName: null },
    debugBefore: before,
    debugAfter: after,
    outputFile,
    runtimeIssues: []
  }), /must not be reported as cancelled/);
  assert.throws(() => assertLockedTargetFailure({
    result: { success: false, outputName: null },
    debugBefore: before,
    debugAfter: after,
    outputFile,
    runtimeIssues: ['pageerror: renderer crashed']
  }), /runtime issues/);
  assert.throws(() => assertLockedTargetFailure({
    result: { success: false, outputName: null },
    debugBefore: before,
    debugAfter: `${before}\n[2026-08-13T00:00:01.000Z] video-editor-export-failed\n[2026-08-13T00:00:02.000Z] unrelated | Error: EPERM: operation not permitted, rename 'C:\\media\\.other.tvm-edit.mp4' -> 'C:\\media\\other.mp4'`,
    outputFile,
    runtimeIssues: []
  }), /atomic publish lock diagnostic/);
  assert.throws(() => assertLockedTargetFailure({
    result: { success: false, outputName: null },
    debugBefore: before,
    debugAfter: `${before}\n[2026-08-13T00:00:01.000Z] video-editor-export-failed | Error: EPERM: operation not permitted, rename 'C:\\media\\.result.tvm-edit.mp4' -> '${outputFile}.backup'`,
    outputFile,
    runtimeIssues: []
  }), /atomic publish lock diagnostic/);
  assert.throws(() => assertLockedTargetFailure({
    result: { success: false, outputName: null },
    debugBefore: before,
    debugAfter: `${before}\n[2026-08-13T00:00:01.000Z] video-editor-export-failed | Error: EPERM: operation not permitted, rename 'C:\\media\\.result.tvm-edit.mp4' -> 'C:\\media\\prefix-result.mp4'`,
    outputFile,
    runtimeIssues: []
  }), /atomic publish lock diagnostic/);
});

test('managed execution snapshots prove exact owned paths and operation-specific counter deltas', () => {
  const rootDir = path.join('C:\\runner', 'matrix');
  const streamlinkDirectory = path.join(rootDir, 'programdata', 'Twitch_VOD_Manager', 'tools', 'streamlink');
  const ffmpegDirectory = path.join(rootDir, 'programdata', 'Twitch_VOD_Manager', 'tools', 'ffmpeg');
  const paths = {
    streamlink: path.join(streamlinkDirectory, 'bin', 'streamlink.exe'),
    ffmpeg: path.join(ffmpegDirectory, 'bin', 'ffmpeg.exe'),
    ffprobe: path.join(ffmpegDirectory, 'bin', 'ffprobe.exe')
  };
  const baseline = {
    ffmpeg: { path: null, count: 0 },
    ffprobe: { path: null, count: 0 },
    streamlink: { path: null, count: 0 }
  };
  const afterPrepare = {
    ffmpeg: { path: null, count: 0 },
    ffprobe: { path: paths.ffprobe, count: 1 },
    streamlink: { path: null, count: 0 }
  };
  const afterExport = {
    ffmpeg: { path: paths.ffmpeg, count: 1 },
    ffprobe: { path: paths.ffprobe, count: 2 },
    streamlink: { path: null, count: 0 }
  };
  assert.doesNotThrow(() => assertManagedExecutionDiagnostics({
    diagnostics: afterPrepare,
    expectedPaths: paths,
    streamlinkDirectory,
    ffmpegDirectory,
    electronPath: path.join(rootDir, 'offline-path'),
    expectedElectronPath: path.join(rootDir, 'offline-path'),
    previousDiagnostics: baseline,
    requiredTools: ['ffprobe'],
    label: 'after prepare'
  }));
  assert.doesNotThrow(() => assertManagedExecutionDiagnostics({
    diagnostics: afterExport,
    expectedPaths: paths,
    streamlinkDirectory,
    ffmpegDirectory,
    electronPath: path.join(rootDir, 'offline-path'),
    expectedElectronPath: path.join(rootDir, 'offline-path'),
    previousDiagnostics: afterPrepare,
    requiredTools: ['ffmpeg', 'ffprobe'],
    label: 'after export'
  }));
  assert.throws(() => assertManagedExecutionDiagnostics({
    diagnostics: {
      ffmpeg: { path: 'C:\\system\\ffmpeg.exe', count: 1 },
      ffprobe: { path: paths.ffprobe, count: 2 },
      streamlink: { path: null, count: 0 }
    },
    expectedPaths: paths,
    streamlinkDirectory,
    ffmpegDirectory,
    electronPath: path.join(rootDir, 'offline-path'),
    expectedElectronPath: path.join(rootDir, 'offline-path'),
    label: 'after export'
  }), /did not execute the provisioned FFmpeg path/);
  assert.throws(() => assertManagedExecutionDiagnostics({
    diagnostics: afterPrepare,
    expectedPaths: paths,
    streamlinkDirectory,
    ffmpegDirectory,
    electronPath: 'C:\\Windows\\System32',
    expectedElectronPath: path.join(rootDir, 'offline-path'),
    label: 'after prepare'
  }), /Electron PATH escaped isolation/);
  assert.throws(() => assertManagedExecutionDiagnostics({
    diagnostics: afterPrepare,
    expectedPaths: paths,
    streamlinkDirectory,
    ffmpegDirectory,
    electronPath: path.join(rootDir, 'offline-path'),
    expectedElectronPath: path.join(rootDir, 'offline-path'),
    previousDiagnostics: afterPrepare,
    requiredTools: ['ffprobe'],
    label: 'after prepare'
  }), /did not record a new FFprobe execution/);
  assert.throws(() => assertManagedExecutionDiagnostics({
    diagnostics: baseline,
    expectedPaths: paths,
    streamlinkDirectory,
    ffmpegDirectory,
    electronPath: path.join(rootDir, 'offline-path'),
    expectedElectronPath: path.join(rootDir, 'offline-path'),
    previousDiagnostics: afterExport,
    requiredTools: [],
    label: 'regressed snapshot'
  }), /FFmpeg execution count regressed/);
});

function createPcmTone(frequency, durationSeconds = 0.1, sampleRate = 48000) {
  const samples = Math.round(durationSeconds * sampleRate);
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * index / sampleRate) * 24000), index * 2);
  }
  return buffer;
}

test('decoded PCM frequency estimation distinguishes the trim boundary audio markers', () => {
  assert.ok(Math.abs(estimatePcmFrequency(createPcmTone(440), 48000) - 440) <= 5);
  assert.ok(Math.abs(estimatePcmFrequency(createPcmTone(1760), 48000) - 1760) <= 10);
});

test('video marker sampling decodes before seeking for timestamp-offset containers', () => {
  let args = null;
  const rgb = sampleVideoRgb({
    ffmpegBuffer(nextArgs) {
      args = nextArgs;
      return Buffer.from([12, 34, 56]);
    }
  }, 'fixture.ts', 0.3);
  assert.deepEqual(rgb, [12, 34, 56]);
  assert.ok(args.indexOf('-i') < args.indexOf('-ss'));
});

test('trim boundary validation rejects a same-duration export from the wrong source interval', () => {
  const correctMarkers = {
    startVideoRgb: [18, 150, 22],
    endVideoRgb: [20, 170, 175],
    startAudioFrequency: 440,
    endAudioFrequency: 1760
  };
  assert.doesNotThrow(() => assertTrimBoundaryMarkers(correctMarkers, 'fixture'));
  assert.throws(() => assertTrimBoundaryMarkers({
    ...correctMarkers,
    startVideoRgb: [180, 20, 18]
  }, 'wrong interval'), /start video marker/);
  assert.throws(() => assertTrimBoundaryMarkers({
    ...correctMarkers,
    endVideoRgb: [170, 20, 160]
  }, 'wrong interval'), /end video marker/);
  assert.throws(() => assertTrimBoundaryMarkers({
    ...correctMarkers,
    startAudioFrequency: 220
  }, 'wrong interval'), /start audio marker/);
  assert.throws(() => assertTrimBoundaryMarkers({
    ...correctMarkers,
    endAudioFrequency: 880
  }, 'wrong interval'), /end audio marker/);
});

const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertOwnedPath,
  buildStreamlinkArguments,
  compareVersions,
  parseGateMode,
  parseLatestYaml,
  readLiveConfiguration,
  redactDiagnostic,
  sanitizeChildEnvironment,
  validateMediaProbe,
  validateDownloadedReleaseArtifact,
  validateProductionRelease,
  validateUpdateCacheRecord,
  validateTwitchToken
} = require('./smoke-test-live-integration-contract');
const {
  checkPackagedUpdate,
  closeElectronApp,
  createUpdaterDownloadReadySummary,
  getPackagedVersion,
  inspectProductionRelease,
  requestProductTwitchToken,
  runWithElectronAppCleanup,
  runWithOwnedRoot,
  startUpdaterDownload,
  verifyProductTwitchProviderFallbacks
} = require('./smoke-test-live-integration');
const PACKAGE_VERSION = require('../package.json').version;

const TWITCH_ENVIRONMENT = {
  TWITCH_VOD_MANAGER_LIVE_INTEGRATION: '1',
  TWITCH_VOD_MANAGER_LIVE_TWITCH_CLIENT_ID: 'client-id-value',
  TWITCH_VOD_MANAGER_LIVE_TWITCH_CLIENT_SECRET: 'client-secret-value',
  TWITCH_VOD_MANAGER_LIVE_TWITCH_LOGIN: 'example_channel',
  TWITCH_VOD_MANAGER_LIVE_TWITCH_VOD_ID: '1234567890'
};

const UPDATE_SHA512 = Buffer.alloc(64, 7).toString('base64');
const UPDATE_COMMIT_SHA = 'b'.repeat(40);

function releaseYaml(version = PACKAGE_VERSION) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: Twitch-VOD-Manager-Setup-${version}.exe`,
    `    sha512: ${UPDATE_SHA512}`,
    '    size: 120000000',
    `path: Twitch-VOD-Manager-Setup-${version}.exe`,
    `sha512: ${UPDATE_SHA512}`,
    "releaseDate: '2026-08-13T10:00:00.000Z'"
  ].join('\n');
}

function releaseInspectionDependencies(commitSha = UPDATE_COMMIT_SHA) {
  const calls = [];
  return {
    calls,
    requestJson: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/releases/latest')) {
        return {
          assets: [
            { name: `Twitch-VOD-Manager-Setup-${PACKAGE_VERSION}.exe`, size: 120000000 },
            { name: 'latest.yml', size: 1024 }
          ],
          draft: false,
          prerelease: false,
          tag_name: `v${PACKAGE_VERSION}`
        };
      }
      if (String(url).endsWith(`/commits/v${PACKAGE_VERSION}`)) return { sha: commitSha };
      throw new Error(`Unexpected JSON request: ${url}`);
    },
    requestLatestYaml: async (url) => {
      calls.push(String(url));
      return releaseYaml();
    }
  };
}

function updaterEnvironment(overrides = {}) {
  return {
    GITHUB_REF: `refs/tags/v${PACKAGE_VERSION}`,
    GITHUB_SHA: UPDATE_COMMIT_SHA,
    TWITCH_VOD_MANAGER_LIVE_INTEGRATION: '1',
    TWITCH_VOD_MANAGER_LIVE_SOURCE_VERSION: '0.0.1',
    TWITCH_VOD_MANAGER_LIVE_SOURCE_SHA256: 'a'.repeat(64),
    TWITCH_VOD_MANAGER_LIVE_UPDATE_COMMIT_SHA: UPDATE_COMMIT_SHA,
    TWITCH_VOD_MANAGER_LIVE_UPDATE_VERSION: PACKAGE_VERSION,
    TWITCH_VOD_MANAGER_LIVE_UPDATE_SHA512: UPDATE_SHA512,
    ...overrides
  };
}

test('refuses every live mode until the explicit opt-in is set', () => {
  assert.throws(
    () => readLiveConfiguration('twitch', { ...TWITCH_ENVIRONMENT, TWITCH_VOD_MANAGER_LIVE_INTEGRATION: undefined }),
    /TWITCH_VOD_MANAGER_LIVE_INTEGRATION=1/
  );
  assert.throws(
    () => readLiveConfiguration('updater', {}),
    /TWITCH_VOD_MANAGER_LIVE_INTEGRATION=1/
  );
});

test('keeps Twitch credentials scoped to the Twitch gate while updater requires explicit release pins', () => {
  const twitch = readLiveConfiguration('twitch', TWITCH_ENVIRONMENT);
  assert.equal(twitch.twitch.clientId, 'client-id-value');
  assert.equal(twitch.twitch.clientSecret, 'client-secret-value');
  assert.equal(twitch.twitch.login, 'example_channel');
  assert.equal(twitch.twitch.vodId, '1234567890');

  assert.throws(
    () => readLiveConfiguration('updater', { TWITCH_VOD_MANAGER_LIVE_INTEGRATION: '1' }),
    /TWITCH_VOD_MANAGER_LIVE_SOURCE_VERSION/
  );

  const updater = readLiveConfiguration('updater', updaterEnvironment());
  assert.equal(updater.twitch, undefined);
  assert.equal(updater.updater.sourceVersion, '0.0.1');
  assert.equal(updater.updater.sourceSha256, 'a'.repeat(64));
  assert.equal(updater.updater.expectedVersion, PACKAGE_VERSION);
  assert.equal(updater.updater.expectedSha512, UPDATE_SHA512);
  assert.equal(updater.updater.expectedCommitSha, UPDATE_COMMIT_SHA);
  assert.equal(updater.updater.packagedAppPath, undefined);

  const override = readLiveConfiguration('updater', updaterEnvironment({
    TWITCH_VOD_MANAGER_LIVE_PACKAGED_APP_PATH: 'C:\\fixtures\\Twitch VOD Manager.exe',
  }));
  assert.equal(override.updater.packagedAppPath, 'C:\\fixtures\\Twitch VOD Manager.exe');
  assert.equal(override.updater.sourceVersion, '0.0.1');
  assert.equal(override.updater.expectedVersion, PACKAGE_VERSION);
  assert.equal(override.updater.expectedSha512, UPDATE_SHA512);
});

test('rejects every missing updater pin and binds the target to package version and release tag', () => {
  for (const name of [
    'TWITCH_VOD_MANAGER_LIVE_SOURCE_VERSION',
    'TWITCH_VOD_MANAGER_LIVE_SOURCE_SHA256',
    'TWITCH_VOD_MANAGER_LIVE_UPDATE_COMMIT_SHA',
    'TWITCH_VOD_MANAGER_LIVE_UPDATE_VERSION',
    'TWITCH_VOD_MANAGER_LIVE_UPDATE_SHA512'
  ]) {
    assert.throws(
      () => readLiveConfiguration('updater', updaterEnvironment({ [name]: undefined })),
      (error) => error instanceof Error && error.message.includes(name)
    );
  }
  assert.throws(
    () => readLiveConfiguration('updater', updaterEnvironment({ TWITCH_VOD_MANAGER_LIVE_UPDATE_VERSION: '99.0.0', GITHUB_REF: 'refs/tags/v99.0.0' })),
    /package version/
  );
  assert.throws(
    () => readLiveConfiguration('updater', updaterEnvironment({ GITHUB_REF: 'refs/heads/main' })),
    /release tag/
  );
  assert.throws(
    () => readLiveConfiguration('updater', updaterEnvironment({ TWITCH_VOD_MANAGER_LIVE_UPDATE_COMMIT_SHA: 'abc' })),
    /UPDATE_COMMIT_SHA/
  );
  assert.throws(
    () => readLiveConfiguration('updater', updaterEnvironment({ GITHUB_SHA: 'c'.repeat(40) })),
    /current workflow commit/
  );
  for (const version of ['1.0.18-alpha', '1.0.18+build', '01.0.18', '1.00.18', '1.0.18.0', '1234567890.0.0']) {
    assert.throws(
      () => readLiveConfiguration('updater', updaterEnvironment({
        GITHUB_REF: `refs/tags/v${version}`,
        TWITCH_VOD_MANAGER_LIVE_UPDATE_VERSION: version
      })),
      /numeric release version/
    );
  }
});

test('obtains the live credential through the built Twitch token product path', async () => {
  const product = require('../dist/main/twitch');
  assert.equal(requestProductTwitchToken.length, 1);
  assert.equal(typeof product.TwitchAppTokenService, 'function');
  assert.equal(typeof product.requestTwitchAppAccessToken, 'function');
  let requests = 0;
  const request = async (url, options, timeoutMs) => {
    requests += 1;
    assert.equal(url.origin + url.pathname, 'https://id.twitch.tv/oauth2/token');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      client_id: 'client-id-value',
      client_secret: 'client-secret-value',
      grant_type: 'client_credentials'
    });
    assert.deepEqual(options, { method: 'POST' });
    assert.equal(timeoutMs, 30000);
    return { access_token: 'live-product-token', expires_in: 3600, token_type: 'bearer' };
  };
  const token = await requestProductTwitchToken(
    { clientId: 'client-id-value', clientSecret: 'client-secret-value' },
    request
  );
  assert.deepEqual(token, {
    accessToken: 'live-product-token',
    tokenPayload: { access_token: 'live-product-token', expires_in: 3600, token_type: 'bearer' }
  });
  assert.equal(requests, 1);
});

test('runs Helix, public GQL, and offline last-good through the built Twitch provider product paths', async () => {
  const calls = [];
  const client = {
    async get(url, config) {
      calls.push({ config, method: 'GET', url });
      assert.deepEqual(config.headers, {
        'Client-ID': 'client-id-value',
        Authorization: 'Bearer live-product-token'
      });
      assert.equal(config.timeout, 30000);
      if (url === 'https://api.twitch.tv/helix/users') {
        assert.deepEqual(config.params, { login: 'example_channel' });
        return {
          data: {
            data: [{
              broadcaster_type: 'partner',
              description: 'Example broadcaster',
              display_name: 'Example Channel',
              id: '42',
              login: 'example_channel',
              profile_image_url: 'https://static-cdn.example.test/profile.png'
            }]
          }
        };
      }
      assert.equal(url, 'https://api.twitch.tv/helix/videos');
      assert.deepEqual(config.params, { first: 100, type: 'archive', user_id: '42' });
      return {
        data: {
          data: [{
            created_at: '2026-08-13T10:00:00Z',
            duration: '2h3m4s',
            id: '1234567890',
            stream_id: 'stream-1',
            thumbnail_url: 'https://static-cdn.example.test/vod.jpg',
            title: 'A VOD',
            url: 'https://www.twitch.tv/videos/1234567890',
            user_login: 'example_channel',
            view_count: 123
          }],
          pagination: {}
        }
      };
    },
    async post(url, body, config) {
      calls.push({ body, config, method: 'POST', url });
      if (config.timeout !== 30000) {
        const error = new Error('Public product wrapper did not own its request signature');
        error.response = { status: 400 };
        throw error;
      }
      assert.equal(url, 'https://gql.twitch.tv/gql');
      assert.equal(typeof body.query, 'string');
      assert.deepEqual(body.variables, { first: 100, login: 'example_channel' });
      assert.equal(config.headers['Content-Type'], 'application/json');
      assert.equal(typeof config.headers['Client-ID'], 'string');
      assert.notEqual(config.headers['Client-ID'], 'client-id-value');
      return {
        data: {
          data: {
            user: {
              videos: {
                edges: [{
                  node: {
                    id: '1234567890',
                    lengthSeconds: 7384,
                    previewThumbnailURL: 'https://static-cdn.example.test/vod.jpg',
                    publishedAt: '2026-08-13T10:00:00Z',
                    title: 'A VOD',
                    viewCount: 123
                  }
                }]
              }
            }
          }
        }
      };
    }
  };
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('provider contract bypassed its injected transport'); };
  try {
    const result = await verifyProductTwitchProviderFallbacks({
      clientId: 'client-id-value',
      login: 'example_channel',
      vodId: '1234567890'
    }, 'live-product-token', client);
    assert.deepEqual(result, {
      helix: { duration: '2h3m4s', source: 'helix', userId: '42', vodId: '1234567890' },
      lastGood: { restoredFrom: 'helix', restoredVodId: '1234567890', source: 'last-good', stale: true },
      public: { duration: '2h3m4s', login: 'example_channel', source: 'public', vodId: '1234567890' }
    });
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
      'GET https://api.twitch.tv/helix/users',
      'POST https://gql.twitch.tv/gql',
      'GET https://api.twitch.tv/helix/videos'
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('bounds the packaged version product call', async () => {
  const window = { evaluate: async () => await new Promise(() => {}) };
  await assert.rejects(getPackagedVersion(window, 10), /version query timed out/i);
});

test('bounds the packaged update-check product call independently', async () => {
  const window = { evaluate: async () => await new Promise(() => {}) };
  await assert.rejects(checkPackagedUpdate(window, 10), /update check timed out/i);
});

test('closes the packaged app gracefully without a hard kill', async () => {
  const calls = [];
  const process = { exitCode: null };
  const app = {
    close: async () => {
      calls.push('close');
      process.exitCode = 0;
    }
  };
  await closeElectronApp(app, process, {
    terminate: () => calls.push('terminate'),
    timeoutMs: 10,
    waitForExit: async () => calls.push('wait')
  });
  assert.deepEqual(calls, ['close']);
});

test('hard-kills the packaged app after graceful close times out', async () => {
  const calls = [];
  const process = { exitCode: null };
  const app = { close: async () => { calls.push('close'); return await new Promise(() => {}); } };
  await closeElectronApp(app, process, {
    terminate: () => { calls.push('terminate'); process.exitCode = 1; },
    timeoutMs: 10,
    waitForExit: async () => calls.push('wait')
  });
  assert.deepEqual(calls, ['close', 'terminate', 'wait']);
});

test('hard-kills the packaged app after graceful close rejects', async () => {
  const calls = [];
  const process = { exitCode: null };
  const app = { close: async () => { calls.push('close'); throw new Error('close rejected'); } };
  await closeElectronApp(app, process, {
    terminate: () => { calls.push('terminate'); process.exitCode = 1; },
    timeoutMs: 10,
    waitForExit: async () => calls.push('wait')
  });
  assert.deepEqual(calls, ['close', 'terminate', 'wait']);
});

test('closes the packaged app when the updater body fails', async () => {
  const calls = [];
  const process = { exitCode: null };
  const lifecycle = {
    electronApp: { close: async () => { calls.push('close'); process.exitCode = 0; } },
    electronProcess: process
  };
  await assert.rejects(
    runWithElectronAppCleanup(lifecycle, async () => { throw new Error('updater body failed'); }, { timeoutMs: 10 }),
    /updater body failed/
  );
  assert.deepEqual(calls, ['close']);
});

test('opens the update popover before clicking its download action', async () => {
  const calls = [];
  const locators = {
    '#workspaceUpdateButton': { hover: async () => { calls.push('hover'); } },
    '#updateButton': {
      waitFor: async (options) => { calls.push(`wait:${options.state}`); },
      click: async () => { calls.push('click'); }
    }
  };
  await startUpdaterDownload({ locator: (selector) => locators[selector] });
  assert.deepEqual(calls, ['hover', 'wait:visible', 'click']);
});

test('rejects malformed public fixture identities before making network requests', () => {
  assert.throws(
    () => readLiveConfiguration('twitch', { ...TWITCH_ENVIRONMENT, TWITCH_VOD_MANAGER_LIVE_TWITCH_LOGIN: 'https://twitch.tv/name' }),
    /LIVE_TWITCH_LOGIN/
  );
  assert.throws(
    () => readLiveConfiguration('twitch', { ...TWITCH_ENVIRONMENT, TWITCH_VOD_MANAGER_LIVE_TWITCH_VOD_ID: '../123' }),
    /LIVE_TWITCH_VOD_ID/
  );
});

test('redacts credentials and access tokens from nested external errors', () => {
  const diagnostic = redactDiagnostic(
    new Error('request failed for client-id-value client-secret-value bearer-token-value'),
    ['client-id-value', 'client-secret-value', 'bearer-token-value']
  );
  assert.equal(diagnostic.includes('client-id-value'), false);
  assert.equal(diagnostic.includes('client-secret-value'), false);
  assert.equal(diagnostic.includes('bearer-token-value'), false);
  assert.match(diagnostic, /\[REDACTED\]/);
});

test('validates a real client-credentials token contract without exposing the token', () => {
  const result = validateTwitchToken(
    { access_token: 'bearer-token-value', expires_in: 3600, token_type: 'bearer' },
    { client_id: 'client-id-value', expires_in: 3590 },
    'client-id-value'
  );
  assert.deepEqual(result, { expiresInSeconds: 3590, tokenType: 'bearer' });
  assert.throws(
    () => validateTwitchToken(
      { access_token: 'bearer-token-value', expires_in: 3600, token_type: 'bearer' },
      { client_id: 'other-client', expires_in: 3590 },
      'client-id-value'
    ),
    /client id/
  );
});

test('builds a bounded lowest-quality Streamlink download command', () => {
  const output = path.join('C:\\runner\\temp', 'sample.ts');
  assert.deepEqual(buildStreamlinkArguments('1234567890', output, 8), [
    '--no-config',
    '--no-plugin-cache',
    '--no-plugin-sideloading',
    '--http-timeout',
    '20',
    '--stream-timeout',
    '30',
    '--stream-segment-attempts',
    '2',
    '--stream-segment-timeout',
    '20',
    '--stream-segmented-duration',
    '8',
    '--output',
    output,
    'https://www.twitch.tv/videos/1234567890',
    'worst'
  ]);
  assert.throws(() => buildStreamlinkArguments('abc', output, 8), /VOD id/);
  assert.throws(() => buildStreamlinkArguments('1234567890', output, 61), /duration/);
});

test('accepts only a bounded ffprobe-confirmed video artifact', () => {
  const result = validateMediaProbe({
    format: { duration: '8.25', size: '1048576' },
    streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }]
  }, 1048576);
  assert.deepEqual(result, { bytes: 1048576, codec: 'h264', durationSeconds: 8.25 });
  assert.throws(
    () => validateMediaProbe({ format: { duration: '0.4', size: '40' }, streams: [{ codec_type: 'audio', codec_name: 'aac' }] }, 40),
    /video stream/
  );
  assert.throws(
    () => validateMediaProbe({ format: { duration: '8', size: String(40 * 1024 * 1024) }, streams: [{ codec_type: 'video', codec_name: 'h264' }] }, 40 * 1024 * 1024),
    /32 MiB/
  );
});

test('parses and pins the production GitHub release feed metadata', () => {
  const yaml = [
    'version: 1.0.18',
    'files:',
    '  - url: Twitch-VOD-Manager-Setup-1.0.18.exe',
    `    sha512: ${UPDATE_SHA512}`,
    '    size: 120000000',
    'path: Twitch-VOD-Manager-Setup-1.0.18.exe',
    `sha512: ${UPDATE_SHA512}`,
    "releaseDate: '2026-08-13T10:00:00.000Z'"
  ].join('\n');
  const metadata = parseLatestYaml(yaml);
  const result = validateProductionRelease(metadata, {
    expectedVersion: '1.0.18',
    expectedSha512: UPDATE_SHA512,
    latestTag: 'v1.0.18'
  });
  assert.deepEqual(result, {
    artifactName: 'Twitch-VOD-Manager-Setup-1.0.18.exe',
    artifactSize: 120000000,
    feedUrl: 'https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/download/v1.0.18/',
    version: '1.0.18'
  });
  assert.throws(
    () => validateProductionRelease({ ...metadata, path: '../outside.exe' }, {
      expectedVersion: '1.0.18',
      expectedSha512: UPDATE_SHA512,
      latestTag: 'v1.0.18'
    }),
    /artifact path/
  );
  assert.throws(
    () => validateProductionRelease(metadata, {
      expectedVersion: '1.0.19',
      expectedSha512: UPDATE_SHA512,
      latestTag: 'v1.0.18'
    }),
    /version/
  );
});

test('resolves the public release tag to the pinned workflow commit', async () => {
  const dependencies = releaseInspectionDependencies();
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('inspectProductionRelease bypassed its injected transport'); };
  try {
    const result = await inspectProductionRelease({
      expectedCommitSha: UPDATE_COMMIT_SHA,
      expectedSha512: UPDATE_SHA512,
      expectedVersion: PACKAGE_VERSION
    }, dependencies);
    assert.equal(result.commitSha, UPDATE_COMMIT_SHA);
    assert.deepEqual(dependencies.calls, [
      'https://api.github.com/repos/Sucukdeluxe/Twitch-VOD-Manager/releases/latest',
      `https://api.github.com/repos/Sucukdeluxe/Twitch-VOD-Manager/commits/v${PACKAGE_VERSION}`,
      `https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/download/v${PACKAGE_VERSION}/latest.yml`
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects a public release tag that resolves to another commit', async () => {
  const dependencies = releaseInspectionDependencies('c'.repeat(40));
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('inspectProductionRelease bypassed its injected transport'); };
  try {
    await assert.rejects(
      inspectProductionRelease({
        expectedCommitSha: UPDATE_COMMIT_SHA,
        expectedSha512: UPDATE_SHA512,
        expectedVersion: PACKAGE_VERSION
      }, dependencies),
      /release tag commit/i
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('describes updater success as download-ready without claiming installation', () => {
  const result = createUpdaterDownloadReadySummary({
    artifact: { bytes: 120000000, sha512Verified: true },
    downloadedVersion: PACKAGE_VERSION,
    progressEvents: 4,
    release: {
      artifactName: `Twitch-VOD-Manager-Setup-${PACKAGE_VERSION}.exe`,
      commitSha: UPDATE_COMMIT_SHA,
      feedUrl: `https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/download/v${PACKAGE_VERSION}/`
    },
    source: { sourceInstallerVerified: true },
    sourceVersion: '0.0.1'
  });
  assert.deepEqual(result, {
    artifact: {
      bytes: 120000000,
      name: `Twitch-VOD-Manager-Setup-${PACKAGE_VERSION}.exe`,
      sha512Verified: true
    },
    feed: `https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/download/v${PACKAGE_VERSION}/`,
    scope: 'download-ready',
    source: { installerDigestVerified: true, version: '0.0.1' },
    target: {
      commitSha: UPDATE_COMMIT_SHA,
      downloadReady: true,
      progressEvents: 4,
      version: PACKAGE_VERSION
    }
  });
});

test('independently hashes the downloaded PE artifact from the isolated updater cache', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-live-update-artifact-'));
  try {
    const artifact = path.join(root, 'Twitch-VOD-Manager-Setup-1.0.18.exe');
    const contents = Buffer.alloc(1024 * 1024, 9);
    contents[0] = 0x4d;
    contents[1] = 0x5a;
    fs.writeFileSync(artifact, contents);
    const expectedSha512 = nodeCrypto.createHash('sha512').update(contents).digest('base64');
    const result = await validateDownloadedReleaseArtifact(artifact, {
      artifactName: path.basename(artifact),
      artifactSize: contents.length,
      expectedSha512
    });
    assert.deepEqual(result, { bytes: contents.length, sha512Verified: true });

    contents[0] = 0;
    fs.writeFileSync(artifact, contents);
    await assert.rejects(
      validateDownloadedReleaseArtifact(artifact, {
        artifactName: path.basename(artifact),
        artifactSize: contents.length,
        expectedSha512: nodeCrypto.createHash('sha512').update(contents).digest('base64')
      }),
      /Windows executable/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requires the packaged source to be older than the pinned release', () => {
  assert.equal(compareVersions('1.0.17', '1.0.18'), -1);
  assert.equal(compareVersions('1.0.18', '1.0.18'), 0);
  assert.equal(compareVersions('1.0.19', '1.0.18'), 1);
  for (const invalid of ['nightly', 'v1.0.18', '1.0.18-alpha', '1.0.18+build', '01.0.18', '1.00.18', '1.0.18.0', '1234567890.0.0']) {
    assert.throws(() => compareVersions(invalid, '1.0.18'), /invalid/);
  }
});

test('binds the updater cache record to the pinned artifact and digest', () => {
  assert.deepEqual(validateUpdateCacheRecord({
    fileName: 'Twitch-VOD-Manager-Setup-1.0.17.exe',
    sha512: 'MkTghoBxIOnhP77tHV8szr8S1dbhItJId0atllZjWVrPwNLcvwnCyYjoUVEWV1czTqb5I+CUvqLiIjaamwglgw==',
    isAdminRightsRequired: false
  }, {
    artifactName: 'Twitch-VOD-Manager-Setup-1.0.17.exe',
    expectedSha512: 'MkTghoBxIOnhP77tHV8szr8S1dbhItJId0atllZjWVrPwNLcvwnCyYjoUVEWV1czTqb5I+CUvqLiIjaamwglgw=='
  }), {
    fileName: 'Twitch-VOD-Manager-Setup-1.0.17.exe',
    sha512Verified: true
  });
  assert.throws(() => validateUpdateCacheRecord({
    fileName: '..\\outside.exe',
    sha512: UPDATE_SHA512
  }, {
    artifactName: 'Twitch-VOD-Manager-Setup-1.0.17.exe',
    expectedSha512: UPDATE_SHA512
  }), /file name/);
});

test('refuses cleanup at or outside the owned temporary root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-live-contract-'));
  try {
    const child = path.join(root, 'owned');
    fs.mkdirSync(child);
    assert.equal(assertOwnedPath(child, root), path.resolve(child));
    assert.throws(() => assertOwnedPath(root, root), /outside/);
    assert.throws(() => assertOwnedPath(path.dirname(root), root), /outside/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removes the owned runner root after a successful operation', async () => {
  let ownedRoot = '';
  const result = await runWithOwnedRoot('tvm-live-success-', async (context) => {
    ownedRoot = context.ownedRoot;
    assert.equal(fs.existsSync(ownedRoot), true);
    fs.writeFileSync(path.join(ownedRoot, 'artifact.tmp'), 'owned');
    return 'completed';
  });
  assert.equal(result, 'completed');
  assert.equal(fs.existsSync(ownedRoot), false);
});

test('removes the owned runner root when the operation fails', async () => {
  let ownedRoot = '';
  await assert.rejects(
    runWithOwnedRoot('tvm-live-failure-', async (context) => {
      ownedRoot = context.ownedRoot;
      fs.writeFileSync(path.join(ownedRoot, 'artifact.tmp'), 'owned');
      throw new Error('runner failed');
    }),
    /runner failed/
  );
  assert.equal(fs.existsSync(ownedRoot), false);
});

test('accepts only the three explicit execution modes', () => {
  assert.equal(parseGateMode([]), 'all');
  assert.equal(parseGateMode(['twitch']), 'twitch');
  assert.equal(parseGateMode(['updater']), 'updater');
  assert.throws(() => parseGateMode(['local-feed']), /mode/);
});

test('removes live credentials and injection variables from the packaged app environment', () => {
  const result = sanitizeChildEnvironment({
    PATH: 'C:\\Windows',
    SystemRoot: 'C:\\Windows',
    GITHUB_TOKEN: 'github-secret',
    HTTP_PROXY: ['http://user', ':', 'password', '@', 'proxy.example.test'].join(''),
    NODE_OPTIONS: '--require malicious.js',
    TWITCH_VOD_MANAGER_LIVE_TWITCH_CLIENT_SECRET: 'twitch-secret',
    SAFE_SETTING: 'kept'
  }, { LOCALAPPDATA: 'C:\\isolated' });
  assert.deepEqual(result, {
    LOCALAPPDATA: 'C:\\isolated',
    PATH: 'C:\\Windows',
    SYSTEMROOT: 'C:\\Windows'
  });
});

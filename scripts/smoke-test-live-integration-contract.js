const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LIVE_OPT_IN = 'TWITCH_VOD_MANAGER_LIVE_INTEGRATION';
const PRODUCTION_RELEASE_DOWNLOAD_BASE = 'https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/download';
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

function parseGateMode(argumentsList) {
  if (argumentsList.length === 0) return 'all';
  if (argumentsList.length === 1 && ['all', 'twitch', 'updater'].includes(argumentsList[0])) return argumentsList[0];
  throw new Error('Live integration mode must be one of: all, twitch, updater');
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnvironment(environment, name) {
  const value = environment[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readLiveConfiguration(mode, environment = process.env) {
  if (environment[LIVE_OPT_IN] !== '1') throw new Error(`Refusing live network execution without ${LIVE_OPT_IN}=1`);
  const configuration = { mode };

  if (mode === 'all' || mode === 'twitch') {
    const login = requiredEnvironment(environment, 'TWITCH_VOD_MANAGER_LIVE_TWITCH_LOGIN').trim().toLowerCase();
    const vodId = requiredEnvironment(environment, 'TWITCH_VOD_MANAGER_LIVE_TWITCH_VOD_ID').trim();
    if (!/^[a-z0-9_]{2,25}$/.test(login)) throw new Error('TWITCH_VOD_MANAGER_LIVE_TWITCH_LOGIN must be a Twitch login, not a URL');
    if (!/^\d{6,20}$/.test(vodId)) throw new Error('TWITCH_VOD_MANAGER_LIVE_TWITCH_VOD_ID must contain only the numeric VOD id');
    configuration.twitch = {
      clientId: requiredEnvironment(environment, 'TWITCH_VOD_MANAGER_LIVE_TWITCH_CLIENT_ID').trim(),
      clientSecret: requiredEnvironment(environment, 'TWITCH_VOD_MANAGER_LIVE_TWITCH_CLIENT_SECRET'),
      ffprobePath: optionalEnvironment(environment, 'TWITCH_VOD_MANAGER_LIVE_FFPROBE_PATH'),
      login,
      streamlinkPath: optionalEnvironment(environment, 'TWITCH_VOD_MANAGER_LIVE_STREAMLINK_PATH'),
      vodId
    };
  }

  if (mode === 'all' || mode === 'updater') {
    const sourceVersion = normalizeVersion(requiredEnvironment(environment, 'TWITCH_VOD_MANAGER_LIVE_SOURCE_VERSION'));
    const sourceSha256 = requiredEnvironment(environment, 'TWITCH_VOD_MANAGER_LIVE_SOURCE_SHA256').trim().toLowerCase();
    const expectedCommitSha = requiredEnvironment(environment, 'TWITCH_VOD_MANAGER_LIVE_UPDATE_COMMIT_SHA').trim().toLowerCase();
    const expectedVersion = normalizeVersion(requiredEnvironment(environment, 'TWITCH_VOD_MANAGER_LIVE_UPDATE_VERSION'));
    const expectedSha512 = requiredEnvironment(environment, 'TWITCH_VOD_MANAGER_LIVE_UPDATE_SHA512').trim();
    const workflowCommitSha = requiredEnvironment(environment, 'GITHUB_SHA').trim().toLowerCase();
    if (!sourceVersion) throw new Error('TWITCH_VOD_MANAGER_LIVE_SOURCE_VERSION must be a numeric release version');
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('TWITCH_VOD_MANAGER_LIVE_SOURCE_SHA256 must be a hexadecimal SHA-256 digest');
    if (!/^[a-f0-9]{40}$/.test(expectedCommitSha)) throw new Error('TWITCH_VOD_MANAGER_LIVE_UPDATE_COMMIT_SHA must be a 40-character hexadecimal commit SHA');
    if (!expectedVersion) throw new Error('TWITCH_VOD_MANAGER_LIVE_UPDATE_VERSION must be a numeric release version');
    if (!isSha512Base64(expectedSha512)) throw new Error('TWITCH_VOD_MANAGER_LIVE_UPDATE_SHA512 must be a base64 SHA-512 digest');
    if (!/^[a-f0-9]{40}$/.test(workflowCommitSha) || workflowCommitSha !== expectedCommitSha) {
      throw new Error('Pinned update commit must match the current workflow commit');
    }
    if (compareVersions(sourceVersion, expectedVersion) >= 0) throw new Error('Packaged source version must be older than the pinned update version');
    if (expectedVersion !== PACKAGE_VERSION) throw new Error(`Pinned update version must match package version ${PACKAGE_VERSION}`);
    const expectedRef = `refs/tags/v${expectedVersion}`;
    if (requiredEnvironment(environment, 'GITHUB_REF').trim() !== expectedRef) {
      throw new Error(`Post-publish updater gate must run from release tag ${expectedRef}`);
    }
    configuration.updater = {
      expectedCommitSha,
      expectedSha512,
      expectedVersion,
      packagedAppPath: optionalEnvironment(environment, 'TWITCH_VOD_MANAGER_LIVE_PACKAGED_APP_PATH'),
      sourceSha256,
      sourceVersion
    };
  }

  return configuration;
}

function redactDiagnostic(error, sensitiveValues = []) {
  let diagnostic = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const values = sensitiveValues
    .filter((value) => typeof value === 'string' && value.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const value of values) diagnostic = diagnostic.split(value).join('[REDACTED]');
  return diagnostic
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(client_secret=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(access_token=)[^&\s]+/gi, '$1[REDACTED]');
}

function validateTwitchToken(tokenPayload, validationPayload, expectedClientId) {
  if (!tokenPayload || typeof tokenPayload !== 'object' || typeof tokenPayload.access_token !== 'string' || tokenPayload.access_token.length < 8) {
    throw new Error('Twitch OAuth token response did not contain an access token');
  }
  const tokenType = String(tokenPayload.token_type || '').toLowerCase();
  if (tokenType !== 'bearer') throw new Error('Twitch OAuth token response did not declare bearer token type');
  if (!validationPayload || typeof validationPayload !== 'object' || validationPayload.client_id !== expectedClientId) {
    throw new Error('Twitch OAuth validation returned a different client id');
  }
  const expiresInSeconds = Number(validationPayload.expires_in);
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) throw new Error('Twitch OAuth validation returned an expired token');
  return { expiresInSeconds, tokenType };
}

function buildStreamlinkArguments(vodId, outputPath, durationSeconds = 8) {
  if (!/^\d{6,20}$/.test(String(vodId))) throw new Error('Streamlink VOD id must be numeric');
  if (!Number.isInteger(durationSeconds) || durationSeconds < 3 || durationSeconds > 60) throw new Error('Streamlink sample duration must be between 3 and 60 seconds');
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) throw new Error('Streamlink output path must be absolute');
  return [
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
    String(durationSeconds),
    '--output',
    outputPath,
    `https://www.twitch.tv/videos/${vodId}`,
    'worst'
  ];
}

function validateMediaProbe(probe, actualBytes) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video' && typeof stream.codec_name === 'string' && stream.codec_name !== '');
  if (!video) throw new Error('Downloaded sample did not contain a video stream');
  const durationSeconds = Number(probe?.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) throw new Error('Downloaded sample duration was outside the bounded smoke range');
  if (!Number.isInteger(actualBytes) || actualBytes < 16 * 1024) throw new Error('Downloaded sample was too small to be valid media');
  if (actualBytes > 32 * 1024 * 1024) throw new Error('Downloaded sample exceeded the 32 MiB safety limit');
  const reportedBytes = Number(probe?.format?.size);
  if (Number.isFinite(reportedBytes) && reportedBytes !== actualBytes) throw new Error('ffprobe size did not match the downloaded file');
  return { bytes: actualBytes, codec: video.codec_name, durationSeconds };
}

function parseYamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1);
  return trimmed;
}

function parseLatestYaml(source) {
  if (typeof source !== 'string' || source.length === 0 || source.length > 128 * 1024) throw new Error('latest.yml payload was empty or too large');
  const metadata = { files: [] };
  let currentFile;
  for (const line of source.split(/\r?\n/)) {
    let match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match) {
      const [, key, rawValue] = match;
      if (key === 'version' || key === 'path' || key === 'sha512' || key === 'releaseDate') metadata[key] = parseYamlScalar(rawValue);
      continue;
    }
    match = line.match(/^\s{2}-\s+url:\s*(.+)$/);
    if (match) {
      currentFile = { url: parseYamlScalar(match[1]) };
      metadata.files.push(currentFile);
      continue;
    }
    match = line.match(/^\s{4}(sha512|size):\s*(.+)$/);
    if (match && currentFile) currentFile[match[1]] = match[1] === 'size' ? Number(parseYamlScalar(match[2])) : parseYamlScalar(match[2]);
  }
  return metadata;
}

function normalizeVersion(value) {
  const text = String(value || '').trim();
  return /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(text) ? text : '';
}

function compareVersions(left, right) {
  const normalizedLeft = normalizeVersion(left);
  const normalizedRight = normalizeVersion(right);
  if (!normalizedLeft || !normalizedRight) throw new Error('Cannot compare invalid update versions');
  const leftParts = normalizedLeft.split('.').map(Number);
  const rightParts = normalizedRight.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function isSha512Base64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').length === 64;
  } catch {
    return false;
  }
}

function validateProductionRelease(metadata, expected) {
  const version = normalizeVersion(metadata?.version);
  if (!version || version !== normalizeVersion(expected.expectedVersion)) throw new Error('Production release version did not match the pinned version');
  if (expected.latestTag !== `v${version}`) throw new Error('Production release tag did not match the pinned version');
  const artifactName = String(metadata?.path || '');
  if (!artifactName || artifactName !== path.posix.basename(artifactName) || artifactName !== path.win32.basename(artifactName) || !artifactName.toLowerCase().endsWith('.exe')) {
    throw new Error('Production release artifact path was unsafe');
  }
  const file = Array.isArray(metadata?.files) ? metadata.files.find((entry) => entry?.url === artifactName) : undefined;
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1024 * 1024) throw new Error('Production release artifact metadata was incomplete');
  if (metadata.sha512 !== expected.expectedSha512 || file.sha512 !== expected.expectedSha512 || !isSha512Base64(expected.expectedSha512)) {
    throw new Error('Production release SHA-512 did not match the pinned digest');
  }
  const feedUrl = `${PRODUCTION_RELEASE_DOWNLOAD_BASE}/${encodeURIComponent(expected.latestTag)}/`;
  return { artifactName, artifactSize: file.size, feedUrl, version };
}

async function sha512File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = nodeCrypto.createHash('sha512');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('base64')));
  });
}

async function validateDownloadedReleaseArtifact(artifactPath, expected) {
  const resolvedPath = path.resolve(artifactPath);
  const stat = fs.lstatSync(resolvedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || path.basename(resolvedPath) !== expected.artifactName) {
    throw new Error('Downloaded updater artifact was not the expected regular file');
  }
  if (stat.size !== expected.artifactSize) throw new Error('Downloaded updater artifact size did not match latest.yml');
  const header = Buffer.alloc(2);
  const handle = fs.openSync(resolvedPath, 'r');
  try {
    fs.readSync(handle, header, 0, header.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (header[0] !== 0x4d || header[1] !== 0x5a) throw new Error('Downloaded updater artifact was not a Windows executable');
  const digest = await sha512File(resolvedPath);
  if (digest !== expected.expectedSha512) throw new Error('Downloaded updater artifact SHA-512 did not match latest.yml');
  return { bytes: stat.size, sha512Verified: true };
}

function validateUpdateCacheRecord(record, expected) {
  const fileName = typeof record?.fileName === 'string' ? record.fileName : '';
  if (!fileName || fileName !== path.basename(fileName) || fileName !== path.win32.basename(fileName) || fileName !== expected.artifactName) {
    throw new Error('Updater cache file name did not match the pinned release artifact');
  }
  if (record.sha512 !== expected.expectedSha512 || !isSha512Base64(record.sha512)) {
    throw new Error('Updater cache SHA-512 did not match the pinned release artifact');
  }
  return { fileName, sha512Verified: true };
}

function assertOwnedPath(targetPath, ownerPath) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedOwner = path.resolve(ownerPath);
  const relative = path.relative(resolvedOwner, resolvedTarget);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing access outside the owned temporary root: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function sanitizeChildEnvironment(environment, overrides = {}) {
  const result = {};
  const allowedNames = new Set([
    'ALLUSERSPROFILE',
    'APPDATA',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'COMMONPROGRAMW6432',
    'COMSPEC',
    'LANG',
    'LC_ALL',
    'LOCALAPPDATA',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PATH',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL',
    'PROCESSOR_REVISION',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TZ',
    'USERDOMAIN',
    'USERDOMAIN_ROAMINGPROFILE',
    'USERNAME',
    'USERPROFILE',
    'WINDIR'
  ]);
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== 'string') continue;
    const normalizedName = name.toUpperCase();
    if (!allowedNames.has(normalizedName)) continue;
    result[normalizedName] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof value === 'string') result[name.toUpperCase()] = value;
  }
  return result;
}

module.exports = {
  LIVE_OPT_IN,
  PRODUCTION_RELEASE_DOWNLOAD_BASE,
  assertOwnedPath,
  buildStreamlinkArguments,
  compareVersions,
  isSha512Base64,
  normalizeVersion,
  parseGateMode,
  parseLatestYaml,
  readLiveConfiguration,
  redactDiagnostic,
  sanitizeChildEnvironment,
  validateMediaProbe,
  validateDownloadedReleaseArtifact,
  validateUpdateCacheRecord,
  validateProductionRelease,
  validateTwitchToken
};

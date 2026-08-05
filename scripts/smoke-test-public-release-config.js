const fs = require('fs');
const path = require('path');

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const manifestPath = path.join(root, 'scripts', 'public-release-files.json');
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

check(packageJson.version === '1.0.1', `package version is ${packageJson.version}`);
check(packageLock.version === '1.0.1', `lockfile version is ${packageLock.version}`);
check(packageLock.packages?.['']?.version === '1.0.1', `lockfile root package version is ${packageLock.packages?.['']?.version}`);
check(packageJson.build?.appId === 'io.github.sucukdeluxe.twitch-vod-manager', `appId is ${packageJson.build?.appId}`);
check(packageJson.build?.publish?.provider === 'generic', `publish provider is ${packageJson.build?.publish?.provider}`);
check(packageJson.build?.publish?.url === 'https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/latest/download/', `publish URL is ${packageJson.build?.publish?.url}`);
check(JSON.stringify(packageJson.build?.files) === JSON.stringify(['dist/**/*', 'src/index.html', 'src/styles.css', 'package.json']), 'packaged file list is not restricted');
check(mainSource.includes('GITHUB_RELEASES_API_LATEST_URL'), 'GitHub releases API constant is missing');
check(mainSource.includes('GITHUB_RELEASES_DOWNLOAD_BASE_URL'), 'GitHub releases download constant is missing');
check(mainSource.includes('https://api.github.com/repos/Sucukdeluxe/Twitch-VOD-Manager/releases/latest'), 'GitHub latest release API URL is missing');
check(mainSource.includes('https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/download'), 'GitHub release download URL is missing');
check(indexSource.includes('Version: v1.0.1'), 'initial version label is not 1.0.1');
check(!indexSource.includes('Version: v4.1.13'), 'legacy version label is still present');
check(fs.existsSync(manifestPath), 'public release manifest is missing');

if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  for (const entry of entries) {
    check(fs.existsSync(path.join(root, entry)), `public release entry does not exist: ${entry}`);
  }
}

console.log(JSON.stringify({ failures }, null, 2));

if (failures.length) process.exitCode = 1;

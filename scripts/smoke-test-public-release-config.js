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

check(packageJson.version === '1.0.2', `package version is ${packageJson.version}`);
check(packageLock.version === '1.0.2', `lockfile version is ${packageLock.version}`);
check(packageLock.packages?.['']?.version === '1.0.2', `lockfile root package version is ${packageLock.packages?.['']?.version}`);
check(packageJson.build?.appId === 'io.github.sucukdeluxe.twitch-vod-manager', `appId is ${packageJson.build?.appId}`);
check(packageJson.build?.publish?.provider === 'generic', `publish provider is ${packageJson.build?.publish?.provider}`);
check(packageJson.build?.publish?.url === 'https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/latest/download/', `publish URL is ${packageJson.build?.publish?.url}`);
check(JSON.stringify(packageJson.build?.files) === JSON.stringify(['dist/**/*', 'src/index.html', 'src/styles.css', 'src/workspace.css', 'package.json']), 'packaged file list is not restricted');
check(mainSource.includes('GITHUB_RELEASES_API_LATEST_URL'), 'GitHub releases API constant is missing');
check(mainSource.includes('GITHUB_RELEASES_DOWNLOAD_BASE_URL'), 'GitHub releases download constant is missing');
check(mainSource.includes('https://api.github.com/repos/Sucukdeluxe/Twitch-VOD-Manager/releases/latest'), 'GitHub latest release API URL is missing');
check(mainSource.includes('https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/download'), 'GitHub release download URL is missing');
check(!/storyboards\/\d{8,12}(?:-|\/)/.test(mainSource), 'numeric Twitch VOD example remains in the public source');
check(indexSource.includes('Version: v1.0.2'), 'initial version label is not 1.0.2');
check(!indexSource.includes('Version: v4.1.13'), 'legacy version label is still present');
check(fs.existsSync(manifestPath), 'public release manifest is missing');

if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  const normalizedEntries = entries.map((entry) => entry.replace(/\\/g, '/').replace(/\/$/, ''));
  const forbiddenReleasePath = /(?:^|\/)(?:\.claude|\.codex|\.superpowers|tasks?|memories?|prompts?|artifacts?|logs?|backups?)(?:\/|$)|(?:^|\/)(?:AGENTS|CLAUDE)\.md$|\.(?:db|sqlite|sqlite3|log|bak|backup|zip|7z|rar|exe|msi|jsonl)$/i;
  for (const entry of entries) {
    const absolutePath = path.join(root, entry);
    check(fs.existsSync(absolutePath), `public release entry does not exist: ${entry}`);
    if (fs.existsSync(absolutePath)) {
      const stat = fs.lstatSync(absolutePath);
      check(stat.isFile(), `public release entry is not a file: ${entry}`);
      check(!stat.isSymbolicLink(), `public release entry is a symbolic link: ${entry}`);
    }
    check(!forbiddenReleasePath.test(entry.replace(/\\/g, '/')), `forbidden public release path: ${entry}`);
  }

  check(new Set(normalizedEntries).size === normalizedEntries.length, 'public release manifest contains duplicate entries');

  const collectFiles = (directory) => {
    const result = [];
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, item.name);
      if (item.isDirectory()) result.push(...collectFiles(absolutePath));
      else if (item.isFile()) result.push(path.relative(root, absolutePath).replace(/\\/g, '/'));
    }
    return result;
  };
  const publicTreeFiles = [...collectFiles(path.join(root, 'build')), ...collectFiles(path.join(root, 'src'))].sort();
  const missingTreeFiles = publicTreeFiles.filter((relativePath) => !normalizedEntries.includes(relativePath));
  check(missingTreeFiles.length === 0, `public release manifest is missing ${missingTreeFiles.length} build/src files: ${missingTreeFiles.slice(0, 5).join(', ')}`);

  const referencedTestFiles = new Set();
  for (const [name, command] of Object.entries(packageJson.scripts || {})) {
    if (!name.startsWith('test')) continue;
    for (const match of String(command).matchAll(/\b((?:scripts|tests?|src)[\\/][A-Za-z0-9._\\/-]+)\b/g)) {
      const relativePath = match[1].replace(/\\/g, '/');
      const absolutePath = path.join(root, ...relativePath.split('/'));
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        referencedTestFiles.add(relativePath);
      }
    }
  }

  for (const relativePath of [...referencedTestFiles].sort()) {
    check(normalizedEntries.includes(relativePath), `test script file is missing from the public release manifest: ${relativePath}`);
  }
}

console.log(JSON.stringify({ failures }, null, 2));

if (failures.length) process.exitCode = 1;

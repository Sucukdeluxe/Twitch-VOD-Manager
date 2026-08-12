const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

const requiredScripts = {
  lint: 'eslint .',
  'security:check': 'node scripts/security-check.js && node scripts/smoke-test-public-release-config.js',
  'test:security': 'node --test scripts/security-check.test.js',
  'test:lint-config': 'node --test scripts/lint-config.test.mjs',
  'test:ci-contract': 'node scripts/smoke-test-ci-contract.js',
  'test:e2e:focused': 'npm run test:e2e:isolation && npm run test:e2e:workspace-ui',
  'test:packaged-launch': 'node scripts/smoke-test-packaged-launch.js',
  'test:installer': 'node scripts/smoke-test-installer.js',
  'dist:ci': 'electron-builder --win nsis'
};

for (const [name, command] of Object.entries(requiredScripts)) {
  check(packageJson.scripts?.[name] === command, `package script ${name} is missing or changed`);
}

for (const relativePath of ['.github/workflows/windows-ci.yml', '.gitea/workflows/windows-ci.yml']) {
  const absolutePath = path.join(root, relativePath);
  check(fs.existsSync(absolutePath), `${relativePath} is missing`);
  if (!fs.existsSync(absolutePath)) continue;

  const source = fs.readFileSync(absolutePath, 'utf8');
  const requiredCommands = [
    'npm ci',
    'npm run lint',
    'npm run test:lint-config',
    'npm run security:check',
    'npm run test:security',
    'npm run test:ci-contract',
    'npm run test:unit',
    'npm run test:e2e:focused',
    'npm run build',
    'npm run pack',
    'npm run test:packaged-launch',
    'npm run dist:ci',
    'npm run test:installer'
  ];

  check(/runs-on:\s*windows-latest/.test(source), `${relativePath} does not use a Windows runner`);
  check(/node-version:\s*['"]?22\.13\.0['"]?/.test(source), `${relativePath} does not pin Node 22.13.0`);
  for (const command of requiredCommands) {
    check(source.includes(`run: ${command}`), `${relativePath} is missing ${command}`);
  }
  const runSteps = source.split(/\r?\n/).filter((line) => /^\s+run:\s+/.test(line));
  const timeoutSteps = source.split(/\r?\n/).filter((line) => /^\s+timeout-minutes:\s*10\s*$/.test(line));
  check(timeoutSteps.length >= runSteps.length, `${relativePath} does not cap every command at ten minutes`);
  check(!/test:[^\s]*authenticated|TWITCH_CLIENT_SECRET|DISCORD_WEBHOOK/i.test(source), `${relativePath} includes authenticated integration inputs`);
}

for (const relativePath of [
  'scripts/security-check.js',
  'scripts/security-check.test.js',
  'scripts/lint-config.test.mjs',
  'scripts/smoke-test-packaged-launch.js',
  'scripts/smoke-test-installer.js'
]) {
  check(fs.existsSync(path.join(root, relativePath)), `${relativePath} is missing`);
}

console.log(JSON.stringify({ failures }, null, 2));
if (failures.length) process.exitCode = 1;

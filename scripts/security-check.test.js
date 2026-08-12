const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const securityCheck = require('./security-check');

test('detects credential material and private machine paths', () => {
  const githubToken = ['gh', 'p_', 'a'.repeat(40)].join('');
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const source = `${githubToken}\n${privateKey}\nC:\\Users\\real-user\\AppData`;
  const findings = securityCheck.scanText('fixture.txt', source);

  assert.deepEqual(findings.map((finding) => finding.rule).sort(), [
    'github-token',
    'private-key',
    'windows-user-path'
  ]);
});

test('accepts public source with secret field names but no credential value', () => {
  const findings = securityCheck.scanText('fixture.ts', "const client_secret = config.client_secret;\nconst token = '';\n");
  assert.deepEqual(findings, []);
});

test('rejects public manifest traversal and symbolic links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-security-'));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  try {
    fs.writeFileSync(path.join(root, 'safe.txt'), 'safe', 'utf8');
    fs.writeFileSync(outside, 'outside', 'utf8');
    const entries = ['safe.txt', '../outside.txt'];
    const findings = securityCheck.inspectPublicFiles(root, entries);
    assert.ok(findings.some((finding) => finding.rule === 'manifest-path'));

    if (process.platform === 'win32') {
      fs.symlinkSync(outside, path.join(root, 'linked.txt'), 'file');
      const linkedFindings = securityCheck.inspectPublicFiles(root, ['linked.txt']);
      assert.ok(linkedFindings.some((finding) => finding.rule === 'manifest-symlink'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('requires registry dependency integrity in the lockfile', () => {
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { example: '^1.0.0' } },
      'node_modules/example': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz'
      }
    }
  };

  const findings = securityCheck.inspectLockfile(lockfile);
  assert.ok(findings.some((finding) => finding.rule === 'dependency-integrity'));
});

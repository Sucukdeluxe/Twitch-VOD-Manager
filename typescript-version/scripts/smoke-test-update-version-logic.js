const path = require('path');

const {
  normalizeUpdateVersion,
  compareUpdateVersions,
  isNewerUpdateVersion
} = require(path.join(process.cwd(), 'dist', 'update-version-utils.js'));

function run() {
  const failures = [];

  const assert = (condition, message) => {
    if (!condition) failures.push(message);
  };

  const comparisons = [
    { left: '4.1.18', right: '4.1.10', expected: 1 },
    { left: '4.1.10', right: '4.1.18', expected: -1 },
    { left: 'v4.1.12', right: '4.1.12', expected: 0 },
    { left: '4.1.12', right: '4.1.12.1', expected: -1 },
    { left: '4.2.0', right: '4.1.999', expected: 1 },
    { left: '4.1.12-beta', right: '4.1.12', expected: 0 }
  ];

  const compareResults = comparisons.map((testCase) => {
    const actual = compareUpdateVersions(testCase.left, testCase.right);
    const pass = actual === testCase.expected;
    assert(pass, `compare failed: ${testCase.left} vs ${testCase.right} expected ${testCase.expected}, got ${actual}`);
    return { ...testCase, actual, pass };
  });

  const skipVersionScenarios = [
    {
      name: 'old downloaded, newer available',
      downloaded: '4.1.11',
      latestKnown: '4.1.18',
      expectedNeedsNewer: true
    },
    {
      name: 'already latest downloaded',
      downloaded: '4.1.18',
      latestKnown: '4.1.18',
      expectedNeedsNewer: false
    },
    {
      name: 'downgrade should not trigger',
      downloaded: '4.1.18',
      latestKnown: '4.1.11',
      expectedNeedsNewer: false
    }
  ];

  const scenarioResults = skipVersionScenarios.map((scenario) => {
    const needsNewer = isNewerUpdateVersion(scenario.latestKnown, scenario.downloaded);
    const pass = needsNewer === scenario.expectedNeedsNewer;
    assert(pass, `${scenario.name} expected ${scenario.expectedNeedsNewer}, got ${needsNewer}`);
    return { ...scenario, needsNewer, pass };
  });

  const normalizationChecks = {
    fromVPrefix: normalizeUpdateVersion('v4.1.12') === '4.1.12',
    trimmed: normalizeUpdateVersion(' 4.1.12 ') === '4.1.12'
  };

  assert(normalizationChecks.fromVPrefix, 'normalize did not remove v prefix');
  assert(normalizationChecks.trimmed, 'normalize did not trim whitespace');

  const summary = {
    checks: {
      compareResults,
      scenarioResults,
      normalizationChecks
    },
    failures
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failures.length) {
    process.exitCode = 1;
  }
}

run();

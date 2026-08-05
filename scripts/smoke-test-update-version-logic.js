const path = require('path');

const {
  normalizeUpdateVersion,
  compareUpdateVersions,
  isNewerUpdateVersion
} = require(path.join(process.cwd(), 'dist', 'main', 'domain', 'update-version-utils.js'));

function run() {
  const failures = [];

  const assert = (condition, message) => {
    if (!condition) failures.push(message);
  };

  const comparisons = [
    { left: '1.0.2', right: '1.0.1', expected: 1 },
    { left: '1.0.1', right: '1.0.2', expected: -1 },
    { left: 'v1.0.1', right: '1.0.1', expected: 0 },
    { left: '1.0.1', right: '1.0.1.1', expected: -1 },
    { left: '2.0.0', right: '1.99.999', expected: 1 },
    { left: '1.0.1-beta', right: '1.0.1', expected: 0 }
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
      downloaded: '1.0.1',
      latestKnown: '1.0.2',
      expectedNeedsNewer: true
    },
    {
      name: 'already latest downloaded',
      downloaded: '1.0.2',
      latestKnown: '1.0.2',
      expectedNeedsNewer: false
    },
    {
      name: 'downgrade should not trigger',
      downloaded: '1.0.2',
      latestKnown: '1.0.1',
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
    fromVPrefix: normalizeUpdateVersion('v1.0.1') === '1.0.1',
    trimmed: normalizeUpdateVersion(' 1.0.1 ') === '1.0.1'
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

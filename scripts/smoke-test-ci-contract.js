const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function addField(fields, key, value) {
  if (!fields.has(key)) fields.set(key, []);
  fields.get(key).push(value);
}

function singleField(fields, key) {
  const values = fields.get(key) || [];
  return values.length === 1 ? values[0] : undefined;
}

function recordDuplicateFields(duplicates, fields, prefix) {
  for (const [key, values] of fields) {
    if (values.length > 1) duplicates.add(`${prefix}.${key}`);
  }
}

function parseMappingField(line, indentation, listItem = false) {
  let leadingSpaces = 0;
  while (line[leadingSpaces] === ' ') leadingSpaces += 1;
  if (leadingSpaces !== indentation) return undefined;
  let body = line.slice(indentation);
  if (listItem) {
    if (!body.startsWith('- ')) return undefined;
    body = body.slice(2);
  }
  const colon = body.indexOf(':');
  if (colon <= 0) return undefined;
  const key = body.slice(0, colon);
  if (![...key].every((character) => /[A-Za-z0-9_-]/.test(character))) return undefined;
  return [key, body.slice(colon + 1).trimStart()];
}

function parseWorkflow(source) {
  const lines = source.split(/\r?\n/);
  const duplicateKeys = new Set();
  const topLevelFields = new Map();
  for (const line of lines) {
    const field = parseMappingField(line, 0);
    if (field) addField(topLevelFields, field[0], field[1]);
  }
  recordDuplicateFields(duplicateKeys, topLevelFields, 'workflow');
  const jobsStart = lines.findIndex((line) => line === 'jobs:');
  const jobs = new Map();
  if (jobsStart >= 0) {
    const jobsEndOffset = lines.slice(jobsStart + 1).findIndex((line) => /^\S/.test(line));
    const jobsEnd = jobsEndOffset < 0 ? lines.length : jobsStart + 1 + jobsEndOffset;
    const jobStarts = [];
    for (let index = jobsStart + 1; index < jobsEnd; index += 1) {
      const field = parseMappingField(lines[index], 2);
      if (field?.[1] === '') jobStarts.push({ index, name: field[0] });
    }
    const jobNames = new Map();
    for (const jobStart of jobStarts) addField(jobNames, jobStart.name, '');
    recordDuplicateFields(duplicateKeys, jobNames, 'jobs');
    for (let jobIndex = 0; jobIndex < jobStarts.length; jobIndex += 1) {
      const start = jobStarts[jobIndex].index;
      const end = jobStarts[jobIndex + 1]?.index || jobsEnd;
      const fields = new Map();
      for (let index = start + 1; index < end; index += 1) {
        const field = parseMappingField(lines[index], 4);
        if (field) addField(fields, field[0], field[1]);
      }
      const jobPath = `jobs.${jobStarts[jobIndex].name}`;
      recordDuplicateFields(duplicateKeys, fields, jobPath);
      const env = new Map();
      const envStart = lines.findIndex((line, index) => index > start && index < end && line === '    env:');
      if (envStart >= 0) {
        for (let index = envStart + 1; index < end; index += 1) {
          if (lines[index].trim() && !lines[index].startsWith('      ')) break;
          const field = parseMappingField(lines[index], 6);
          if (field) addField(env, field[0], field[1]);
        }
      }
      recordDuplicateFields(duplicateKeys, env, `${jobPath}.env`);
      const stepsStart = lines.findIndex((line, index) => index > start && index < end && line === '    steps:');
      const steps = [];
      if (stepsStart >= 0) {
        const stepStarts = [];
        for (let index = stepsStart + 1; index < end; index += 1) {
          if (/^ {6}-\s+/.test(lines[index])) stepStarts.push(index);
        }
        for (let stepIndex = 0; stepIndex < stepStarts.length; stepIndex += 1) {
          const stepStart = stepStarts[stepIndex];
          const stepEnd = stepStarts[stepIndex + 1] || end;
          const stepFields = new Map();
          const firstField = parseMappingField(lines[stepStart], 6, true);
          if (firstField) addField(stepFields, firstField[0], firstField[1]);
          for (let index = stepStart + 1; index < stepEnd; index += 1) {
            const field = parseMappingField(lines[index], 8);
            if (field) addField(stepFields, field[0], field[1]);
          }
          const stepPath = `${jobPath}.steps[${stepIndex}]`;
          recordDuplicateFields(duplicateKeys, stepFields, stepPath);
          const stepEnv = new Map();
          const stepEnvStart = lines.findIndex((line, index) => index > stepStart && index < stepEnd && line === '        env:');
          if (stepEnvStart >= 0) {
            for (let index = stepEnvStart + 1; index < stepEnd; index += 1) {
              if (lines[index].trim() && !lines[index].startsWith('          ')) break;
              const field = parseMappingField(lines[index], 10);
              if (field) addField(stepEnv, field[0], field[1]);
            }
          }
          recordDuplicateFields(duplicateKeys, stepEnv, `${stepPath}.env`);
          const stepWith = new Map();
          const stepWithStart = lines.findIndex((line, index) => index > stepStart && index < stepEnd && line === '        with:');
          if (stepWithStart >= 0) {
            for (let index = stepWithStart + 1; index < stepEnd; index += 1) {
              if (lines[index].trim() && !lines[index].startsWith('          ')) break;
              const field = parseMappingField(lines[index], 10);
              if (field) addField(stepWith, field[0], field[1]);
            }
          }
          recordDuplicateFields(duplicateKeys, stepWith, `${stepPath}.with`);
          steps.push({
            env: stepEnv,
            fields: stepFields,
            name: singleField(stepFields, 'name'),
            raw: lines.slice(stepStart, stepEnd).join('\n'),
            with: stepWith
          });
        }
      }
      jobs.set(jobStarts[jobIndex].name, {
        env,
        fields,
        header: lines.slice(start + 1, stepsStart >= 0 ? stepsStart : end).join('\n'),
        name: jobStarts[jobIndex].name,
        steps
      });
    }
  }

  const dispatchInputs = new Map();
  const onStart = lines.findIndex((line) => line === 'on:');
  if (onStart >= 0) {
    const onEndOffset = lines.slice(onStart + 1).findIndex((line) => /^\S/.test(line));
    const onEnd = onEndOffset < 0 ? lines.length : onStart + 1 + onEndOffset;
    const dispatchStart = lines.findIndex((line, index) => index > onStart && index < onEnd && line === '  workflow_dispatch:');
    const dispatchEndOffset = dispatchStart < 0
      ? -1
      : lines.slice(dispatchStart + 1, onEnd).findIndex((line) => /^ {2}\S/.test(line));
    const dispatchEnd = dispatchEndOffset < 0 ? onEnd : dispatchStart + 1 + dispatchEndOffset;
    const inputsStart = dispatchStart < 0 ? -1 : lines.findIndex((line, index) => index > dispatchStart && index < dispatchEnd && line === '    inputs:');
    if (dispatchStart >= 0 && inputsStart >= 0) {
      for (let index = inputsStart + 1; index < dispatchEnd; index += 1) {
        const field = parseMappingField(lines[index], 6);
        if (field?.[1] === '') addField(dispatchInputs, field[0], '');
      }
      recordDuplicateFields(duplicateKeys, dispatchInputs, 'on.workflow_dispatch.inputs');
    }
  }

  return { dispatchInputs, duplicateKeys: [...duplicateKeys], jobs };
}

function parseWorkflowDocument(source, label, errors) {
  try {
    const document = yaml.load(source, { schema: yaml.JSON_SCHEMA });
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      errors.push(`${label} must contain one YAML mapping document`);
      return undefined;
    }
    return document;
  } catch (error) {
    const reason = error && typeof error === 'object' && 'reason' in error ? error.reason : 'invalid YAML';
    errors.push(`${label} cannot be parsed as YAML: ${reason}`);
    return undefined;
  }
}

function sortedKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

function collectYamlNamesAndValues(value, values = [], visited = new Set()) {
  if (typeof value === 'string') {
    values.push(value);
    return values;
  }
  if (!value || typeof value !== 'object' || visited.has(value)) return values;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectYamlNamesAndValues(item, values, visited);
    return values;
  }
  for (const [key, item] of Object.entries(value)) {
    values.push(key);
    collectYamlNamesAndValues(item, values, visited);
  }
  return values;
}

function expressionUsesRoot(value, root) {
  if (typeof value !== 'string') return false;
  return [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].some((match) => {
    const normalized = match[1]
      .replace(/\[\s*(['"])([A-Za-z_][A-Za-z0-9_-]*)\1\s*\]/g, '.$2')
      .replace(/\s+/g, '')
      .toLowerCase();
    if (root === 'secrets') return /(?:^|[^a-z0-9_])secrets(?:$|[^a-z0-9_])/.test(normalized);
    if (root === 'github.event.inputs') return /(?:^|[^a-z0-9_])github\.event\.inputs(?:$|[^a-z0-9_])/.test(normalized);
    return false;
  });
}

function validateRequiredDocumentSteps(job, label, errors) {
  for (const step of Array.isArray(job?.steps) ? job.steps : []) {
    const stepLabel = step.name || step.run || step.uses || 'unnamed step';
    if (Object.hasOwn(step, 'if')) errors.push(`${label} ${stepLabel} must not be conditionally skipped`);
    if (Object.hasOwn(step, 'continue-on-error')) errors.push(`${label} ${stepLabel} must not ignore failures`);
  }
}

function validateWorkflowCompatibility(githubSource, giteaSource) {
  const errors = [];
  const githubDocument = parseWorkflowDocument(githubSource, 'GitHub workflow', errors);
  const giteaDocument = parseWorkflowDocument(giteaSource, 'Gitea workflow', errors);
  if (!githubDocument || !giteaDocument) return errors;

  const githubTriggers = githubDocument.on;
  const giteaTriggers = giteaDocument.on;
  const expectedTriggers = ['pull_request', 'push', 'workflow_dispatch'];
  if (!isDeepStrictEqual(sortedKeys(githubTriggers), expectedTriggers)) errors.push('GitHub workflow must define exactly push, pull_request and workflow_dispatch triggers');
  if (!isDeepStrictEqual(sortedKeys(giteaTriggers), expectedTriggers)) errors.push('Gitea workflow must define exactly push, pull_request and workflow_dispatch triggers');
  if (githubTriggers?.push !== null) errors.push('GitHub push trigger must remain unfiltered');
  if (githubTriggers?.pull_request !== null) errors.push('GitHub pull_request trigger must remain unfiltered');
  if (!isDeepStrictEqual(giteaTriggers?.push, githubTriggers?.push)) errors.push('GitHub and Gitea push triggers must be structurally equivalent');
  if (!isDeepStrictEqual(giteaTriggers?.pull_request, githubTriggers?.pull_request)) errors.push('GitHub and Gitea pull_request triggers must be structurally equivalent');
  if (giteaTriggers?.workflow_dispatch !== null) errors.push('Gitea workflow_dispatch must remain empty');

  const githubJobs = githubDocument.jobs;
  const giteaJobs = giteaDocument.jobs;
  if (!isDeepStrictEqual(sortedKeys(githubJobs), ['twitch-live', 'updater-live-postpublish', 'verify'])) errors.push('GitHub workflow must define exactly verify, twitch-live and updater-live-postpublish jobs');
  if (!isDeepStrictEqual(sortedKeys(giteaJobs), ['verify'])) errors.push('Gitea workflow must define exactly the verify job');
  if (!isDeepStrictEqual(giteaJobs?.verify, githubJobs?.verify)) errors.push('GitHub and Gitea verify jobs must be structurally equivalent');
  for (const jobName of ['verify', 'twitch-live', 'updater-live-postpublish']) validateRequiredDocumentSteps(githubJobs?.[jobName], `GitHub ${jobName}`, errors);
  validateRequiredDocumentSteps(giteaJobs?.verify, 'Gitea verify', errors);

  const giteaNamesAndValues = collectYamlNamesAndValues(giteaDocument);
  if (giteaNamesAndValues.some((value) => expressionUsesRoot(value, 'secrets'))) errors.push('Gitea workflow must not reference secrets');
  if (giteaNamesAndValues.some((value) => expressionUsesRoot(value, 'github.event.inputs'))) errors.push('Gitea workflow must not reference github.event.inputs');
  if (giteaNamesAndValues.some((value) => /^TWITCH_VOD_MANAGER_LIVE_/i.test(value))) errors.push('Gitea workflow must not contain live integration bindings');
  return errors;
}


function positiveTimeout(fields) {
  const values = fields.get('timeout-minutes') || [];
  return values.length === 1 && /^\d+$/.test(values[0]) && Number(values[0]) > 0;
}

function validateTimeouts(workflow, label, errors) {
  for (const job of workflow.jobs.values()) {
    if (!positiveTimeout(job.fields)) errors.push(`${label} job ${job.name} must define exactly one positive job-level timeout-minutes`);
    for (let index = 0; index < job.steps.length; index += 1) {
      const step = job.steps[index];
      const executionFields = (step.fields.get('run') || []).length + (step.fields.get('uses') || []).length;
      if (executionFields === 0) continue;
      const stepLabel = step.name || `unnamed step ${index + 1}`;
      if (executionFields !== 1) errors.push(`${label} ${job.name} ${stepLabel} must define exactly one of run or uses`);
      if (!positiveTimeout(step.fields)) errors.push(`${label} ${job.name} ${stepLabel} must define exactly one positive timeout-minutes`);
    }
  }
}

function validateCheckouts(workflow, label, errors) {
  for (const job of workflow.jobs.values()) {
    const checkouts = job.steps.filter((step) => /^actions\/checkout@/.test(singleField(step.fields, 'uses') || ''));
    if (checkouts.length !== 1 || singleField(checkouts[0].fields, 'uses') !== 'actions/checkout@v4') {
      errors.push(`${label} job ${job.name} must define exactly one actions/checkout@v4 step`);
    }
  }
}

function validateSetupNode(workflow, label, errors) {
  for (const job of workflow.jobs.values()) {
    const setupSteps = job.steps.filter((step) => /^actions\/setup-node@/.test(singleField(step.fields, 'uses') || ''));
    if (setupSteps.length !== 1 || singleField(setupSteps[0].fields, 'uses') !== 'actions/setup-node@v4' || singleField(setupSteps[0].with, 'node-version') !== "'24.11.1'") {
      errors.push(`${label} job ${job.name} must define exactly one actions/setup-node@v4 step pinned to Node 24.11.1`);
    }
  }
}

function stepByName(job, name) {
  const matches = job?.steps.filter((step) => step.name === name) || [];
  return matches.length === 1 ? matches[0] : undefined;
}

function stepIndexByRun(job, command) {
  return job?.steps.findIndex((step) => singleField(step.fields, 'run') === command) ?? -1;
}

function hasTrimmedLine(step, expected) {
  return step?.raw.split(/\r?\n/).some((line) => line.trim() === expected) || false;
}

const strictVersionPattern = "'^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$'";

function hasStrictUpdaterVersions(step) {
  return hasTrimmedLine(step, '$sourceVersionText = $env:TWITCH_VOD_MANAGER_LIVE_SOURCE_VERSION.Trim()')
    && hasTrimmedLine(step, '$updateVersionText = $env:TWITCH_VOD_MANAGER_LIVE_UPDATE_VERSION.Trim()')
    && hasTrimmedLine(step, `$versionPattern = ${strictVersionPattern}`)
    && hasTrimmedLine(step, 'if ($sourceVersionText -notmatch $versionPattern) {')
    && hasTrimmedLine(step, 'if ($updateVersionText -notmatch $versionPattern) {')
    && hasTrimmedLine(step, '$sourceVersion = [version]$sourceVersionText')
    && hasTrimmedLine(step, '$updateVersion = [version]$updateVersionText')
    && !step.raw.includes('TrimStart');
}

function hasExactChainedCommand(script, expected) {
  if (typeof script !== 'string') return false;
  return script.split(/\s*&&\s*/).filter((command) => command === expected).length === 1;
}

function validateManualGate(job, gate, label, errors) {
  const expected = `github.event_name == 'workflow_dispatch' && github.event.inputs.live_gate == '${gate}'`;
  if (singleField(job?.fields || new Map(), 'if') !== expected) errors.push(`${label} ${job?.name || gate} must be manual-only for ${gate}`);
  if (singleField(job?.fields || new Map(), 'needs') !== 'verify') errors.push(`${label} ${job?.name || gate} must require verify`);
}

function findSecretLeaks(job, allowedStep, secretNames) {
  const leaks = [];
  for (const name of secretNames) {
    if (job.env.has(name) || job.header.includes(`secrets.${name}`)) leaks.push(`job:${name}`);
    for (let index = 0; index < job.steps.length; index += 1) {
      const step = job.steps[index];
      if (step === allowedStep) continue;
      if (step.env.has(name) || step.raw.includes(`secrets.${name}`)) leaks.push(`step:${index + 1}:${name}`);
    }
  }
  return leaks;
}

const parserFixture = parseWorkflow(`jobs:
  fixture:
    timeout-minutes: 30
    steps:
      - name: named
        uses: actions/checkout@v4
        timeout-minutes: 10
        timeout-minutes: 11
      - run: npm test`);
const parserFixtureErrors = [];
validateTimeouts(parserFixture, 'fixture', parserFixtureErrors);
check(parserFixture.jobs.get('fixture')?.steps.length === 2, 'CI parser does not recognize an unnamed step boundary');
check(parserFixtureErrors.includes('fixture fixture named must define exactly one positive timeout-minutes'), 'CI timeout contract accepts duplicate step timeouts');
check(parserFixtureErrors.includes('fixture fixture unnamed step 2 must define exactly one positive timeout-minutes'), 'CI timeout contract accepts a missing timeout hidden by another step');

const gateFixture = parseWorkflow(`jobs:
  updater-live-postpublish:
    if: false
    needs: verify
    timeout-minutes: 30
    steps:
      - run: Write-Output "github.event_name == 'workflow_dispatch' && github.event.inputs.live_gate == 'updater-postpublish'"
        timeout-minutes: 10`);
const gateFixtureErrors = [];
validateManualGate(gateFixture.jobs.get('updater-live-postpublish'), 'updater-postpublish', 'fixture', gateFixtureErrors);
check(gateFixtureErrors.includes('fixture updater-live-postpublish must be manual-only for updater-postpublish'), 'CI manual gate contract accepts a condition embedded in run text');

const secretNames = ['TWITCH_VOD_MANAGER_LIVE_TWITCH_CLIENT_ID', 'TWITCH_VOD_MANAGER_LIVE_TWITCH_CLIENT_SECRET', 'TWITCH_VOD_MANAGER_LIVE_TWITCH_LOGIN', 'TWITCH_VOD_MANAGER_LIVE_TWITCH_VOD_ID'];
const secretFixture = parseWorkflow(`jobs:
  twitch-live:
    timeout-minutes: 30
    steps:
      - name: provider
        run: npm run provider
        timeout-minutes: 10
      - run: npm run unrelated
        env:
          TWITCH_VOD_MANAGER_LIVE_TWITCH_CLIENT_SECRET: \${{ secrets.TWITCH_VOD_MANAGER_LIVE_TWITCH_CLIENT_SECRET }}
        timeout-minutes: 10`);
const secretFixtureJob = secretFixture.jobs.get('twitch-live');
check(findSecretLeaks(secretFixtureJob, stepByName(secretFixtureJob, 'provider'), secretNames).includes('step:2:TWITCH_VOD_MANAGER_LIVE_TWITCH_CLIENT_SECRET'), 'CI secret scope contract misses a leak in an unnamed following step');

const releaseCommandPrefixFixture = 'npm run build && npm run test:live-integration-contract-shadow';
check(!hasExactChainedCommand(releaseCommandPrefixFixture, 'npm run test:live-integration-contract'), 'Release command contract accepts a longer command with the required command as a prefix');
check(hasExactChainedCommand('npm run build && npm run test:live-integration-contract', 'npm run test:live-integration-contract'), 'Release command contract rejects an exact required command');
check(!hasExactChainedCommand('npm run build && npm run test:unit', 'npm run test:live-integration-contract'), 'Release command contract accepts a missing required command');
check(!hasExactChainedCommand('npm run test:live-integration-contract && npm run test:live-integration-contract', 'npm run test:live-integration-contract'), 'Release command contract accepts a duplicate required command');

const duplicateKeyFixture = parseWorkflow(`jobs:
  fixture:
    timeout-minutes: 30
    env:
      CI: 'true'
      CI: 'false'
    env:
      OTHER: value
    steps:
      - uses: actions/checkout@v4
        with:
          ref: first
          ref: second
        with:
          fetch-depth: 1
        timeout-minutes: 10`);
for (const duplicatePath of ['jobs.fixture.env', 'jobs.fixture.env.CI', 'jobs.fixture.steps[0].with', 'jobs.fixture.steps[0].with.ref']) {
  check(duplicateKeyFixture.duplicateKeys?.includes(duplicatePath), `CI parser does not report duplicate YAML key ${duplicatePath}`);
}

const duplicateJobFixture = parseWorkflow(`jobs:
  fixture:
    timeout-minutes: 10
    steps:
      - run: npm test
        timeout-minutes: 10
  fixture:
    timeout-minutes: 10
    steps:
      - run: npm test
        timeout-minutes: 10`);
check(duplicateJobFixture.duplicateKeys?.includes('jobs.fixture'), 'CI parser does not report a duplicate job key');

const permissiveVersionPreflightFixture = {
  raw: `$sourceVersion = [version]($env:TWITCH_VOD_MANAGER_LIVE_SOURCE_VERSION.TrimStart('v'))
$updateVersion = [version]($env:TWITCH_VOD_MANAGER_LIVE_UPDATE_VERSION.TrimStart('v'))`
};
check(!hasStrictUpdaterVersions(permissiveVersionPreflightFixture), 'CI version preflight contract accepts prefixes, suffixes or leading zeroes');

const missingCheckoutFixture = parseWorkflow(`jobs:
  fixture:
    timeout-minutes: 30
    steps:
      - uses: actions/setup-node@v4
        timeout-minutes: 10`);
const missingCheckoutErrors = [];
validateCheckouts(missingCheckoutFixture, 'fixture', missingCheckoutErrors);
check(missingCheckoutErrors.includes('fixture job fixture must define exactly one actions/checkout@v4 step'), 'CI job action contract accepts a job without checkout');

const extraCheckoutFixture = parseWorkflow(`jobs:
  fixture:
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        timeout-minutes: 10
      - uses: actions/checkout@v3
        timeout-minutes: 10`);
const extraCheckoutErrors = [];
validateCheckouts(extraCheckoutFixture, 'fixture', extraCheckoutErrors);
check(extraCheckoutErrors.includes('fixture job fixture must define exactly one actions/checkout@v4 step'), 'CI job action contract accepts an additional checkout version');

const extraSetupNodeFixture = parseWorkflow(`jobs:
  fixture:
    timeout-minutes: 30
    steps:
      - uses: actions/setup-node@v4
        timeout-minutes: 10
        with:
          node-version: '24.11.1'
      - uses: actions/setup-node@v3
        timeout-minutes: 10`);
const extraSetupNodeErrors = [];
validateSetupNode(extraSetupNodeFixture, 'fixture', extraSetupNodeErrors);
check(extraSetupNodeErrors.includes('fixture job fixture must define exactly one actions/setup-node@v4 step pinned to Node 24.11.1'), 'CI job action contract accepts an additional setup-node version');

function hasSingleConditionalRetry(source, command) {
  const lines = source.split(/\r?\n/);
  const commandIndexes = lines
    .map((line, index) => line.trim() === command ? index : -1)
    .filter((index) => index >= 0);
  if (commandIndexes.length !== 2) return false;
  const [first, second] = commandIndexes;
  return second === first + 2
    && lines[first + 1]?.trim() === 'if ($LASTEXITCODE -ne 0) {'
    && lines[first + 3]?.trim() === 'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'
    && lines[first + 4]?.trim() === '}';
}

const retryFixture = (command) => `${command}\nif ($LASTEXITCODE -ne 0) {\n  ${command}\n  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n}`;
for (const command of ['npx install-electron --no', 'npm run pack', 'npm run dist:ci']) {
  check(hasSingleConditionalRetry(retryFixture(command), command), `CI retry contract rejects a valid ${command} retry`);
  check(!hasSingleConditionalRetry(`${retryFixture(command)}\n${command}`, command), `CI retry contract accepts more than one ${command} retry`);
  check(!hasSingleConditionalRetry(`${command}\n${command}`, command), `CI retry contract accepts an unconditional ${command} retry`);
}

const compatibilityGithubFixture = `on:
  push:
  pull_request:
  workflow_dispatch:
    inputs: {}
jobs:
  verify:
    runs-on: windows-latest
  twitch-live:
    runs-on: windows-latest
  updater-live-postpublish:
    runs-on: windows-latest`;
const compatibilityGiteaFixture = `on:
  push:
  pull_request:
  workflow_dispatch:
jobs:
  verify:
    runs-on: windows-latest`;
check(validateWorkflowCompatibility(compatibilityGithubFixture, compatibilityGiteaFixture).length === 0, 'Workflow compatibility contract rejects a compatible Gitea workflow');

const quotedJobCompatibilityErrors = validateWorkflowCompatibility(compatibilityGithubFixture, compatibilityGiteaFixture.replace('jobs:', `jobs:
  "extra":
    runs-on: windows-latest`));
check(quotedJobCompatibilityErrors.includes('Gitea workflow must define exactly the verify job'), 'Gitea compatibility contract accepts a quoted additional job');

const filteredTriggerCompatibilityErrors = validateWorkflowCompatibility(compatibilityGithubFixture, compatibilityGiteaFixture.replace('  push:', `  push:
    branches-ignore:
      - '**'`));
check(filteredTriggerCompatibilityErrors.includes('GitHub and Gitea push triggers must be structurally equivalent'), 'Gitea compatibility contract accepts a disabling push filter');

const forbiddenExpressionCompatibilityErrors = validateWorkflowCompatibility(compatibilityGithubFixture, compatibilityGiteaFixture.replace('    runs-on: windows-latest', `    runs-on: windows-latest
    env:
      FIRST: \${{secrets.UNTRACKED_LIVE_TOKEN}}
      SECOND: \${{ github['event']['inputs']['live_gate'] }}`));
check(forbiddenExpressionCompatibilityErrors.includes('Gitea workflow must not reference secrets'), 'Gitea compatibility contract accepts an alternative secrets expression');
check(forbiddenExpressionCompatibilityErrors.includes('Gitea workflow must not reference github.event.inputs'), 'Gitea compatibility contract accepts an indexed github.event.inputs expression');

const skippedLiveStepGithubFixture = compatibilityGithubFixture.replace(`  twitch-live:
    runs-on: windows-latest`, `  twitch-live:
    runs-on: windows-latest
    steps:
      - name: provider
        "if": false
        run: npm run provider
      - name: ignored
        "continue-on-error": true
        run: npm run ignored`);
const skippedLiveStepErrors = validateWorkflowCompatibility(skippedLiveStepGithubFixture, compatibilityGiteaFixture);
check(skippedLiveStepErrors.includes('GitHub twitch-live provider must not be conditionally skipped'), 'GitHub live gate contract accepts if: false on a required step');
check(skippedLiveStepErrors.includes('GitHub twitch-live ignored must not ignore failures'), 'GitHub live gate contract accepts continue-on-error on a required step');

const requiredScripts = {
  lint: 'eslint .',
  'security:check': 'node scripts/security-check.js && node scripts/smoke-test-public-release-config.js',
  'test:security': 'node --test scripts/security-check.test.js',
  'test:lint-config': 'node --test scripts/lint-config.test.mjs',
  'test:ci-contract': 'node scripts/smoke-test-ci-contract.js',
  'test:installer-contract': 'node --test scripts/smoke-test-installer.test.js',
  'test:managed-tools-contract': 'node --test scripts/smoke-test-managed-tools-live.test.js',
  'test:cutter-matrix-contract': 'node --test scripts/smoke-test-cutter-media-matrix.test.js',
  'test:managed-tools-live': 'node scripts/smoke-test-managed-tools-live.js',
  'test:live-integration-contract': 'npm run build && node --test scripts/smoke-test-live-integration.test.js',
  'test:live:twitch': 'node scripts/smoke-test-live-integration.js twitch',
  'test:live:updater-postpublish': 'node scripts/smoke-test-live-integration.js updater',
  'test:e2e:cutter-matrix': 'npm run build && node scripts/smoke-test-cutter-media-matrix.js',
  'test:e2e:focused': 'npm run test:e2e:isolation && npm run test:e2e:workspace-ui',
  'test:packaged-launch': 'node scripts/smoke-test-packaged-launch.js',
  'test:installer': 'node scripts/smoke-test-installer.js',
  'dist:ci': 'electron-builder --win nsis'
};

for (const [name, command] of Object.entries(requiredScripts)) {
  check(packageJson.scripts?.[name] === command, `package script ${name} is missing or changed`);
}

for (const contract of ['test:installer-contract', 'test:managed-tools-contract', 'test:cutter-matrix-contract', 'test:live-integration-contract']) {
  check(hasExactChainedCommand(packageJson.scripts?.['test:e2e:release'], `npm run ${contract}`), `release verification does not include exactly one ${contract} command`);
}

const workflowSources = new Map();
for (const relativePath of ['.github/workflows/windows-ci.yml', '.gitea/workflows/windows-ci.yml']) {
  const absolutePath = path.join(root, relativePath);
  check(fs.existsSync(absolutePath), `${relativePath} is missing`);
  if (!fs.existsSync(absolutePath)) continue;

  const source = fs.readFileSync(absolutePath, 'utf8');
  workflowSources.set(relativePath, source);
  const workflow = parseWorkflow(source);
  const verifyJob = workflow.jobs.get('verify');
  const twitchLiveJob = workflow.jobs.get('twitch-live');
  const updaterLiveJob = workflow.jobs.get('updater-live-postpublish');
  const requiredCommands = [
    'npm ci',
    'npm run lint',
    'npm run test:lint-config',
    'npm run security:check',
    'npm run test:security',
    'npm run test:ci-contract',
    'npm run test:installer-contract',
    'npm run test:managed-tools-contract',
    'npm run test:cutter-matrix-contract',
    'npm run test:live-integration-contract',
    'npm run test:unit',
    'npm run test:e2e:focused',
    'npm run build',
    'node scripts/smoke-test-cutter-media-matrix.js',
    'npm run test:managed-tools-live',
    'npm run test:packaged-launch',
    'npm run test:installer'
  ];

  if (relativePath === '.github/workflows/windows-ci.yml') {
    check(workflow.jobs.size === 3 && verifyJob && twitchLiveJob && updaterLiveJob, `${relativePath} must define exactly verify, twitch-live and updater-live-postpublish jobs`);
  } else {
    check(workflow.jobs.size === 1 && verifyJob, `${relativePath} must define exactly the verify job`);
  }
  check(workflow.duplicateKeys.length === 0, `${relativePath} contains duplicate YAML keys: ${workflow.duplicateKeys.join(', ')}`);
  validateTimeouts(workflow, relativePath, failures);
  validateCheckouts(workflow, relativePath, failures);
  validateSetupNode(workflow, relativePath, failures);
  if (relativePath === '.github/workflows/windows-ci.yml') {
    for (const input of ['source_version', 'source_sha256', 'update_version', 'update_sha512']) {
      check((workflow.dispatchInputs.get(input) || []).length === 1, `${relativePath} workflow_dispatch must define explicit ${input}`);
    }
  }
  for (const job of workflow.jobs.values()) check(singleField(job.fields, 'runs-on') === 'windows-latest', `${relativePath} ${job.name} does not use a Windows runner`);
  for (const command of requiredCommands) {
    check(stepIndexByRun(verifyJob, command) >= 0, `${relativePath} verify job is missing an exact ${command} run step`);
  }
  const verifyBuildIndex = stepIndexByRun(verifyJob, 'npm run build');
  const verifyLiveContractIndex = stepIndexByRun(verifyJob, 'npm run test:live-integration-contract');
  check(verifyBuildIndex >= 0 && verifyBuildIndex < verifyLiveContractIndex, `${relativePath} verify must build before the live integration contract`);
  check(verifyBuildIndex < stepIndexByRun(verifyJob, 'npm run test:managed-tools-live'), `${relativePath} runs the live managed-tools check before build`);
  for (const command of ['npm run pack', 'npm run dist:ci']) {
    check(hasSingleConditionalRetry(verifyJob?.steps.map((step) => step.raw).join('\n') || '', command), `${relativePath} does not retry transient ${command} failures exactly once`);
  }
  check(hasSingleConditionalRetry(verifyJob?.steps.map((step) => step.raw).join('\n') || '', 'npx install-electron --no'), `${relativePath} does not retry Electron binary provisioning exactly once`);
  check(findSecretLeaks(verifyJob, undefined, secretNames).length === 0, `${relativePath} exposes Twitch live inputs to normal CI`);
  if (relativePath === '.github/workflows/windows-ci.yml') {
    validateManualGate(twitchLiveJob, 'twitch', relativePath, failures);
    const twitchProviderStep = stepByName(twitchLiveJob, 'Twitch provider OAuth, Helix and bounded VOD gate');
    for (const name of secretNames) {
      check(singleField(twitchProviderStep?.env || new Map(), name) === `\${{ secrets.${name} }}`, `${relativePath} Twitch live ${name.toLowerCase()} is not scoped to the final provider step`);
    }
    check(findSecretLeaks(twitchLiveJob, twitchProviderStep, secretNames).length === 0, `${relativePath} exposes Twitch secrets outside the final provider step`);
    check(singleField(twitchProviderStep?.env || new Map(), 'TWITCH_VOD_MANAGER_LIVE_INTEGRATION') === "'1'" && singleField(twitchProviderStep?.fields || new Map(), 'run') === 'npm run test:live:twitch', `${relativePath} Twitch live gate is not explicitly opted in at the final provider step`);
    check(twitchLiveJob?.steps.some((step) => step.name === 'Provision pinned media tools' && step.raw.includes('TWITCH_VOD_MANAGER_LIVE_STREAMLINK_PATH') && step.raw.includes('TWITCH_VOD_MANAGER_LIVE_FFPROBE_PATH')), `${relativePath} Twitch live gate does not provision its real media tools`);
    check(stepIndexByRun(twitchLiveJob, 'npm run build') >= 0 && stepIndexByRun(twitchLiveJob, 'npm run build') < stepIndexByRun(twitchLiveJob, 'npm run test:live-integration-contract'), `${relativePath} Twitch live gate must build before its integration contract`);
    validateManualGate(updaterLiveJob, 'updater-postpublish', relativePath, failures);
    for (const input of ['source_version', 'source_sha256', 'update_version', 'update_sha512']) {
      check(singleField(updaterLiveJob?.env || new Map(), `TWITCH_VOD_MANAGER_LIVE_${input.toUpperCase()}`) === `\${{ github.event.inputs.${input} }}`, `${relativePath} updater live gate does not bind explicit ${input}`);
    }
    check(singleField(updaterLiveJob?.env || new Map(), 'TWITCH_VOD_MANAGER_LIVE_UPDATE_COMMIT_SHA') === '${{ github.sha }}', `${relativePath} updater live gate does not bind provenance to github.sha`);
    const updaterCheckout = updaterLiveJob?.steps.filter((step) => singleField(step.fields, 'uses') === 'actions/checkout@v4') || [];
    check(updaterCheckout.length === 1 && singleField(updaterCheckout[0].with, 'ref') === '${{ github.sha }}', `${relativePath} updater checkout is not explicitly bound to github.sha`);
    check(singleField(updaterLiveJob?.env || new Map(), 'TWITCH_VOD_MANAGER_LIVE_INTEGRATION') === "'1'" && stepIndexByRun(updaterLiveJob, 'npm run test:live:updater-postpublish') >= 0, `${relativePath} updater live gate is not explicitly opted in`);
    check(stepIndexByRun(updaterLiveJob, 'npm run build') >= 0 && stepIndexByRun(updaterLiveJob, 'npm run build') < stepIndexByRun(updaterLiveJob, 'npm run test:live-integration-contract'), `${relativePath} updater live gate must build before its integration contract`);
    const updaterPreflight = stepByName(updaterLiveJob, 'Require explicit post-publish updater inputs');
    check(updaterPreflight && secretNames.every((name) => !updaterPreflight.raw.includes(name)), `${relativePath} updater preflight references Twitch credentials`);
    check(hasTrimmedLine(updaterPreflight, "'TWITCH_VOD_MANAGER_LIVE_UPDATE_COMMIT_SHA'") && hasTrimmedLine(updaterPreflight, "if ($env:TWITCH_VOD_MANAGER_LIVE_UPDATE_COMMIT_SHA -notmatch '^[0-9a-fA-F]{40}$') {") && hasTrimmedLine(updaterPreflight, 'if (-not [string]::Equals($env:TWITCH_VOD_MANAGER_LIVE_UPDATE_COMMIT_SHA, $env:GITHUB_SHA, [StringComparison]::OrdinalIgnoreCase)) {'), `${relativePath} updater preflight does not verify commit provenance against GITHUB_SHA`);
    check(hasStrictUpdaterVersions(updaterPreflight) && hasTrimmedLine(updaterPreflight, 'if ($sourceVersion -ge $updateVersion) {'), `${relativePath} updater preflight does not require exact source_version < update_version`);
    check(hasTrimmedLine(updaterPreflight, '$packageVersion = (Get-Content -Raw -LiteralPath package.json | ConvertFrom-Json).version') && hasTrimmedLine(updaterPreflight, 'if ($updateVersionText -ne $packageVersion) {') && hasTrimmedLine(updaterPreflight, '$expectedRef = "refs/tags/v$updateVersionText"') && hasTrimmedLine(updaterPreflight, 'if ($env:GITHUB_REF -ne $expectedRef) {'), `${relativePath} updater preflight does not bind the exact update version text to package.json and its release tag`);
    const updaterExecutionStep = stepByName(updaterLiveJob, 'Verify published updater path');
    check(singleField(updaterExecutionStep?.fields || new Map(), 'timeout-minutes') === '25', `${relativePath} updater live gate does not allow 25 minutes for a real installer download`);
  }
}

const giteaCompatibilitySource = workflowSources.get('.gitea/workflows/windows-ci.yml') || '';
for (const error of validateWorkflowCompatibility(workflowSources.get('.github/workflows/windows-ci.yml') || '', giteaCompatibilitySource)) failures.push(error);

const liveIntegrationSource = fs.readFileSync(path.join(root, 'scripts/smoke-test-live-integration.js'), 'utf8');
check(/dist['"],\s*['"]main['"],\s*['"]twitch['"]/.test(liveIntegrationSource), 'Twitch provider live gate does not load the built Twitch product module');
check(liveIntegrationSource.includes('TwitchAppTokenService') && liveIntegrationSource.includes('requestTwitchAppAccessToken'), 'Twitch provider live gate bypasses the product token service');

for (const relativePath of [
  'scripts/security-check.js',
  'scripts/security-check.test.js',
  'scripts/lint-config.test.mjs',
  'scripts/smoke-test-packaged-launch.js',
  'scripts/smoke-test-installer.js',
  'scripts/smoke-test-installer.test.js',
  'scripts/smoke-test-managed-tools-live.js',
  'scripts/smoke-test-managed-tools-live.test.js',
  'scripts/smoke-test-live-integration-contract.js',
  'scripts/smoke-test-live-integration.js',
  'scripts/smoke-test-live-integration.test.js',
  'scripts/smoke-test-cutter-media-matrix.js',
  'scripts/smoke-test-cutter-media-matrix.test.js'
]) {
  check(fs.existsSync(path.join(root, relativePath)), `${relativePath} is missing`);
}

console.log(JSON.stringify({ failures }, null, 2));
if (failures.length) process.exitCode = 1;

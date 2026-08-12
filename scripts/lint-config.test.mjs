import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, 'eslint.config.mjs') });

async function messagesFor(source, filePath) {
  const [result] = await eslint.lintText(source, { filePath: path.join(root, filePath) });
  return result.messages;
}

test('accepts classic renderer declarations and browser globals', async () => {
  const messages = await messagesFor('function openPanel() { return document.title; }\n', 'src/renderer-contract-fixture.ts');
  assert.deepEqual(messages, []);
});

test('keeps recommended renderer errors active', async () => {
  const messages = await messagesFor('function openPanel() { debugger; return document.title; }\n', 'src/renderer-contract-fixture.ts');
  assert.ok(messages.some((message) => message.ruleId === 'no-debugger' && message.severity === 2));
});

test('accepts CommonJS imports and rejects unused script bindings', async () => {
  const messages = await messagesFor("const fs = require('node:fs');\nconst unused = fs;\n", 'scripts/contract-fixture.js');
  assert.ok(messages.some((message) => message.ruleId === 'no-unused-vars' && message.severity === 2));
  assert.ok(!messages.some((message) => message.ruleId === '@typescript-eslint/no-require-imports'));
});

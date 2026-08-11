const assert = require('assert');
const { createCutterExportRequest, requireFileCapability } = require('./file-capability-contract');

assert.throws(() => requireFileCapability('C:\\forged\\video.mp4'));
assert.throws(() => requireFileCapability({ token: 'short', name: 'video.mp4' }));
assert.throws(() => requireFileCapability({ token: 'x'.repeat(43), name: 'C:\\forged\\video.mp4' }));

const capability = { token: 'x'.repeat(43), name: 'video.mp4', displayPath: 'C:\\private\\video.mp4' };
assert.deepStrictEqual(requireFileCapability(capability), { token: 'x'.repeat(43), name: 'video.mp4' });

const request = createCutterExportRequest(capability, 'C:\\exports\\result.mp4', { trimStart: 1, trimEnd: 5, cuts: [] });
assert.deepStrictEqual(request, {
  inputCapability: 'x'.repeat(43),
  outputName: 'result.mp4',
  trimStart: 1,
  trimEnd: 5,
  cuts: [],
});
assert.strictEqual('inputFile' in request, false);
assert.strictEqual('outputFile' in request, false);

console.log('File capability contract tests passed.');

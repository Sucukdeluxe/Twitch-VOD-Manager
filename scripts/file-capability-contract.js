function fileName(value) {
  return String(value).split(/[/\\]/).pop() || '';
}

function requireFileCapability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('File capability reference is required');
  if (typeof value.token !== 'string' || value.token.length < 32) throw new Error('Opaque file capability token is required');
  if (typeof value.name !== 'string' || !value.name || fileName(value.name) !== value.name) throw new Error('Safe file display name is required');
  return { token: value.token, name: value.name };
}

function createCutterExportRequest(capability, outputFile, state) {
  const file = requireFileCapability(capability);
  const outputName = fileName(outputFile);
  if (!outputName.toLowerCase().endsWith('.mp4')) throw new Error('MP4 output name is required');
  return {
    inputCapability: file.token,
    outputName,
    trimStart: state.trimStart,
    trimEnd: state.trimEnd,
    cuts: state.cuts,
  };
}

module.exports = { requireFileCapability, createCutterExportRequest };

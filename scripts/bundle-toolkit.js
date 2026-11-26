const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { buildSync } = require('esbuild');

const bundlePath = 'vendor/actions-toolkit/core.cjs';
const result = buildSync({
  stdin: {
    contents: [
      "export { getInput, notice, setOutput, setSecret, warning } from '@actions/core';",
      "export { context, getOctokit } from '@actions/github';",
    ].join('\n'),
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: bundlePath,
  metafile: true,
});

const packageDirectories = new Set();
for (const input of Object.keys(result.metafile.outputs[bundlePath].inputs)) {
  const match = /^(.*\bnode_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match) packageDirectories.add(match[1]);
}

const licenses = [...packageDirectories].sort().map((directory) => {
  const filename = readdirSync(directory).find((name) => /^license(?:\.[^.]+)?$/i.test(name));
  if (!filename) throw new Error(`Missing license in ${directory}`);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const license = readFileSync(join(directory, filename), 'utf8').trimEnd();
  return `${manifest.name} ${manifest.version}\n\n${license}`;
});
writeFileSync(join(dirname(bundlePath), 'LICENSES.txt'), `${licenses.join('\n\n---\n\n')}\n`);

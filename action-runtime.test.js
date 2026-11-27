const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { load } = require('js-yaml');

const ignoredDirectories = new Set(['.git', '.idea', 'node_modules', 'scratch', 'vendor']);

function findActionManifests(directory = '.') {
  return readdirSync(join(__dirname, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) return findActionManifests(path);
    if (entry.isFile() && ['action.yml', 'action.yaml'].includes(entry.name)) return [path];
    return [];
  });
}

const version = readFileSync(join(__dirname, '.nvmrc'), 'utf8').trim();
const major = /^v?(\d+)(?:\.\d+){0,2}$/.exec(version)?.[1];

test('.nvmrc specifies a Node.js version with an explicit major', () => {
  expect(major).toBeDefined();
});

test.each(findActionManifests())('%s uses the Node.js major from .nvmrc', (path) => {
  const manifest = load(readFileSync(join(__dirname, path), 'utf8'));
  expect(manifest?.runs?.using).toBe(`node${major}`);
});

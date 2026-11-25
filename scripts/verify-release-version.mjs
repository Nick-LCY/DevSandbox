#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requestedTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (!requestedTag || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(requestedTag)) {
  throw new Error('release tag must have the exact form vX.Y.Z');
}

const expectedVersion = requestedTag.slice(1);
const jsonFiles = [
  'apps/desktop/package.json',
  'apps/web/frontend/package.json',
  'infra/worker/package.json',
];

const versions = new Map();
for (const relativePath of jsonFiles) {
  const file = resolve(repoRoot, relativePath);
  const document = JSON.parse(await readFile(file, 'utf8'));
  versions.set(relativePath, document.version);
}

const tauriConfigPath = resolve(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json');
const tauriConfig = await readFile(tauriConfigPath, 'utf8');
const tauriVersion = tauriConfig.match(/^\s*"version"\s*:\s*"([^"]+)"\s*,?\s*$/m)?.[1];
versions.set('apps/desktop/src-tauri/tauri.conf.json', tauriVersion);

const cargoPath = resolve(repoRoot, 'apps/desktop/src-tauri/Cargo.toml');
const cargo = await readFile(cargoPath, 'utf8');
const packageStart = cargo.indexOf('[package]');
const nextSection = packageStart === -1 ? -1 : cargo.indexOf('\n[', packageStart + '[package]'.length);
const packageSection = packageStart === -1
  ? ''
  : cargo.slice(packageStart + '[package]'.length, nextSection === -1 ? cargo.length : nextSection);
const cargoVersion = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
versions.set('apps/desktop/src-tauri/Cargo.toml', cargoVersion);

const mismatches = [...versions].filter(([, version]) => version !== expectedVersion);
if (mismatches.length > 0) {
  const details = mismatches.map(([file, version]) => `${file}=${version ?? '<missing>'}`).join(', ');
  throw new Error(`release version ${expectedVersion} does not match: ${details}`);
}

console.log(`release version ${requestedTag} matches ${versions.size} version files`);

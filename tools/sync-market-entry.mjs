#!/usr/bin/env node
/**
 * Point the market entry at a published npm version.
 *
 * The plugin index needs, per version, the exact `version` and an integer
 * `publishTimestamp` in Unix seconds; both come from the registry, so this
 * script reads them instead of asking a human to copy a date.
 *
 * Usage:
 *   node tools/sync-market-entry.mjs                 # dry run, latest tag
 *   node tools/sync-market-entry.mjs --write         # apply, latest tag
 *   node tools/sync-market-entry.mjs 0.2.2 --write   # apply, explicit version
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = 'dsh-zhihu-mini';
const REGISTRY = 'https://registry.npmjs.org';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'market');

const args = process.argv.slice(2);
const write = args.includes('--write');
const explicit = args.find((a) => /^\d+\.\d+\.\d+/.test(a));

const packument = await (await fetch(REGISTRY + '/' + PKG)).json();
const version = explicit || packument['dist-tags']?.latest;
if (!version) throw new Error('no version resolved');
if (!packument.versions?.[version]) throw new Error(PKG + '@' + version + ' is not published yet');
const publishedAt = packument.time?.[version];
if (!publishedAt) throw new Error('no publish time for ' + version);
const publishTimestamp = Math.floor(Date.parse(publishedAt) / 1000);

function update(file, mutate) {
  const p = path.join(ROOT, file);
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const before = JSON.stringify(doc.plugins ? doc.plugins[0].versions : doc.versions);
  mutate(doc);
  const after = JSON.stringify(doc.plugins ? doc.plugins[0].versions : doc.versions);
  if (write && before !== after) fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
  console.log((write ? 'updated ' : 'would update ') + file);
}

const applyTo = (plugin) => {
  plugin.versions = [
    {
      version,
      publishTimestamp,
      source: { type: 'npm', registry: REGISTRY + '/' },
      engines: { dsh: '>=0.2.1-0 <0.3.0-0' },
    },
  ];
};

update('plugin-entry.json', (doc) => applyTo(doc));
update('index.json', (doc) => applyTo(doc.plugins[0]));
console.log(
  PKG + '@' + version + ' published ' + new Date(publishTimestamp * 1000).toISOString() +
    ' (publishTimestamp ' + publishTimestamp + ')',
);
if (!write) console.log('dry run; pass --write to apply');
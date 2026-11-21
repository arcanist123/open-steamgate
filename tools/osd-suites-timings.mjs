// Merge downloaded shard artifacts; retries never change the first-run weights.
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

// The registry (loadSuites) allows suites at any depth under test/, so the
// artifacts may name a nested suite (test/adt-conformance/suite.mjs does, and
// its timing crashed every weekly refresh since 2026-10-05). Accept exactly
// that shape: under test/, ending .mjs, no empty or dot-dot segment.
export const isSuitePath = (file) => {
  const parts = file.split('/');
  return parts[0] === 'test' && file.endsWith('.mjs') &&
    parts.slice(1).every((part) => part !== '' && part !== '.' && part !== '..');
};

export function mergeTimings(previous, artifacts) {
  const samples = new Map();
  for (const artifact of artifacts) {
    for (const [file, seconds] of Object.entries(artifact.seconds ?? artifact)) {
      if (!isSuitePath(file) || !Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`invalid timing: ${file} = ${seconds}`);
      }
      if (!samples.has(file)) samples.set(file, []);
      samples.get(file).push(seconds);
    }
  }
  const merged = {...previous};
  for (const [file, values] of samples) {
    values.sort((a, b) => a - b);
    merged[file] = (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || !inputs.length) throw new Error('usage: node tools/osd-suites-timings.mjs test/suites-timings.json <artifact.json> ...');
  const previous = JSON.parse(readFileSync(output, 'utf8'));
  const artifacts = inputs.map((file) => JSON.parse(readFileSync(file, 'utf8')));
  writeFileSync(output, JSON.stringify(mergeTimings(previous, artifacts), null, 2) + '\n');
}

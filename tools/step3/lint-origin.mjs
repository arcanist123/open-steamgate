import assert from "node:assert/strict";

// Keep the existing differential CLI usable for either in-process engine.
// One server log must identify one successful prime; completed checks must use
// that engine too. A trap/refusal has no completion line and cannot pass.
export function lintOrigin(log, expected) {
  const primes = [...log.matchAll(/lint-engine=(abap|go) prime=1 files=/g)];
  assert.equal(primes.length, 1, "origin gate: expected exactly one successful prime in this server's log");
  const engine = primes[0][1];
  if (expected !== undefined) assert.equal(engine, expected, "origin gate: engine changed");
  const completed = [...log.matchAll(/lint-engine=(abap|go) check=\d+ issues=\d+ elapsed=/g)];
  for (const line of completed) assert.equal(line[1], engine, "origin gate: mixed engines");
  return {engine, checks: completed.length};
}

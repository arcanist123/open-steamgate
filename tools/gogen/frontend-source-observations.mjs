// Existing frontend source probes, shared with selection certification. Keep
// their historical answers: certification compares these actual observations,
// rather than guessing dependencies from words in an edited source.
import {AMC_CALLER} from "./frontend-classes-native.mjs";
/** @param {string} source @returns {string[]} */
export function localInterfaceNames(source) {
  return [...source.matchAll(/\bINTERFACE\s+(LIF_[A-Z0-9_]+)\s*\./gi)].map(m => m[1].toUpperCase());
}
/** @param {string} source @returns {string[]} */
export function currentTypeNames(source) {
  return [
    ...[...source.matchAll(/\bTYPES\s*:?\s*(?:BEGIN\s+OF\s+)?([\w\/]+)/gi)].map(m => m[1].toUpperCase()),
    ...[...source.matchAll(/,\s*(?:BEGIN\s+OF\s+)?([\w\/]+)\s+TYPE\b/gi)].map(m => m[1].toUpperCase()),
  ];
}
/** @param {string} source @returns {boolean} */
export function amcSource(source) { return AMC_CALLER.test(source); }

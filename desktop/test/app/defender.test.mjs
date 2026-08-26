import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { isCoveredBy } = loadDist('engine/defender.js');

const FOLDER = 'C:\\Users\\Filip\\AppData\\Local\\open-emulator';

test('an exact match counts as covered', () => {
  assert.equal(isCoveredBy(FOLDER, [FOLDER]), true);
});

test('matching is case- and trailing-slash-insensitive, like Windows paths', () => {
  assert.equal(isCoveredBy(FOLDER, ['c:\\users\\filip\\appdata\\local\\open-emulator\\']), true);
});

test('a broader exclusion covering a parent counts, so we do not add a redundant one', () => {
  // If the user already excludes their whole profile, ours is already covered.
  assert.equal(isCoveredBy(FOLDER, ['C:\\Users\\Filip']), true);
});

test('an unrelated exclusion does not count', () => {
  assert.equal(isCoveredBy(FOLDER, ['C:\\Games', 'D:\\']), false);
});

test('a sibling that shares a prefix but not a path boundary does not count', () => {
  // "open-emulator-old" starts with the same text but is a different directory.
  assert.equal(isCoveredBy(FOLDER, ['C:\\Users\\Filip\\AppData\\Local\\open-emulator-old']), false);
});

test('an empty exclusion list is not covered', () => {
  assert.equal(isCoveredBy(FOLDER, []), false);
  assert.equal(isCoveredBy(FOLDER, ['', '  ']), false);
});

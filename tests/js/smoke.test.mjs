import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');

test('app.js parses as valid JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(read('app/src/main/assets/js/app.js')));
});

test('index.html references existing local assets', () => {
  const html = read('app/src/main/assets/index.html');
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => !/^(?:data:|https?:|#)/i.test(value));

  assert.ok(references.length > 0, 'expected at least one local asset reference');
  for (const reference of references) {
    assert.equal(existsSync(resolve(root, 'app/src/main/assets', reference)), true, reference);
  }
});

test('index.html has unique required element ids', () => {
  const html = read('app/src/main/assets/index.html');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(', ')}`);

  for (const required of ['view-library', 'view-reader', 'view-study', 'bottom-nav', 'study-selected-panel', 'study-mastered-panel']) {
    assert.ok(ids.includes(required), `missing required id: ${required}`);
  }
});

test('bundled runtime assets and study sources are present', () => {
  const required = [
    'app/src/main/assets/libs/epub.min.js',
    'app/src/main/assets/libs/jszip.min.js',
    'app/src/main/assets/books/pg11.epub',
    'app/src/main/assets/books/pg1342.epub',
    'app/src/main/assets/books/pg2701.epub',
    'app/src/main/assets/wordbooks/core.txt',
    'app/src/main/assets/wordbooks/intermediate.txt',
    'app/src/main/assets/wordbooks/advanced.txt',
    'app/src/main/assets/wordbooks/extended.txt',
  ];
  for (const file of required) assert.equal(existsSync(resolve(root, file)), true, file);
});

test('responsive CSS and accessibility viewport contract are present', () => {
  const html = read('app/src/main/assets/index.html');
  const css = read('app/src/main/assets/css/style.css');
  assert.match(html, /name="viewport"/);
  assert.match(css, /跨设备响应式适配/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /study-inline-panel/);
});

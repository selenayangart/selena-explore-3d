import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../styles/feature.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/explore.js', import.meta.url), 'utf8');

test('artwork emphasis uses dimming instead of borders or focus rings', () => {
  const card = css.match(/^\.ex-card\s*\{([^}]+)\}/m)[1];
  assert.match(card, /border:0;/);
  assert.match(css, /\.ex-card:focus-visible\s*\{\s*outline:none;/);
  assert.match(css, /\.ex-card:focus-visible \.ex-card-cap\s*\{\s*text-decoration:underline;/);
  assert.doesNotMatch(source, /card\.style\.borderColor/);
  for (const state of ['is-focus', 'is-collection-member', 'is-year-match']) {
    const rule = css.match(new RegExp('\\.ex-marker\\.' + state + ' \\.ex-card\\s*\\{([^}]+)\\}'))[1];
    assert.match(rule, /filter:brightness\(1\)/);
    assert.doesNotMatch(rule, /border|outline/);
  }
  assert.match(css, /\.ex-marker\.is-context-dim\s*\{\s*opacity:\.12;/);
  assert.match(source, /classList\.toggle\('is-context-dim', candidate !== marker/);
});

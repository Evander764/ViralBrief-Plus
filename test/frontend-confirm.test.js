import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = process.cwd();

test('破坏性操作使用页面内确认弹层，不直接依赖浏览器 confirm', () => {
  const appJs = readFileSync(join(root, 'web', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');

  assert.match(appJs, /function askConfirm\(/);
  assert.doesNotMatch(appJs, /if \(!confirm\(/);
  assert.doesNotMatch(appJs, /await confirm\(/);

  for (const id of ['confirmDialog', 'confirmMessage', 'confirmOk', 'confirmCancel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('账号池搜索填空用当前窗口跳转，兼容原生 WebKit 窗口', () => {
  const appJs = readFileSync(join(root, 'web', 'app.js'), 'utf8');

  assert.match(appJs, /function platformSearchUrl\(/);
  assert.match(appJs, /window\.location\.assign\(url\)/);
  assert.doesNotMatch(appJs, /window\.open\(/);
});

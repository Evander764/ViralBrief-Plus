import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeUrlBasename } from '../server/lib/url-path.js';

test('safeUrlBasename 解码中文截图文件名并保留 basename 防穿越', () => {
  assert.equal(
    safeUrlBasename('rpa_xiaohongshu_%E5%BD%B1%E8%A7%86%E9%A3%93%E9%A3%8E_1780223772299.png'),
    'rpa_xiaohongshu_影视飓风_1780223772299.png',
  );
  assert.equal(safeUrlBasename('..%2Fsecret.png'), 'secret.png');
});

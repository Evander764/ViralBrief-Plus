'use strict';
const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = await chrome.storage.local.get(['endpoint', 'token']);
  $('endpoint').value = cfg.endpoint || 'http://127.0.0.1:8787';
  $('token').value = cfg.token || '';
}

$('save').addEventListener('click', async () => {
  const endpoint = $('endpoint').value.trim().replace(/\/$/, '');
  const token = $('token').value.trim();
  await chrome.storage.local.set({ endpoint, token });
  $('msg').textContent = '已保存。'; $('msg').className = 'msg ok';
});

$('test').addEventListener('click', async () => {
  const endpoint = $('endpoint').value.trim().replace(/\/$/, '');
  $('msg').textContent = '测试中…'; $('msg').className = 'msg';
  try {
    const res = await fetch(`${endpoint}/api/health`);
    const r = await res.json();
    if (r.ok) {
      $('msg').textContent = `连接成功！桌面端 ${r.version}，API Key ${r.hasApiKey ? '已配置' : '未配置'}。`;
      $('msg').className = 'msg ok';
    } else throw new Error('返回异常');
  } catch (e) {
    $('msg').textContent = '连接失败：' + e.message + '（请确认桌面端已启动）';
    $('msg').className = 'msg bad';
  }
});

load();

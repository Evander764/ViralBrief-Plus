/**
 * API Key 加密存储。
 *
 * 文档要求：「如果使用配置文件，必须加密存储」。这里用 AES-256-GCM，
 * 加密密钥放在独立的 data/.keyfile（权限 0600）。这能防止 config.json
 * 被误分享 / 误提交 / 随手 cat 出来导致泄露。
 *
 * 诚实说明其边界：密钥就在本机另一个文件里，无法防御「已经能读你磁盘」
 * 的攻击者。更强的方案是 OS 钥匙串（macOS Keychain / Windows Credential
 * Manager），可作为后续增强（见 README）。
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { KEYFILE_PATH, ensureDirs } from './paths.js';

function loadKey() {
  ensureDirs();
  if (existsSync(KEYFILE_PATH)) return readFileSync(KEYFILE_PATH);
  const key = randomBytes(32);
  writeFileSync(KEYFILE_PATH, key, { mode: 0o600 });
  try { chmodSync(KEYFILE_PATH, 0o600); } catch { /* 非 POSIX 平台忽略 */ }
  return key;
}

export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: enc.toString('base64') };
}

export function decryptSecret(blob) {
  if (!blob || !blob.iv || !blob.data || !blob.tag) return null;
  try {
    const key = loadKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

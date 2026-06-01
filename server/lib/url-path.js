import { basename } from 'node:path';

export function safeUrlBasename(segment = '') {
  const raw = String(segment || '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return basename(decoded.replace(/\\/g, '/'));
}

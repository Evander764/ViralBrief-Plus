import { inspect } from 'node:util';

let redactList = [];

/** 注册需要在日志中脱敏的密钥（如 API Key）。长度过短的忽略，避免误伤。 */
export function addRedaction(secret) {
  if (secret && String(secret).length >= 6) redactList.push(String(secret));
}
export function clearRedaction() {
  redactList = [];
}

function strOf(x) {
  if (typeof x === 'string') return x;
  if (x instanceof Error) return x.stack || x.message || String(x);
  return inspect(x, { depth: 4, colors: false });
}

/** 对任意值做字符串化 + 脱敏。永远不会把完整 API Key 写进日志/错误。 */
export function redact(x) {
  let s = strOf(x);
  for (const sec of redactList) {
    if (sec) s = s.split(sec).join('***REDACTED***');
  }
  return s;
}

const ts = () => new Date().toISOString();

export const log = {
  info: (...a) => console.log(`[${ts()}]`, a.map(redact).join(' ')),
  warn: (...a) => console.warn(`[${ts()}] WARN`, a.map(redact).join(' ')),
  error: (...a) => console.error(`[${ts()}] ERROR`, a.map(redact).join(' ')),
};

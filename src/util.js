// 공통 도구 모음: 한국 시간, 응답, 해시 등

export const KST_OFFSET = 9 * 60 * 60 * 1000;

/** 한국 시간 기준 현재 정보 */
export function kstNow(ms = Date.now()) {
  const d = new Date(ms + KST_OFFSET);
  const iso = d.toISOString();
  return {
    date: iso.slice(0, 10),            // 2026-11-13
    hm: iso.slice(11, 16),             // 20:30
    dow: d.getUTCDay(),                // 0=일 ~ 6=토
    stamp: iso.slice(0, 19).replace('T', ' '), // 2026-11-13 20:30:12
  };
}

export function dowOf(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isLastDayOfMonth(dateStr) {
  return addDays(dateStr, 1).slice(8, 10) === '01';
}

const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
export function dowKo(dateStr) { return DOW_KO[dowOf(dateStr)]; }

/** 11월 13일 (금) */
export function dateKo(dateStr) {
  const m = Number(dateStr.slice(5, 7));
  const d = Number(dateStr.slice(8, 10));
  return `${m}월 ${d}일 (${dowKo(dateStr)})`;
}
/** 11/13(금) */
export function dateShort(dateStr) {
  return `${Number(dateStr.slice(5, 7))}/${Number(dateStr.slice(8, 10))}(${dowKo(dateStr)})`;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = (msg) => new HttpError(400, msg);

export function randomToken(len = 24) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

/** 문자열을 숫자로 (같은 입력이면 항상 같은 값) — 쿠션 멘트 고르기용 */
export function hashNum(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export async function hashPassword(pw, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 10000 }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 휴대폰 번호 정리: 숫자만, 01로 시작 10~11자리 */
export function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('82') && d.length >= 11) d = '0' + d.slice(2);
  if (d.length === 10 && d.startsWith('1')) d = '0' + d;
  return d;
}
export function validPhone(p) { return /^01\d{8,9}$/.test(p) || /^0\d{8,10}$/.test(p); }
export function fmtPhone(p) {
  const d = normPhone(p);
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}

export function hmToMin(hm) {
  const [h, m] = String(hm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

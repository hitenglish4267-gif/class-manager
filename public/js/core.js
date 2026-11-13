// 화면 공통 도구: 요소 만들기, 서버 부르기, 알림, 창, 자동 저장 보관함

// null·false 는 화면에 'null'로 찍히지 않게 걸러 내기
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const fn of ['replaceChildren', 'append', 'prepend']) {
    const orig = proto[fn];
    proto[fn] = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); };
  }
}

export const VERSION = document.documentElement.dataset.version || 'dev';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── 아이콘 (단순한 선 아이콘) ──
const P = {
  today: 'M4 6h16M4 12h16M4 18h10',
  check: 'M5 12l4 4L19 7',
  hw: 'M7 4h10a2 2 0 0 1 2 2v14l-7-3-7 3V6a2 2 0 0 1 2-2z',
  msg: 'M4 5h16v11H8l-4 4z',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  left: 'M15 18l-6-6 6-6', right: 'M9 18l6-6-6-6', down: 'M6 9l6 6 6-6', x: 'M6 6l12 12M18 6L6 18',
  cam: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  plus: 'M12 5v14M5 12h14', out: 'M15 4h4v16h-4M10 16l-4-4 4-4M6 12h10',
  pen: 'M4 20h4L19 9l-4-4L4 16z', trash: 'M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
};
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', P[name] || ''); svg.append(p);
  return svg;
}

// ── 알림 ──
let toastTimer;
export function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('bad', bad); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 4200 : 2200);
}

// ── 서버 부르기 ──
export let onUnauthorized = () => {};
export function setUnauthorized(fn) { onUnauthorized = fn; }
export async function api(path, body, opts = {}) {
  const init = { method: body !== undefined ? (opts.method || 'POST') : (opts.method || 'GET'), headers: {}, credentials: 'same-origin', keepalive: !!opts.keepalive };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401 && !path.startsWith('/api/login')) { onUnauthorized(); }
  if (!res.ok) { const e = new Error((data && data.error) || `연결 오류 (${res.status})`); e.status = res.status; throw e; }
  return data;
}

// ── 창 (아래에서 올라오는 시트) ──
export function sheet(title, content, opts = {}) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); opts.onClose && opts.onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const body = h('div', { class: 'sheet-body' });
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'sheet-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': '닫기', onclick: close }, icon('x'))),
      body));
  body.append(typeof content === 'function' ? content(close) : content);
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  return { close, body };
}

export function confirmBox(title, text, okLabel = '확인', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const s = sheet(title, (close) => h('div', null,
      h('p', { style: { margin: '0 0 18px', whiteSpace: 'pre-line', color: 'var(--ink-2)' } }, text),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        h('button', { class: 'btn', onclick: () => { done = true; close(); resolve(false); } }, '취소'),
        h('button', { class: 'btn ' + (danger ? 'dark' : 'primary'), onclick: () => { done = true; close(); resolve(true); } }, okLabel))),
    { onClose: () => { if (!done) resolve(false); } });
    return s;
  });
}

// ── 날짜 ──
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
export function kstToday() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
export function addDays(d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
export function dowOf(d) { return new Date(d + 'T00:00:00Z').getUTCDay(); }
export function dateLabel(d) { return `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일 (${DOW[dowOf(d)]})`; }
export function hmOf(stamp) { return stamp ? String(stamp).slice(11, 16) : ''; }
export const DOW_KO = DOW;

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }, text); document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* */ } ta.remove();
  }
  toast('링크를 복사했어요');
}

export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ─────────────────────────────────────────────
   자동 저장 보관함 (입력한 내용이 절대 사라지지 않게)
   - 입력하는 즉시 이 기기(localStorage)에 먼저 보관
   - 정해진 시간(기본 2초) 뒤 서버로 저장, 성공하면 보관함에서 지움
   - 새로고침 · 창 닫기 · 인터넷 끊김 뒤에도 다시 열면 보관함 내용으로 복구 후 다시 저장
   ───────────────────────────────────────────── */
const OB_KEY = 'cm_outbox_v1';
const listeners = new Set();
const timers = new Map();
const inflight = new Map();
export const saveState = new Map(); // key → { state: 'ok'|'busy'|'bad', at, error }

function readOb() { try { return JSON.parse(localStorage.getItem(OB_KEY) || '{}'); } catch { return {}; } }
function writeOb(o) { try { localStorage.setItem(OB_KEY, JSON.stringify(o)); } catch { /* 저장공간 부족 */ } }
function emit(key) { for (const fn of listeners) fn(key); }

export const outbox = {
  get(key) { return readOb()[key] || null; },
  all() { return readOb(); },
  pending(prefix = '') { return Object.keys(readOb()).filter((k) => k.startsWith(prefix)); },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  put(key, url, body, delay = 2000) {
    const o = readOb();
    o[key] = { url, body, ts: Date.now() };
    writeOb(o);
    saveState.set(key, { state: 'busy', at: null });
    emit(key);
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => outbox.flush(key), delay));
  },
  async flush(key, opts = {}) {
    clearTimeout(timers.get(key));
    const entry = readOb()[key];
    if (!entry) return true;
    if (inflight.has(key)) { await inflight.get(key); if (readOb()[key] && readOb()[key].ts !== entry.ts) return outbox.flush(key, opts); return !readOb()[key]; }
    saveState.set(key, { state: 'busy' }); emit(key);
    const p = (async () => {
      try {
        const res = await api(entry.url, entry.body, { keepalive: opts.keepalive });
        const o = readOb();
        if (o[key] && o[key].ts === entry.ts) { delete o[key]; writeOb(o); }
        saveState.set(key, { state: readOb()[key] ? 'busy' : 'ok', at: (res && res.saved_at) || nowStamp(), res });
        emit(key);
        if (readOb()[key]) setTimeout(() => outbox.flush(key), 300);
        return true;
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429) {
          // 서버가 거절한 내용은 다시 보내도 같은 결과라 보관함에서 빼고 알려 주기
          const o = readOb(); if (o[key] && o[key].ts === entry.ts) { delete o[key]; writeOb(o); }
          toast(e.message, true);
        }
        saveState.set(key, { state: 'bad', error: e.message });
        emit(key);
        return false;
      } finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  },
  async flushAll(opts = {}) {
    const keys = Object.keys(readOb());
    const results = await Promise.all(keys.map((k) => outbox.flush(k, opts)));
    return results.every(Boolean);
  },
};
function nowStamp() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' '); }

export function saveLabel(key) {
  const s = saveState.get(key);
  const pend = !!outbox.get(key);
  if (s && s.state === 'bad') return { cls: 'bad', text: '저장 실패 · 눌러서 다시 저장' };
  if (pend || (s && s.state === 'busy')) return { cls: 'busy', text: '저장 중…' };
  if (s && s.state === 'ok') return { cls: 'ok', text: `자동 저장됨 ✓ ${hmOf(s.at)}` };
  return { cls: '', text: '입력하면 2초 뒤 자동 저장돼요' };
}

window.addEventListener('online', () => outbox.flushAll());
setInterval(() => { if (navigator.onLine && Object.keys(readOb()).length) outbox.flushAll(); }, 15000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') outbox.flushAll({ keepalive: true }); });
window.addEventListener('beforeunload', (e) => {
  if (Object.keys(readOb()).length) {
    outbox.flushAll({ keepalive: true });
    e.preventDefault(); e.returnValue = '';
  }
});

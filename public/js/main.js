// 앱 시작: 로그인 → 화면 나누기 → 메뉴

import { h, $, api, icon, toast, VERSION, setUnauthorized, outbox } from './core.js';
import { S } from './state.js';
import { renderToday } from './today.js';
import { renderHomework } from './homework.js';
import { renderMessages } from './messages.js';
import { renderCurricula } from './curricula.js';
import { renderAdmin } from './admin.js';

const VIEWS = [
  { id: 'today', label: '오늘 수업', icon: 'today', render: renderToday },
  { id: 'homework', label: '숙제 현황', icon: 'hw', render: renderHomework },
  { id: 'messages', label: '학부모 메시지', short: '메시지', icon: 'msg', render: renderMessages },
  { id: 'curricula', label: '진도표', icon: 'book', render: renderCurricula },
  { id: 'admin', label: '관리', icon: 'gear', render: renderAdmin, director: true },
];

setUnauthorized(() => { if (S.me) { S.me = null; toast('다시 로그인해 주세요', true); start(); } });

async function start() {
  let boot;
  try { boot = await api('/api/boot'); }
  catch (e) { $('#app').replaceChildren(h('div', { class: 'boot' }, '연결이 끊겼어요. 잠시 뒤 다시 열어 주세요.')); setTimeout(start, 5000); return; }
  S.boot = boot;
  if (boot.version && boot.version !== VERSION && VERSION !== '__APP_VERSION__') return reloadForNewVersion();
  if (boot.setup) return renderSetup();
  if (!boot.me) return renderLogin(boot);
  S.me = boot.me;
  S.meta = await api('/api/meta');
  document.title = `${S.meta.academy || '수업 관리'}`;
  const hash = location.hash.replace('#', '');
  const v = VIEWS.find((x) => x.id === hash && (!x.director || S.me.role === 'director'));
  go(v ? v.id : (S.meta.academy ? 'today' : 'admin'), true);
}

export async function go(id, first = false) {
  if (!first) await outbox.flushAll(); // 다른 탭으로 넘어가기 전에 먼저 저장
  S.view = id;
  history.replaceState(null, '', '#' + id);
  const v = VIEWS.find((x) => x.id === id) || VIEWS[0];
  const navBtn = (x, cls) => h('button', { 'aria-current': String(x.id === id), onclick: () => go(x.id) }, icon(x.icon), cls === 'b' ? (x.short || x.label) : x.label);
  const views = VIEWS.filter((x) => !x.director || S.me.role === 'director');
  const top = h('header', { class: 'top' }, h('div', { class: 'top-in' },
    h('div', { class: 'brand' }, h('span', { class: 'aca' }, S.meta.academy || '학원 이름을 정해 주세요'), h('span', { class: 'ttl' }, v.label)),
    h('nav', { class: 'nav' }, views.map((x) => navBtn(x))),
    h('div', { class: 'who' }, S.me.name, h('button', { class: 'icon-btn', title: '로그아웃', 'aria-label': '로그아웃', onclick: logout }, icon('out')))));
  const main = h('main', { class: 'view' });
  const bottom = h('nav', { class: 'bottom-nav' }, views.map((x) => navBtn(x, 'b')));
  $('#app').replaceChildren(top, main, bottom);
  window.scrollTo(0, 0);
  S.stopPoll && S.stopPoll(); S.stopPoll = null;
  try { await v.render(main); }
  catch (e) { console.error(e); main.replaceChildren(h('div', { class: 'note bad' }, e.message)); }
}
export function refreshTitle() {
  const a = $('.brand .aca'); if (a) a.textContent = S.meta.academy || '학원 이름을 정해 주세요';
}

async function logout() {
  await outbox.flushAll();
  await api('/api/logout', {}).catch(() => {});
  S.me = null; start();
}

function renderLogin(boot) {
  let who = localStorage.getItem('cm_last_who') || null;
  if (!boot.people.some((p) => p.who === who)) who = null;
  const pw = h('input', { class: 'input', type: 'password', placeholder: '비밀번호', autocomplete: 'current-password', onkeydown: (e) => { if (e.key === 'Enter') submit(); } });
  const people = h('div', { class: 'people' }, boot.people.map((p) => h('button', {
    'aria-pressed': String(p.who === who),
    onclick: (e) => { who = p.who; for (const b of people.children) b.setAttribute('aria-pressed', 'false'); e.currentTarget.setAttribute('aria-pressed', 'true'); pw.focus(); },
  }, p.name)));
  const err = h('div', { class: 'note bad hidden' });
  async function submit() {
    if (!who) { err.textContent = '이름을 먼저 골라 주세요'; err.classList.remove('hidden'); return; }
    try { await api('/api/login', { who, password: pw.value }); localStorage.setItem('cm_last_who', who); start(); }
    catch (e) { err.textContent = e.message; err.classList.remove('hidden'); pw.select(); }
  }
  $('#app').replaceChildren(h('div', { class: 'login' },
    h('div', { class: 'mark' }, h('img', { src: '/icon.svg', width: 48, height: 48, alt: '' })),
    h('h1', null, boot.academy || '수업 관리'), h('p', null, '이름을 고르고 비밀번호를 넣어 주세요.'),
    people, pw, h('div', { class: 'mt-s' }, err),
    h('button', { class: 'btn primary block mt', onclick: submit }, '들어가기')));
}

function renderSetup() {
  const aca = h('input', { class: 'input', placeholder: '예: 파머스어학원 진영캠퍼스' });
  const p1 = h('input', { class: 'input', type: 'password', placeholder: '4자 이상', autocomplete: 'new-password' });
  const p2 = h('input', { class: 'input', type: 'password', placeholder: '한 번 더', autocomplete: 'new-password' });
  const err = h('div', { class: 'note bad hidden' });
  async function submit() {
    if (!aca.value.trim()) { err.textContent = '학원 이름부터 적어 주세요'; err.classList.remove('hidden'); aca.focus(); return; }
    if (p1.value !== p2.value) { err.textContent = '두 비밀번호가 달라요'; err.classList.remove('hidden'); return; }
    try { await api('/api/setup', { academy: aca.value.trim(), password: p1.value }); location.hash = '#admin'; start(); }
    catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  }
  $('#app').replaceChildren(h('div', { class: 'login' },
    h('div', { class: 'mark' }, h('img', { src: '/icon.svg', width: 48, height: 48, alt: '' })),
    h('h1', null, '처음 시작하기'), h('p', null, '학원 이름과 원장님 비밀번호만 정하면 바로 쓸 수 있어요.'),
    h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, '학원 이름 (메시지 맨 앞에 들어가요)'), aca),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, '원장님 비밀번호'), p1),
      h('label', { class: 'field' }, p2), err),
    h('button', { class: 'btn primary block mt', onclick: submit }, '시작하기')));
  aca.focus();
}

// ── 새 버전이 배포되면 저장부터 하고 바로 새 화면으로 ──
async function reloadForNewVersion() {
  await outbox.flushAll().catch(() => {});
  location.reload();
}
async function checkVersion() {
  try {
    const r = await fetch('/api/version', { cache: 'no-store' }).then((x) => x.json());
    if (r.version && r.version !== VERSION && VERSION !== '__APP_VERSION__') reloadForNewVersion();
  } catch { /* 인터넷 끊김 */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
setInterval(checkVersion, 60000);
if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});

window.addEventListener('hashchange', () => {
  const id = location.hash.replace('#', '');
  if (S.me && id && id !== S.view && VIEWS.some((x) => x.id === id && (!x.director || S.me.role === 'director'))) go(id);
});

outbox.flushAll();
start();

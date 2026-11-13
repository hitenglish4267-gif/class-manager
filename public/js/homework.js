// 숙제 현황: 날짜별 반·학생 숙제 결과 + 미제출·미흡 누적

import { h, api, icon, addDays, kstToday, hmOf, outbox } from './core.js';
import { S, setDate, courseTabs } from './state.js';

const HW = { done: ['완료', 'ok'], partial: ['미흡', 'warn'], missing: ['미제출', 'bad'] };

export async function renderHomework(main) {
  const change = async (d) => { await outbox.flushAll(); setDate(d); renderHomework(main); };
  const dateInput = h('input', { type: 'date', value: S.date, onchange: () => change(dateInput.value) });
  const box = h('div', null, h('div', { class: 'empty' }, '불러오는 중…'));
  const tabs = h('div');
  main.replaceChildren(
    h('div', { class: 'toolbar' },
      h('div', { class: 'datebar' },
        h('button', { class: 'icon-btn', 'aria-label': '전날', onclick: () => change(addDays(S.date, -1)) }, icon('left')), dateInput,
        h('button', { class: 'icon-btn', 'aria-label': '다음날', onclick: () => change(addDays(S.date, 1)) }, icon('right'))),
      S.date !== kstToday() ? h('button', { class: 'btn small', onclick: () => change(kstToday()) }, '오늘로') : null,
      h('button', { class: 'btn small', style: { marginLeft: 'auto' }, onclick: () => { sessionStorage.setItem('cm_msg_kind', 'missing'); location.hash = '#messages'; } }, '미제출 알림 보내기')),
    tabs, box);
  let data;
  try { data = await api(`/api/homework?date=${S.date}`); } catch (e) { box.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
  const draw = () => {
    tabs.replaceChildren(courseTabs(h, draw));
    const list = data.classes.filter((c) => S.course === 'all' || String(c.course_id) === S.course);
    if (!list.length) { box.replaceChildren(h('div', { class: 'card empty' }, h('b', null, '이 날짜에 수업이 있는 반이 없어요'))); return; }
    box.replaceChildren(...list.map((c) => {
      const n = { done: 0, partial: 0, missing: 0 };
      for (const s of c.students) if (s.hw in n) n[s.hw]++;
      return h('section', { class: 'card' },
        h('div', { class: 'cls-head', style: { cursor: 'default' } },
          h('div', { class: 'grow' }, h('div', { class: 'name' }, c.name), h('div', { class: 'sub' }, c.type !== 'individual' ? `지난 숙제: ${c.prevHomework || '없음'}` : '개별수업')),
          h('span', { class: 'hwsum' }, h('span', { class: 'chip ok' }, `완료 ${n.done}`), h('span', { class: 'chip warn' }, `미흡 ${n.partial}`), h('span', { class: 'chip bad' }, `미제출 ${n.missing}`))),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', null, '학생'), c.type === 'individual' ? h('th', null, '지난 숙제') : null, h('th', null, '결과'), h('th', null, '학부모 알림'),
            h('th', { class: 'num' }, '이번 주'), h('th', { class: 'num' }, '이번 달'), h('th', { class: 'num' }, '최근 30일'))),
          h('tbody', null, c.students.map((s) => {
            const res = s.att === 'absent' ? h('span', { class: 'chip' }, '결석') : HW[s.hw] ? h('span', { class: 'chip ' + HW[s.hw][1] }, HW[s.hw][0]) : h('span', { class: 'muted small' }, '미체크');
            return h('tr', null,
              h('td', null, h('b', null, s.name), s.reason ? h('div', { class: 'tiny muted' }, s.reason) : null),
              c.type === 'individual' ? h('td', { class: 'small' }, s.prevHomework || '-') : null,
              h('td', null, res),
              h('td', { class: 'small' }, notice(s)),
              h('td', { class: 'num small' }, acc(s.acc.w_m, s.acc.w_p)),
              h('td', { class: 'num small' }, acc(s.acc.m_m, s.acc.m_p)),
              h('td', { class: 'num small' }, acc(s.acc.d_m, s.acc.d_p)));
          })))),
        h('div', { class: 'tiny muted', style: { padding: '8px 16px 12px' } }, '누적 칸: 미제출 / 미흡 횟수'));
    }));
  };
  draw();
}

function acc(m, p) {
  if (!m && !p) return h('span', { class: 'muted' }, '-');
  return h('span', null, h('b', { style: { color: m ? 'var(--bad)' : 'inherit' } }, m), ' / ', h('span', { style: { color: p ? 'var(--warn)' : 'inherit' } }, p));
}
function notice(s) {
  const one = (m, label) => {
    if (!m) return null;
    if (m.status === 'sent') return h('div', { style: { color: 'var(--ok)' } }, `✓ ${label} ${hmOf(m.sent_at)}`);
    if (m.status === 'failed') return h('div', { style: { color: 'var(--bad)' }, title: m.error }, `✕ ${label} 실패`);
    return h('div', { class: 'muted' }, m.checked ? `${label} 대기` : `${label} 안 보냄`);
  };
  return [one(s.daily, '리포트'), one(s.missing, '미제출 알림')].filter(Boolean).length ? [one(s.daily, '리포트'), one(s.missing, '미제출 알림')] : h('span', { class: 'muted' }, '-');
}

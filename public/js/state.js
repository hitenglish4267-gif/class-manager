// 화면 전체가 함께 쓰는 상태
import { kstToday } from './core.js';

export const S = {
  boot: null,
  me: null,
  meta: null,
  view: 'today',
  date: sessionStorage.getItem('cm_date') || kstToday(),
  course: sessionStorage.getItem('cm_course') || 'all',
  allDays: false,
  stopPoll: null,
};

export function setDate(d) { S.date = d; sessionStorage.setItem('cm_date', d); }
export function setCourse(c) { S.course = String(c); sessionStorage.setItem('cm_course', String(c)); }

/** 과정 탭 (전체 + 과정들) */
export function courseTabs(h, onPick, counts) {
  const tabs = [{ id: 'all', name: '전체' }, ...S.meta.courses.map((c) => ({ id: String(c.id), name: c.name }))];
  return h('div', { class: 'tabs', role: 'tablist' }, tabs.map((t) => h('button', {
    class: 'tab', role: 'tab', 'aria-selected': String(S.course === t.id),
    onclick: () => { setCourse(t.id); onPick(); },
  }, t.name, counts && counts[t.id] != null ? h('span', { class: 'muted', style: { marginLeft: '5px', fontWeight: 500 } }, counts[t.id]) : null)));
}

// 학습 평가: 오늘 수업한 항목을 고르고 → 학생마다 8가지 버튼을 눌러요 (자동 저장)
// 누르지 않은 항목은 주간 리포트에서 빠져요.

import { h, api, icon, toast, outbox, saveLabel, kstToday, addDays } from './core.js';
import { S, setDate } from './state.js';

let root;
let D = null;      // 서버에서 받은 이 반의 하루치
let classId = Number(sessionStorage.getItem('cm_eval_class') || 0);
let classes = [];

export async function renderEvals(main) {
  root = main;
  const dateInput = h('input', { type: 'date', value: S.date, onchange: () => changeDate(dateInput.value) });
  const classSel = h('select', { class: 'input', style: { width: 'auto', minWidth: '160px' }, onchange: async () => {
    await outbox.flushAll(); classId = Number(classSel.value); sessionStorage.setItem('cm_eval_class', classId); load();
  } });
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'datebar' },
      h('button', { class: 'icon-btn', 'aria-label': '전날', onclick: () => changeDate(addDays(S.date, -1)) }, icon('left')),
      dateInput,
      h('button', { class: 'icon-btn', 'aria-label': '다음날', onclick: () => changeDate(addDays(S.date, 1)) }, icon('right'))),
    S.date !== kstToday() ? h('button', { class: 'btn small', onclick: () => changeDate(kstToday()) }, '오늘로') : null,
    classSel);
  const body = h('div', { id: 'ev-body' }, h('div', { class: 'empty' }, '불러오는 중…'));
  main.replaceChildren(toolbar, body);
  try {
    const t = await api(`/api/today?date=${S.date}&all=1`);
    classes = t.classes;
  } catch (e) { body.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
  if (!classes.length) { body.replaceChildren(h('div', { class: 'card empty' }, '담당 반이 없어요.')); return; }
  const todays = classes.filter((c) => String(c.days || '').split(',').includes(String(new Date(S.date + 'T00:00:00Z').getUTCDay())));
  if (!classes.some((c) => c.id === classId)) classId = (todays[0] || classes[0]).id;
  classSel.replaceChildren(...classes.map((c) => h('option', { value: c.id, selected: c.id === classId }, `${c.name}${c.time ? ` · ${c.time}` : ''}${todays.includes(c) ? '' : ' (다른 요일)'}`)));
  const off = outbox.on((key) => paintSave(key));
  S.stopPoll = () => off();
  load();
}

async function changeDate(d) { await outbox.flushAll(); setDate(d); renderEvals(root); }

async function load() {
  const body = document.getElementById('ev-body');
  body.replaceChildren(h('div', { class: 'empty' }, '불러오는 중…'));
  try { D = await api(`/api/evals?date=${S.date}&class_id=${classId}`); }
  catch (e) { body.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
  // 아직 저장 안 된 입력이 있으면 그걸 먼저 보여 주기
  for (const s of D.students) {
    const e = outbox.get(`ev:${S.date}:${s.id}`); if (e) D.evals[s.id] = e.body.marks;
    const n = outbox.get(`dn:${S.date}:${s.id}`); if (n) D.notes[s.id] = n.body.fields;
  }
  const pend = outbox.get(`evi:${S.date}:${classId}`);
  if (pend) D.selected = pend.body.items;
  draw();
}

const active = (s) => !s.reason && s.att !== '결석';
function selectedItems() {
  const ids = D.selected || [];
  return D.items.filter((i) => ids.includes(i.id));
}

function draw() {
  const body = document.getElementById('ev-body');
  body.replaceChildren(itemPicker(), bulkCard(), ...D.students.map(studentCard));
}

// ── 오늘 수업한 항목 고르기 ──
function itemPicker() {
  const sel = new Set(D.selected || []);
  const saveItems = () => { D.selected = [...sel]; outbox.put(`evi:${S.date}:${classId}`, '/api/evals/items', { date: S.date, class_id: classId, items: D.selected }, 600); draw(); };
  const chip = (i) => h('button', { class: 'chip-btn' + (sel.has(i.id) ? ' on' : ''), onclick: () => { sel.has(i.id) ? sel.delete(i.id) : sel.add(i.id); saveItems(); } }, i.name);
  const area = D.items.filter((i) => i.group !== 'attitude');
  const att = D.items.filter((i) => i.group === 'attitude');
  return h('section', { class: 'card card-pad' },
    h('div', { class: 'row' }, h('h3', null, `${D.class.name} · 오늘 수업한 항목`),
      h('span', { class: 'small muted' }, `${sel.size}개 선택`), h('span', { class: 'grow' }),
      D.suggested && !(D.selected || []).length ? h('button', { class: 'btn small', onclick: () => { for (const id of D.suggested) sel.add(id); saveItems(); } }, '지난 수업과 같게') : null,
      sel.size ? h('button', { class: 'btn small ghost', onclick: () => { sel.clear(); saveItems(); } }, '모두 해제') : null),
    h('div', { class: 'tiny muted mt-s' }, '오늘 한 항목만 고르면 학생마다 그 항목만 나와요. 고르지 않은 항목은 주간 리포트에서 빠져요.'),
    h('div', { class: 'small mt-s', style: { fontWeight: 650 } }, '영역별 학습'), h('div', { class: 'chips mt-s' }, area.map(chip)),
    att.length ? h('div', { class: 'small mt', style: { fontWeight: 650 } }, '학습 태도') : null, att.length ? h('div', { class: 'chips mt-s' }, att.map(chip)) : null);
}

// ── 8가지 버튼 줄 ──
function markRow(item, isOn, onToggle) {
  return h('div', { class: 'ev-row' },
    h('div', { class: 'ev-name' }, item.name),
    h('div', { class: 'ev-marks' }, D.marks.map((m) => h('button', {
      class: `mk mk-${m.id}`, 'aria-pressed': String(isOn(m.id)), onclick: (e) => { onToggle(m.id); e.currentTarget.setAttribute('aria-pressed', String(isOn(m.id))); },
    }, m.label))));
}

function setMarks(s, item, list) {
  const map = D.evals[s.id] || (D.evals[s.id] = {});
  if (list.length) map[item] = list; else delete map[item];
  outbox.put(`ev:${S.date}:${s.id}`, '/api/evals', { date: S.date, student_id: s.id, marks: { ...map } }, 800);
}
function toggle(s, item, mark) {
  const cur = new Set((D.evals[s.id] || {})[item] || []);
  cur.has(mark) ? cur.delete(mark) : cur.add(mark);
  setMarks(s, item, [...cur]);
}

// ── 반 전체 한 번에 ──
function bulkCard() {
  const items = selectedItems();
  if (!items.length) return h('div');
  const targets = () => D.students.filter(active);
  const allHave = (item, mark) => { const t = targets(); return t.length > 0 && t.every((s) => ((D.evals[s.id] || {})[item] || []).includes(mark)); };
  return h('section', { class: 'card card-pad ev-bulk' },
    h('div', { class: 'row' }, h('h3', null, '반 전체 한 번에'), h('span', { class: 'tiny muted' }, '누르면 출석한 학생 모두에게 같은 평가가 들어가요. 다시 누르면 모두에게서 빠져요.')),
    ...items.map((i) => markRow(i, (m) => allHave(i.id, m), (m) => {
      const on = !allHave(i.id, m);
      for (const s of targets()) {
        const cur = new Set((D.evals[s.id] || {})[i.id] || []);
        on ? cur.add(m) : cur.delete(m);
        setMarks(s, i.id, [...cur]);
      }
      draw();
      toast(on ? `${i.name}: ${D.marks.find((x) => x.id === m).label} — ${targets().length}명` : `${i.name}: 모두에게서 뺐어요`);
    })));
}

// ── 학생 카드 ──
function studentCard(s) {
  const items = selectedItems();
  const notes = D.notes[s.id] || {};
  const filled = D.noteFields.filter(([k]) => notes[k]).length;
  const detail = h('div', { class: 'ev-detail' + (filled ? '' : ' hidden') },
    ...D.noteFields.map(([k, label]) => {
      const ph = k === 'done' ? (s.planned ? `예정: ${s.planned}` : '') : k === 'next_plan' ? (s.next ? `예정: ${s.next}` : '') : '';
      const ta = h('textarea', { class: 'input', rows: k === 'special' || k === 'memo' ? 2 : 1, value: notes[k] || '', placeholder: ph, oninput: () => {
        const n = D.notes[s.id] || (D.notes[s.id] = {});
        n[k] = ta.value;
        outbox.put(`dn:${S.date}:${s.id}`, '/api/daynotes', { date: S.date, student_id: s.id, fields: { ...n } }, 1500);
      } });
      return h('label', { class: 'field mt-s' }, h('span', { class: 'lbl' }, label), ta);
    }));
  const info = [s.book && `교재 ${s.book}`, s.planned && `진도 ${s.planned}`, s.hw && `숙제 ${s.hw}`, s.tests && `시험 ${s.tests}`].filter(Boolean).join(' · ');
  const st = h('span', { class: 'savest', 'data-ev': s.id });
  const card = h('section', { class: 'card card-pad ev-card' + (active(s) ? '' : ' off') },
    h('div', { class: 'row' }, h('b', { style: { fontSize: '16px' } }, s.name),
      s.reason ? h('span', { class: 'chip warn' }, s.reason) : s.att ? h('span', { class: 'chip ' + (s.att === '출석' ? 'ok' : s.att === '지각' ? 'warn' : 'bad') }, s.att) : h('span', { class: 'chip' }, '출석 미체크'),
      h('span', { class: 'grow' }), st),
    info ? h('div', { class: 'tiny muted mt-s' }, info) : null,
    items.length ? h('div', { class: 'mt-s' }, items.map((i) => markRow(i, (m) => ((D.evals[s.id] || {})[i.id] || []).includes(m), (m) => toggle(s, i.id, m))))
      : h('div', { class: 'tiny muted mt-s' }, '위에서 오늘 수업한 항목을 먼저 골라 주세요.'),
    h('button', { class: 'btn small ghost mt-s', onclick: () => detail.classList.toggle('hidden') }, filled ? `세부 기록 (${filled})` : '세부 기록 · 특별 코멘트 쓰기'),
    detail);
  paintSaveEl(st, s.id);
  return card;
}

function paintSaveEl(el, sid) {
  const keys = [`ev:${S.date}:${sid}`, `dn:${S.date}:${sid}`];
  const labels = keys.map(saveLabel);
  const bad = labels.find((l) => l.cls === 'bad'), busy = labels.find((l) => l.cls === 'busy'), ok = labels.find((l) => l.cls === 'ok');
  const l = bad || busy || ok || { cls: '', text: '' };
  el.className = 'savest ' + l.cls; el.textContent = l.cls ? l.text : '';
  if (bad) el.onclick = () => outbox.flushAll();
}
function paintSave(key) {
  const m = key.match(/^(?:ev|dn):[\d-]+:(\d+)$/);
  if (!m) return;
  const el = document.querySelector(`[data-ev="${m[1]}"]`);
  if (el) paintSaveEl(el, m[1]);
}


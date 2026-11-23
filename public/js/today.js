// 오늘 수업: 출석 → 미리 채워진 진도 확인 → 숙제 체크 (자동 저장)

import { h, $, $$, api, icon, toast, outbox, saveLabel, saveState, kstToday, addDays, dowOf, hmOf, copyText, debounce, sheet, confirmBox } from './core.js';
import { S, setDate, courseTabs } from './state.js';
import { openMedia } from './media.js';

const ATT = [['present', '출석', 'ok'], ['late', '지각', 'warn'], ['absent', '결석', 'bad']];
const HW = [['done', '완료', 'ok'], ['partial', '미흡', 'warn'], ['missing', '미제출', 'bad']];

let D = null;            // 서버에서 받은 오늘 데이터
const cards = new Map(); // 반 id → 입력 모델
let root, boardBox, listBox, tabsBox;

const recKey = (cid) => `rec:${S.date}:${cid}`;
const attKey = (sid) => `att:${S.date}:${sid}`;
const closedSet = () => new Set(JSON.parse(sessionStorage.getItem('cm_closed') || '[]'));
function toggleClosed(id) { const s = closedSet(); s.has(id) ? s.delete(id) : s.add(id); sessionStorage.setItem('cm_closed', JSON.stringify([...s])); }

export async function renderToday(main) {
  root = main;
  const dateInput = h('input', { type: 'date', value: S.date, onchange: () => changeDate(dateInput.value) });
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'datebar' },
      h('button', { class: 'icon-btn', 'aria-label': '전날', onclick: () => changeDate(addDays(S.date, -1)) }, icon('left')),
      dateInput,
      h('button', { class: 'icon-btn', 'aria-label': '다음날', onclick: () => changeDate(addDays(S.date, 1)) }, icon('right'))),
    S.date !== kstToday() ? h('button', { class: 'btn small', onclick: () => changeDate(kstToday()) }, '오늘로') : null,
    h('label', { class: 'switch small', style: { marginLeft: 'auto' } },
      h('input', { type: 'checkbox', checked: S.allDays, onchange: (e) => { S.allDays = e.target.checked; load(); } }), '요일 상관없이 모든 반'));
  boardBox = h('div');
  tabsBox = h('div');
  listBox = h('div', null, h('div', { class: 'empty' }, '불러오는 중…'));
  main.replaceChildren(toolbar, boardBox, tabsBox, listBox);
  await load();
  const timer = setInterval(() => { if (document.visibilityState === 'visible') softRefresh(); }, 20000);
  const off = outbox.on((key) => updateSaveBar(key));
  S.stopPoll = () => { clearInterval(timer); off(); };
}

async function changeDate(d) {
  await outbox.flushAll(); // 다른 날짜로 넘어가기 전에 먼저 저장
  setDate(d);
  renderToday(root);
}

async function load() {
  try {
    D = await api(`/api/today?date=${S.date}${S.allDays ? '&all=1' : ''}`);
  } catch (e) { listBox.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
  cards.clear();
  for (const c of D.classes) cards.set(c.id, makeModel(c));
  renderAll();
}

function makeModel(c) {
  const m = { logs: {}, studs: {}, att: {}, on: null, son: {} };
  const logOf = (target, p) => ({
    target, curriculum_id: p.curriculum_id, lesson_id: p.lesson_id, seq: p.seq,
    today: p.today, next: p.next, homework: p.homework, repeat: p.repeat ? 1 : 0,
  });
  if (c.type !== 'individual' && c.tracks) {
    m.on = new Set(c.tracks.filter((t) => t.on).map((t) => t.key));
    for (const t of c.tracks) if (t.on) m.logs[t.target] = logOf(t.target, t.progress);
  } else if (c.type !== 'individual' && c.progress) m.logs[c.target] = logOf(c.target, c.progress);
  for (const s of c.students) {
    if (s.solo && s.tracks) {
      m.son[s.id] = new Set(s.tracks.filter((t) => t.on).map((t) => t.key));
      for (const t of s.tracks) if (t.on) m.logs[t.target] = logOf(t.target, t.progress);
    }
    m.studs[s.id] = { hw: s.day.hw || '', comment: s.day.comment || '', tests: (s.tests || []).map((t) => ({ kind: t.kind, correct: t.correct ?? '', total: t.total ?? '', result: t.result || '', manual: false })) };
    m.att[s.id] = { att: s.day.att || '', reason: s.day.reason || '' };
  }
  // 이 기기에 보관된(아직 서버에 못 간) 입력이 있으면 그걸로 복구
  const draft = outbox.get(recKey(c.id));
  if (draft) {
    if (Array.isArray(draft.body.tracks_on) && c.tracks) {
      m.on = new Set(draft.body.tracks_on);
      for (const t of c.tracks) if (!m.on.has(t.key)) delete m.logs[t.target];
    }
    for (const s of c.students) {
      const k = draft.body.student_tracks_on && draft.body.student_tracks_on[s.id];
      if (Array.isArray(k) && s.tracks) { m.son[s.id] = new Set(k); for (const t of s.tracks) if (!m.son[s.id].has(t.key)) delete m.logs[t.target]; }
    }
    for (const l of draft.body.logs || []) m.logs[l.target] = { ...l };
    for (const s of draft.body.students || []) if (m.studs[s.id]) m.studs[s.id] = { hw: s.hw, comment: s.comment, tests: Array.isArray(s.tests) ? s.tests : m.studs[s.id].tests };
  }
  for (const s of c.students) {
    const a = outbox.get(attKey(s.id));
    if (a) m.att[s.id] = { att: a.body.att ?? m.att[s.id].att, reason: a.body.reason ?? m.att[s.id].reason };
  }
  return m;
}

function visibleClasses() {
  return D.classes.filter((c) => S.course === 'all' || String(c.course_id) === S.course);
}

function renderAll() {
  renderBoard();
  const counts = { all: D.classes.length };
  for (const c of D.classes) counts[String(c.course_id)] = (counts[String(c.course_id)] || 0) + 1;
  tabsBox.replaceChildren(courseTabs(h, renderAll, counts));
  const list = visibleClasses();
  if (!list.length) {
    listBox.replaceChildren(h('div', { class: 'card empty' },
      h('b', null, D.classes.length ? '이 과정에는 오늘 수업이 없어요' : '오늘 수업이 있는 반이 없어요'),
      S.me.role === 'director' && !D.classes.length ? '관리 → 반에서 수업 요일을 확인하거나, 위의 "요일 상관없이 모든 반"을 켜 보세요.' : '다른 날짜를 고르거나 "요일 상관없이 모든 반"을 켜 보세요.'));
    return;
  }
  listBox.replaceChildren(...list.map(classCard));
}

// ───────── 출석 현황판 ─────────
function renderBoard() {
  const dow = String(dowOf(S.date));
  const scheduled = D.classes.filter((c) => !S.allDays || String(c.days || '').split(',').includes(dow) || c.students.some((s) => cards.get(c.id).att[s.id].att));
  const b = { present: 0, late: 0, absent: 0, none: 0 };
  const pending = [];
  for (const c of scheduled) {
    const m = cards.get(c.id);
    let pend = 0, need = 0;
    for (const s of c.students) {
      const a = m.att[s.id];
      if (a.att) b[a.att]++;
      else if (!a.reason) { b.none++; pend++; }
      if (!a.reason) need++;
    }
    if (need && pend === need) pending.push(c);
  }
  const stat = (n, l, cls) => h('div', { class: 'stat ' + cls }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
  boardBox.replaceChildren(
    h('div', { class: 'board' }, stat(b.present, '출석', 'ok'), stat(b.late, '지각', 'warn'), stat(b.absent, '결석', 'bad'), stat(b.none, '미체크', '')),
    pending.length ? h('div', { class: 'pending-row' }, h('span', null, '아직 출석을 안 한 반'),
      pending.map((c) => h('span', { class: 'chip line', onclick: () => { const el = $(`#cls-${c.id}`); if (el) { el.classList.remove('closed'); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } } }, c.name, c.time ? ` ${c.time}` : '')))
      : h('div', { class: 'pending-row' }, scheduled.length ? h('span', { class: 'chip ok' }, '모든 반 출석 체크 완료') : null));
}

// ───────── 반 카드 ─────────
function hwSummary(c) {
  const m = cards.get(c.id);
  const n = { done: 0, partial: 0, missing: 0 };
  for (const s of c.students) { const hw = m.studs[s.id].hw; if (hw in n) n[hw]++; }
  return h('span', { class: 'hwsum' },
    h('span', { class: 'chip ok' }, `완료 ${n.done}`), h('span', { class: 'chip warn' }, `미흡 ${n.partial}`), h('span', { class: 'chip bad' }, `미제출 ${n.missing}`));
}

function classCard(c) {
  const closed = closedSet().has(c.id);
  const el = h('section', { class: 'card cls' + (closed ? ' closed' : ''), id: `cls-${c.id}` });
  const sum = h('span', { class: 'hwslot' }, hwSummary(c));
  const head = h('div', { class: 'cls-head', onclick: () => { el.classList.toggle('closed'); toggleClosed(c.id); } },
    h('div', { class: 'grow' },
      h('div', { class: 'row nowrap', style: { gap: '8px' } }, h('span', { class: 'name' }, c.name),
        h('span', { class: 'chip ' + (c.type === 'individual' ? 'info' : 'line') }, c.type === 'individual' ? '개별' : '그룹')),
      h('div', { class: 'sub' }, [c.time, c.room, S.me.role === 'director' ? c.teacher_name : '', `${c.students.length}명`].filter(Boolean).join(' · '))),
    sum, h('span', { class: 'chev' }, icon('down')));
  const body = h('div', { class: 'cls-body' });
  if (c.type !== 'individual' && c.tracks) body.append(tracksBlock(c));
  else if (c.type !== 'individual') body.append(progBlock(c, c.target, c.progress, null));
  body.append(h('div', { class: 'cls-actions' },
    h('button', { class: 'btn', onclick: () => allPresent(c) }, icon('check'), '모두 출석'),
    h('button', { class: 'btn', onclick: () => allHwDone(c) }, '모두 숙제 완료')));
  if (!c.students.length) body.append(h('div', { class: 'stu muted small' }, '이 반에 학생이 없어요. 관리 → 학생에서 추가해 주세요.'));
  for (const s of c.students) body.append(studentRow(c, s));
  const st = saveLabel(recKey(c.id));
  body.append(h('div', { class: 'savebar' },
    h('span', { class: 'savest ' + st.cls, 'data-save': recKey(c.id), onclick: () => outbox.flush(recKey(c.id)) }, st.text),
    h('button', { class: 'btn primary', style: { marginLeft: 'auto' }, onclick: () => saveNow(c) }, '저장하기')));
  el.append(head, body);
  return el;
}

function updateSaveBar(key) {
  const el = document.querySelector(`[data-save="${CSS.escape(key)}"]`);
  if (el) { const st = saveLabel(key); el.className = 'savest ' + st.cls; el.textContent = st.text; }
  if (key.startsWith('att:')) {
    const s = saveState.get(key);
    if (s && s.state === 'bad') toast('출석 저장이 실패했어요. 인터넷이 돌아오면 자동으로 다시 저장해요.', true);
  }
}

function saveNow(c) {
  outbox.put(recKey(c.id), '/api/record', recordBody(c), 0);
}

function recordBody(c) {
  const m = cards.get(c.id);
  return {
    date: S.date, class_id: c.id,
    tracks_on: m.on ? [...m.on] : undefined,
    student_tracks_on: Object.fromEntries(Object.entries(m.son).map(([k, v]) => [k, [...v]])),
    logs: Object.values(m.logs),
    students: c.students.map((s) => ({ id: s.id, hw: m.studs[s.id].hw, comment: m.studs[s.id].comment, tests: m.studs[s.id].tests || [] })),
  };
}
function dirty(c, delay = 2000) {
  outbox.put(recKey(c.id), '/api/record', recordBody(c), delay);
  const slot = $(`#cls-${c.id} .hwslot`);
  if (slot) slot.replaceChildren(hwSummary(c));
}

// ───────── 진도 칸 ─────────
function lessonsOf(curId) { return (D.lessons[curId] || []); }
function curOf(curId) { return D.curricula.find((x) => x.id === curId) || S.meta.curricula.find((x) => x.id === curId); }
function lessonAfter(curId, seq) {
  const L = lessonsOf(curId); const n = L.find((l) => l.seq > seq);
  if (n) return n; const cur = curOf(curId); return cur && cur.cycle && L.length ? L[0] : null;
}
function oneLine(s) { return String(s || '').replace(/\s*\n+\s*/g, ' / ').trim(); }
function todayText(l) { if (!l) return ''; const c = oneLine(l.content); return c ? `${l.title} · ${c}` : l.title || ''; }

// 반에 진도표가 여러 개일 때: 오늘 한 진도표 고르기 (요일 바꿈·둘 다·추가 학습)
const DOW1 = ['일', '월', '화', '수', '목', '금', '토'];
function tracksBlock(c, student) {
  const m = cards.get(c.id);
  const wrap = h('div', student ? { class: 'stu-tracks' } : null);
  const list = student ? student.tracks : c.tracks;
  const onSet = student ? m.son[student.id] : m.on;
  function paint() {
    const kids = [];
    const chip = (t) => {
      const dayTxt = t.free ? '' : t.days ? ` (${t.days.split(',').map((d) => DOW1[Number(d)]).join('·')})` : '';
      return h('button', { class: 'chip-btn' + (onSet.has(t.key) ? ' on' : ''), onclick: () => {
        if (onSet.has(t.key)) { onSet.delete(t.key); delete m.logs[t.target]; }
        else {
          onSet.add(t.key);
          const p = t.progress || {};
          m.logs[t.target] = { target: t.target, curriculum_id: p.curriculum_id ?? t.curriculum_id, lesson_id: p.lesson_id, seq: p.seq, today: p.today || '', next: p.next || '', homework: p.homework || '', repeat: p.repeat ? 1 : 0 };
        }
        dirty(c, 600); paint();
      } }, t.free ? '+ 추가 학습 (영자신문 등)' : `${t.name || '진도표'}${dayTxt}`);
    };
    kids.push(h('div', { class: 'track-pick' }, h('span', { class: 'small', style: { fontWeight: 650 } }, student ? `${student.name} 오늘 교재` : '오늘 수업'),
      ...list.filter((t) => t.free || t.curriculum_id || t.key === 'm').map(chip),
      student ? h('button', { class: 'chip-btn', onclick: () => addStudentBook(c, student) }, '+ 교재 추가') : null));
    const onTracks = list.filter((t) => onSet.has(t.key));
    if (!onTracks.length) kids.push(h('div', { class: 'note small mt-s' }, student ? '오늘 한 교재를 위에서 골라 주세요.' : '오늘 한 수업을 위에서 골라 주세요.'));
    for (const t of onTracks) kids.push(progBlock(c, t.target, t.progress, student, t));
    wrap.replaceChildren(...kids);
  }
  paint();
  return wrap;
}

function progBlock(c, target, prog, student, track) {
  const m = cards.get(c.id);
  const log = m.logs[target] || (m.logs[target] = { target, curriculum_id: null, lesson_id: null, seq: null, today: '', next: '', homework: '', repeat: 0 });
  const curId = log.curriculum_id;
  const L = lessonsOf(curId);
  const box = h('div', { class: student ? 'stu-prog' : 'prog' });

  const prev = prog && prog.prevHomework;
  const firstOn = !track || (student ? student.tracks.find((t) => cards.get(c.id).son[student.id].has(t.key)) : c.tracks.find((t) => cards.get(c.id).on.has(t.key))) === track;
  if (firstOn) {
    const pd = prog && prog.prevDate;
    if (prog && prog.prevToday) box.append(h('div', { class: 'lastx' }, `지난 수업${pd ? ` (${Number(pd.slice(5, 7))}/${Number(pd.slice(8, 10))})` : ''}: `, h('b', null, prog.prevToday)));
    box.append(h('div', { class: 'lastx' }, '지난 숙제: ', h('b', null, prev || '없음')));
  }

  const today = h('textarea', { class: 'input', rows: 2, value: log.today, placeholder: '오늘 할 일', oninput: () => { log.today = today.value; dirty(c); } });
  const next = h('input', { class: 'input', value: log.next, placeholder: '다음 수업', oninput: () => { log.next = next.value; dirty(c); } });
  const hw = h('textarea', { class: 'input', rows: 2, value: log.homework, placeholder: '오늘 숙제', oninput: () => { log.homework = hw.value; paintQb(); dirty(c); } });
  const repeat = h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!log.repeat, onchange: (e) => {
    log.repeat = e.target.checked ? 1 : 0;
    const cur = L.find((l) => l.id === log.lesson_id);
    if (cur) { log.next = log.repeat ? cur.title : (lessonAfter(curId, cur.seq) || {}).title || ''; next.value = log.next; }
    dirty(c);
  } }), '이번 차시 다시 (진도 못 나감)');

  const top = h('div', { class: 'prog-top' });
  if (student && track && track.free) {
    top.append(h('span', { class: 'chip line' }, '추가 학습 (직접 쓰기)'));
  } else if (student && track && track.key !== 'm') {
    const cur = curOf(curId);
    top.append(h('span', { class: 'chip line' }, cur ? cur.name : '교재'), h('button', { class: 'btn small ghost', onclick: () => removeStudentBook(c, student, track) }, '이 교재 빼기'));
  } else if (student) {
    const courseId = c.course_id || student.course_id;
    const opts = S.meta.curricula.filter((x) => !courseId || x.course_id === courseId || x.id === curId);
    top.append(h('select', { class: 'input', style: { flex: '1 1 160px' }, onchange: (e) => changeStudentCurriculum(c, student, Number(e.target.value) || null) },
      h('option', { value: '' }, '진도표 고르기'),
      opts.map((x) => h('option', { value: x.id, selected: x.id === curId }, x.name))));
  } else {
    const cur = curOf(curId);
    top.append(h('span', { class: 'chip line' }, track && track.free ? '추가 학습 (직접 쓰기)' : cur ? cur.name : '진도표 없음'));
  }
  if (L.length) {
    const sel = h('select', { class: 'input', onchange: () => {
      const l = L.find((x) => x.id === Number(sel.value)); if (!l) return;
      Object.assign(log, { lesson_id: l.id, seq: l.seq, today: todayText(l), homework: l.homework || '' });
      log.next = log.repeat ? l.title : ((lessonAfter(curId, l.seq) || {}).title || '');
      today.value = log.today; next.value = log.next; hw.value = log.homework; paintQb();
      dirty(c);
    } }, L.map((l) => h('option', { value: l.id, selected: l.id === log.lesson_id }, `${fmtSeq(l.seq)}. ${l.title}`)));
    if (!log.lesson_id) sel.prepend(h('option', { value: '', selected: true }, '차시 고르기'));
    top.append(sel);
  }
  box.append(top);
  if (prog && prog.ended) box.append(h('div', { class: 'note warn mt-s' }, '진도표의 마지막 차시까지 끝났어요. (순환이 꺼져 있어요)'));
  if (!curId && !student && !(track && track.free)) box.append(h('div', { class: 'note mt-s small' }, S.me.role === 'director' ? '관리 → 반에서 진도표를 지정하면 자동으로 채워져요. 지금은 직접 적어도 돼요.' : '원장님이 진도표를 지정하면 자동으로 채워져요. 지금은 직접 적어도 돼요.'));
  if (!(track && track.free)) box.append(h('div', { class: 'mt-s' }, repeat));

  const qb = h('div', { class: 'qb' });
  function tokens() { return String(log.homework || '').split(/\s*[,\n]\s*/).filter(Boolean); }
  function paintQb() { const t = tokens(); for (const b of qb.children) b.setAttribute('aria-pressed', String(t.includes(b.dataset.v))); }
  for (const name of S.meta.hw_buttons || []) {
    qb.append(h('button', { type: 'button', 'data-v': name, onclick: () => {
      let t = tokens();
      if (t.includes(name)) t = t.filter((x) => x !== name);
      else if (name === '숙제 없음') t = [name];
      else t = [...t.filter((x) => x !== '숙제 없음'), name];
      log.homework = t.join(', '); hw.value = log.homework; paintQb(); dirty(c);
    } }, name));
  }
  paintQb();
  box.append(h('div', { class: 'prog-grid mt-s' },
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, '오늘 할 일'), today),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, '다음 수업'), next),
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, '오늘 숙제'), hw, qb)));
  return box;
}
function fmtSeq(n) { return Number.isInteger(n) ? n : Number(n).toFixed(1).replace(/\.0$/, ''); }

async function changeStudentCurriculum(c, s, curId) {
  await outbox.flush(recKey(c.id));
  const L = curId ? (D.lessons[curId] || []) : [];
  await api('/api/student-curriculum', { student_id: s.id, curriculum_id: curId, start_seq: L.length ? L[0].seq : null, date: S.date });
  const m = cards.get(c.id); delete m.logs[s.target];
  const o = outbox.get(recKey(c.id)); if (o) outbox.flush(recKey(c.id));
  toast('진도표를 바꿨어요');
  load();
}

// ───────── 학생 개별 진도 ─────────
async function toggleSolo(c, s) {
  await outbox.flush(recKey(c.id));
  if (!s.solo) {
    // 처음 켜면: 반에서 하던 교재·차시에서 이어서 시작
    const p = c.progress || {};
    const body = { student_id: s.id, solo: true };
    if (!s.curriculum_id) Object.assign(body, { curriculum_id: p.curriculum_id || c.curriculum_id || null, start_seq: p.seq ?? null, date: S.date });
    await api('/api/student-curriculum', body);
    toast(`${s.name}: 개별 진도로 바꿨어요. 이제 이 학생만 다른 책·진도를 쓸 수 있어요.`);
  } else {
    await api('/api/student-curriculum', { student_id: s.id, solo: false });
    toast(`${s.name}: 반 진도로 돌아갔어요`);
  }
  load();
}
function addStudentBook(c, s) {
  sheet(`${s.name} · 교재 추가`, (close) => {
    const sel = h('select', { class: 'input' }, h('option', { value: '' }, '교재(진도표) 고르기'),
      S.meta.courses.map((co) => { const l = S.meta.curricula.filter((x) => x.course_id === co.id); return l.length ? h('optgroup', { label: co.name }, l.map((x) => h('option', { value: x.id }, x.name))) : null; }),
      (() => { const l = S.meta.curricula.filter((x) => !S.meta.courses.some((co) => co.id === x.course_id)); return l.length ? h('optgroup', { label: '과정 없음' }, l.map((x) => h('option', { value: x.id }, x.name))) : null; })());
    return h('div', { class: 'stack' },
      h('p', { class: 'small muted', style: { margin: 0 } }, '이 학생이 함께 나가는 교재를 더해요. 진도는 교재마다 따로 이어져요. 목록에 없는 교재는 먼저 진도표 탭에서 만들어 주세요.'),
      sel,
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn primary', onclick: async () => {
        if (!sel.value) return toast('교재를 골라 주세요', true);
        await outbox.flush(recKey(c.id));
        try { await api('/api/student-curriculum', { student_id: s.id, add_track: { curriculum_id: Number(sel.value) } }); close(); toast('교재를 더했어요'); load(); } catch (e) { toast(e.message, true); }
      } }, '더하기')));
  });
}
async function removeStudentBook(c, s, t) {
  if (!(await confirmBox(`${t.name || '이 교재'}를 뺄까요?`, '지난 수업 기록은 그대로 남아요. 나중에 다시 더하면 처음 차시부터 시작해요.', '빼기', true))) return;
  await outbox.flush(recKey(c.id));
  await api('/api/student-curriculum', { student_id: s.id, remove_track: t.key, date: S.date });
  toast('교재를 뺐어요'); load();
}

// ───────── 학생 줄 ─────────
function sendStatus(c, s) {
  const m = cards.get(c.id);
  const a = m.att[s.id];
  const msg = s.msg;
  if (msg && msg.status === 'sent') return h('span', { class: 'send-st ok', title: '학부모님께 보냄' }, `✓ 전송됨 ${hmOf(msg.sent_at)}`);
  if (msg && msg.status === 'failed') return h('span', { class: 'send-st bad', title: msg.error || '' }, '✕ 실패');
  if (a.reason || (msg && !msg.checked)) return h('span', { class: 'send-st no' }, '보내지 않음');
  return h('span', { class: 'send-st wait' }, '리포트 대기');
}

function studentRow(c, s) {
  const m = cards.get(c.id);
  const row = h('div', { class: 'stu', id: `stu-${s.id}` });
  const statusSlot = h('span', { class: 'st-slot' }, sendStatus(c, s));
  const alert = s.alert && s.alert.status === 'sent' ? h('span', { class: 'chip ok', title: '출결 즉시 알림' }, '출결 알림 ✓') : s.alert && s.alert.status === 'failed' ? h('span', { class: 'chip bad', title: s.alert.error }, '출결 알림 실패') : null;
  row.append(h('div', { class: 'stu-head' }, h('span', { class: 'stu-name' }, s.name), statusSlot, alert));

  const attBox = h('div', { class: 'pick g4' });
  const reasonSel = h('select', { 'aria-label': '사유', onchange: () => setAtt(c, s, undefined, reasonSel.value) },
    h('option', { value: '' }, '사유'), (S.meta.reasons || []).map((r) => h('option', { value: r }, r)));
  function paintAtt() {
    const a = m.att[s.id];
    for (const b of attBox.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === a.att));
    reasonSel.value = a.reason || ''; reasonSel.classList.toggle('on', !!a.reason);
    statusSlot.replaceChildren(sendStatus(c, s));
  }
  for (const [v, label, tone] of ATT) attBox.append(h('button', { class: tone, 'data-v': v, onclick: () => setAtt(c, s, m.att[s.id].att === v ? '' : v, undefined) }, label));
  attBox.append(reasonSel);
  row._paintAtt = paintAtt;

  const hwBox = h('div', { class: 'pick g4' });
  function paintHw() { for (const b of hwBox.children) b.setAttribute('aria-pressed', String(b.dataset.v === m.studs[s.id].hw)); }
  for (const [v, label, tone] of HW) hwBox.append(h('button', { class: tone, 'data-v': v, onclick: () => { m.studs[s.id].hw = m.studs[s.id].hw === v ? '' : v; paintHw(); dirty(c); } }, label));
  row._paintHw = paintHw;

  row.append(h('div', { class: 'stu-rows' }, h('span', { class: 'k' }, '출결'), attBox, h('span', { class: 'k' }, '숙제'), hwBox));
  row.append(testBlock(c, s));

  const comment = h('textarea', { class: 'input mt-s' + (m.studs[s.id].comment ? '' : ' hidden'), rows: 2, placeholder: '선생님 한마디 (필요할 때만)', value: m.studs[s.id].comment,
    oninput: () => { m.studs[s.id].comment = comment.value; dirty(c); } });
  const mediaBtn = h('button', { class: 'btn small', onclick: () => openMedia(s, S.date, galleryUrl(s), (n) => { s.media = n; mediaBtn.lastChild.textContent = n ? `사진·영상 ${n}` : '사진·영상'; linkBtn.classList.toggle('hidden', !n); }) },
    icon('cam'), h('span', null, s.media ? `사진·영상 ${s.media}` : '사진·영상'));
  const linkBtn = h('button', { class: 'btn small ghost' + (s.media ? '' : ' hidden'), onclick: () => copyText(galleryUrl(s)) }, icon('link'), '링크 복사');
  row.append(h('div', { class: 'stu-tools' },
    h('button', { class: 'btn small ghost', onclick: () => { comment.classList.toggle('hidden'); if (!comment.classList.contains('hidden')) comment.focus(); } }, icon('pen'), '선생님 한마디'),
    mediaBtn, linkBtn));
  row.append(comment);
  if (c.type !== 'individual') {
    row.querySelector('.stu-tools').append(h('button', { class: 'btn small ghost', onclick: () => toggleSolo(c, s) }, s.solo ? '반 진도로 돌아가기' : '개별 진도·교재'));
  }
  if (s.solo && s.tracks) row.append(tracksBlock(c, s));
  paintAtt(); paintHw();
  return row;
}
// ───────── 시험 (Voca · Weekly · Monthly) ─────────
function testBlock(c, s) {
  const m = cards.get(c.id);
  const st = m.studs[s.id];
  if (!st.tests) st.tests = [];
  const kinds = (S.meta.tests && S.meta.tests.kinds) || ['Voca', 'Weekly', 'Monthly'];
  const pass = Number((S.meta.tests && S.meta.tests.pass) ?? 80);
  const wrap = h('div', { class: 'tests' });
  const totalKey = (kind) => `cm_total:${c.id}:${kind}`;
  function autoResult(t) {
    if (t.manual) return;
    const cor = Number(t.correct), tot = Number(t.total);
    if (t.correct === '' || t.total === '' || !tot) return;
    t.result = (cor / tot) * 100 >= pass ? 'good' : 'retest';
  }
  function paint() {
    const kindBtns = h('div', { class: 'test-kinds' }, kinds.map((k) => {
      const on = st.tests.some((t) => t.kind === k);
      return h('label', { class: 'test-check' + (on ? ' on' : '') }, h('input', { type: 'checkbox', checked: on, onchange: () => {
        if (on) st.tests = st.tests.filter((t) => t.kind !== k);
        else { let tot = ''; try { tot = localStorage.getItem(totalKey(k)) || ''; } catch { /* */ } st.tests.push({ kind: k, correct: '', total: tot, result: '', manual: false }); }
        paint(); dirty(c);
        if (!on) { const inp = wrap.querySelector(`[data-kind="${CSS.escape(k)}"] input`); if (inp) inp.focus(); }
      } }), k);
    }));
    const rows = st.tests.map((t) => {
      const pct = h('span', { class: 'tiny muted test-pct' });
      const resBox = h('div', { class: 'pick test-res' });
      const paintRes = () => {
        const tot = Number(t.total);
        pct.textContent = t.correct !== '' && tot ? `${Math.round((Number(t.correct) / tot) * 100)}%` : '';
        resBox.replaceChildren(...[['good', '좋음', 'ok'], ['retest', '재시험', 'bad']].map(([v, l, tone]) => h('button', { class: tone, 'aria-pressed': String(t.result === v), onclick: () => {
          t.result = t.result === v ? '' : v; t.manual = true; paintRes(); dirty(c);
        } }, l)));
      };
      const num = (key, ph) => h('input', { class: 'input test-num', inputmode: 'decimal', placeholder: ph, value: t[key] === '' || t[key] == null ? '' : String(t[key]), oninput: (e) => {
        t[key] = e.target.value.replace(/[^0-9.]/g, '');
        if (key === 'total' && t.total) { try { localStorage.setItem(totalKey(t.kind), t.total); } catch { /* */ } }
        autoResult(t); paintRes(); dirty(c);
      } });
      paintRes();
      return h('div', { class: 'test-row', 'data-kind': t.kind },
        h('b', { class: 'test-kind' }, t.kind),
        h('label', { class: 'test-field' }, h('span', { class: 'tiny muted' }, '맞은 수'), num('correct', '0')),
        h('span', { class: 'test-slash' }, '/'),
        h('label', { class: 'test-field' }, h('span', { class: 'tiny muted' }, '문항 수'), num('total', '0')),
        pct, resBox);
    });
    wrap.replaceChildren(
      h('div', { class: 'test-head' }, h('b', null, '시험'), h('span', { class: 'muted small' }, '(맞은 수/문항 수)'), h('span', { class: 'tiny muted' }, '· 본 시험에 체크하고 점수를 적어 주세요')),
      kindBtns, ...rows);
  }
  paint();
  return wrap;
}

function galleryUrl(s) { return `${location.origin}/g/${s.code}`; }

function setAtt(c, s, att, reason) {
  const m = cards.get(c.id);
  const a = m.att[s.id];
  if (att !== undefined) a.att = att;
  if (reason !== undefined) a.reason = reason;
  outbox.put(attKey(s.id), '/api/attendance', { date: S.date, student_id: s.id, att: a.att, reason: a.reason }, 0);
  const row = $(`#stu-${s.id}`); if (row && row._paintAtt) row._paintAtt();
  renderBoard();
}

function allPresent(c) {
  const m = cards.get(c.id);
  let n = 0;
  for (const s of c.students) {
    const a = m.att[s.id];
    if (a.att || a.reason) continue; // 아직 체크 안 한 학생만
    setAtt(c, s, 'present', undefined); n++;
  }
  toast(n ? `${n}명 출석 처리했어요` : '이미 모두 체크되어 있어요');
}
function allHwDone(c) {
  const m = cards.get(c.id);
  for (const s of c.students) {
    if (m.att[s.id].att === 'absent') continue;
    m.studs[s.id].hw = 'done';
    const row = $(`#stu-${s.id}`); if (row && row._paintHw) row._paintHw();
  }
  dirty(c, 600);
}

// ───────── 다른 선생님이 입력한 내용 반영 (20초마다) ─────────
async function softRefresh() {
  if (S.view !== 'today') return;
  let fresh;
  try { fresh = await api(`/api/today?date=${S.date}${S.allDays ? '&all=1' : ''}`); } catch { return; }
  if (fresh.classes.length !== D.classes.length || fresh.classes.some((c, i) => c.id !== D.classes[i].id)) {
    if (!document.activeElement || !root.contains(document.activeElement) || document.activeElement === document.body) { D = fresh; cards.clear(); for (const c of D.classes) cards.set(c.id, makeModel(c)); renderAll(); }
    return;
  }
  D.lessons = fresh.lessons; D.curricula = fresh.curricula;
  fresh.classes.forEach((fc, i) => {
    const el = $(`#cls-${fc.id}`);
    const busy = outbox.get(recKey(fc.id)) || (el && el.contains(document.activeElement)) || fc.students.some((s) => outbox.get(attKey(s.id)));
    D.classes[i] = fc;
    if (busy) {
      // 입력 중인 반은 전송 상태만 바꾸기
      for (const s of fc.students) { const slot = $(`#stu-${s.id} .st-slot`); if (slot) slot.replaceChildren(sendStatus(fc, s)); }
      return;
    }
    cards.set(fc.id, makeModel(fc));
    if (el) el.replaceWith(classCard(fc));
  });
  renderBoard();
}

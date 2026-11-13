// 진도표: 교재·레벨별 차시 목록 (엑셀 올리기 · 붙여넣기 · 직접 고치기)

import { h, api, icon, toast, sheet, outbox, saveLabel, confirmBox } from './core.js';
import { S, courseTabs } from './state.js';
import { parseDelimited, readTableFile, mapCurriculum } from './parse.js';

const isDir = () => S.me.role === 'director';
const fmt = (n) => (n == null ? '' : Number.isInteger(n) ? String(n) : String(+Number(n).toFixed(2)));

async function refreshMeta() { S.meta = await api('/api/meta'); }

export async function renderCurricula(main, openId) {
  if (openId) return renderDetail(main, openId);
  await refreshMeta();
  const tabs = h('div');
  const box = h('div');
  main.replaceChildren(h('div', { class: 'toolbar' },
    h('div', { class: 'small muted grow' }, '교재·레벨별 진도표예요. 반(그룹수업)이나 학생(개별수업)에 지정하면 오늘 수업 화면이 자동으로 채워져요.'),
    isDir() ? h('button', { class: 'btn primary', onclick: () => openImport(null, () => renderCurricula(main)) }, icon('plus'), '새 진도표') : null), tabs, box);
  const draw = () => {
    const counts = { all: S.meta.curricula.length };
    for (const c of S.meta.curricula) counts[String(c.course_id)] = (counts[String(c.course_id)] || 0) + 1;
    tabs.replaceChildren(courseTabs(h, draw, counts));
    const list = S.meta.curricula.filter((c) => S.course === 'all' || String(c.course_id) === S.course);
    if (!list.length) {
      box.replaceChildren(h('div', { class: 'card empty' }, h('b', null, '아직 진도표가 없어요'),
        isDir() ? '"새 진도표"를 눌러 엑셀 파일을 올리거나 엑셀에서 복사해 붙여 넣어 주세요.' : '원장님이 진도표를 올리면 여기에 보여요.'));
      return;
    }
    const courseName = (id) => (S.meta.courses.find((c) => c.id === id) || {}).name || '과정 없음';
    box.replaceChildren(h('div', { class: 'card' }, list.map((c) => h('div', { class: 'list-item', onclick: () => renderDetail(main, c.id) },
      h('div', { class: 'grow' }, h('div', { style: { fontWeight: 700 } }, c.name),
        h('div', { class: 'small muted' }, `${courseName(c.course_id)} · ${c.lessons}차시${c.lessons ? ` (${fmt(c.first_seq)}~${fmt(c.last_seq)})` : ''}`)),
      h('span', { class: 'chip ' + (c.cycle ? 'ok' : '') }, c.cycle ? '순환 켜짐' : '순환 꺼짐'), icon('right')))));
  };
  draw();
}

async function renderDetail(main, id) {
  main.replaceChildren(h('div', { class: 'empty' }, '불러오는 중…'));
  let d;
  try { d = await api(`/api/lessons?curriculum_id=${id}`); } catch (e) { main.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
  const cur = d.curriculum;
  const back = h('button', { class: 'btn small ghost', onclick: async () => { await outbox.flushAll(); renderCurricula(main); } }, icon('left'), '진도표 목록');
  const head = h('section', { class: 'card card-pad' });
  if (isDir()) {
    const save = () => outbox.put(`cur:${id}`, '/api/admin/curriculum', { id, name: name.value, course_id: Number(course.value) || null, cycle: cycle.checked }, 800);
    const name = h('input', { class: 'input', value: cur.name, oninput: save });
    const course = h('select', { class: 'input', onchange: save }, h('option', { value: '' }, '과정 고르기'), S.meta.courses.map((c) => h('option', { value: c.id, selected: c.id === cur.course_id }, c.name)));
    const cycle = h('input', { type: 'checkbox', checked: !!cur.cycle, onchange: save });
    head.append(h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, '진도표 이름'), name),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, '과정'), course)),
    h('div', { class: 'row mt' }, h('label', { class: 'switch' }, cycle, '순환 — 마지막 차시가 끝나면 1차시부터 다시'),
      h('span', { class: 'savest small', 'data-save': `cur:${id}`, style: { marginLeft: 'auto' } })));
  } else {
    head.append(h('h3', null, cur.name), h('div', { class: 'small muted' }, cur.cycle ? '순환 켜짐' : '순환 꺼짐'));
  }
  head.append(h('div', { class: 'small muted mt-s' }, d.used.length ? `쓰는 곳: ${d.used.map((u) => (u.t === 'class' ? u.name + '(반)' : u.name)).join(', ')}` : '아직 이 진도표를 쓰는 반·학생이 없어요.'));

  const tools = isDir() ? h('div', { class: 'row mt' },
    h('button', { class: 'btn', onclick: () => openImport(cur, () => renderDetail(main, id)) }, '엑셀·붙여넣기로 불러오기'),
    h('button', { class: 'btn', onclick: async () => {
      const last = d.lessons[d.lessons.length - 1];
      await api('/api/admin/lesson', { curriculum_id: id, seq: last ? Math.floor(last.seq) + 1 : 1, title: '', content: '', homework: '' });
      renderDetail(main, id).then(() => window.scrollTo(0, document.body.scrollHeight));
    } }, icon('plus'), '차시 추가'),
    h('button', { class: 'btn danger', style: { marginLeft: 'auto' }, onclick: async () => {
      if (!(await confirmBox('진도표를 지울까요?', '지난 수업 기록은 그대로 남아요. 이 진도표를 쓰던 반·학생은 진도표를 다시 지정해 주세요.', '지우기', true))) return;
      await api('/api/admin/curriculum', { id, delete: true }); toast('지웠어요'); renderCurricula(main);
    } }, '진도표 지우기')) : null;

  const rows = d.lessons.map((l) => {
    if (!isDir()) return h('tr', null, h('td', { class: 'num' }, fmt(l.seq)), h('td', null, h('b', null, l.title)), h('td', { class: 'small', style: { whiteSpace: 'pre-line' } }, l.content), h('td', { class: 'small', style: { whiteSpace: 'pre-line' } }, l.homework));
    const key = `les:${l.id}`;
    const save = () => outbox.put(key, '/api/admin/lesson', { id: l.id, curriculum_id: id, seq: seq.value, title: title.value, content: content.value, homework: hw.value }, 1000);
    const seq = h('input', { class: 'input', value: fmt(l.seq), style: { width: '64px', textAlign: 'center' }, inputmode: 'decimal', oninput: save });
    const title = h('input', { class: 'input', value: l.title, oninput: save });
    const content = h('textarea', { class: 'input', rows: 2, value: l.content, oninput: save });
    const hw = h('textarea', { class: 'input', rows: 2, value: l.homework, oninput: save });
    const tr = h('tr', null, h('td', null, seq), h('td', null, title), h('td', null, content), h('td', null, hw),
      h('td', null, h('button', { class: 'icon-btn', 'aria-label': '차시 지우기', onclick: async () => {
        if (!(await confirmBox('이 차시를 지울까요?', `${fmt(l.seq)}. ${l.title}`, '지우기', true))) return;
        await api('/api/admin/lesson', { id: l.id, delete: true }); tr.remove();
      } }, icon('trash'))));
    return tr;
  });
  const table = h('section', { class: 'card mt' }, h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, h('th', null, '순서'), h('th', null, '차시 이름'), h('th', null, '수업 내용'), h('th', null, '숙제'), isDir() ? h('th', null, '') : null)),
    h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 5, class: 'muted' }, '차시가 없어요. "엑셀·붙여넣기로 불러오기"를 눌러 주세요.'))))),
  isDir() ? h('div', { class: 'tiny muted', style: { padding: '8px 14px 12px' } }, '칸을 고치면 1초 뒤 자동 저장돼요. 순서 번호는 1부터가 아니어도, 건너뛰어도 괜찮아요 (작은 번호부터 차례로 진행).') : null);
  main.replaceChildren(h('div', { class: 'toolbar' }, back), head, tools, table);
  const off = outbox.on((key) => { const el = document.querySelector(`[data-save="${CSS.escape(key)}"]`); if (el) { const s = saveLabel(key); el.className = 'savest small ' + s.cls; el.textContent = s.text; } });
  S.stopPoll = () => off();
}

/** 엑셀 파일 올리기 / 붙여 넣기 → 저장 전에 읽은 차시 목록 보여 주기 */
export function openImport(cur, done) {
  sheet(cur ? `${cur.name} 불러오기` : '새 진도표 만들기', (close) => {
    let parsed = { lessons: [], columns: {} };
    const name = h('input', { class: 'input', placeholder: '예: Reading Lv.2 (교재·레벨 이름)' });
    const course = h('select', { class: 'input' }, h('option', { value: '' }, '과정 고르기'),
      S.meta.courses.map((c) => h('option', { value: c.id, selected: S.course !== 'all' && String(c.id) === S.course }, c.name)));
    const cycle = h('input', { type: 'checkbox', checked: true });
    let mode = 'replace';
    const paste = h('textarea', { class: 'input', rows: 5, placeholder: '엑셀에서 표를 (제목줄 포함) 복사해서 여기에 붙여 넣으세요.\n예) 주차 | 단원 | 수업 내용 | 숙제', oninput: () => { parsed = mapCurriculum(parseDelimited(paste.value)); preview(); } });
    const file = h('input', { type: 'file', accept: '.xlsx,.xlsm,.csv,.txt,.xls', class: 'hidden', onchange: async () => {
      const f = file.files[0]; if (!f) return;
      try {
        const r = await readTableFile(f);
        if (!r.rows) throw new Error('진도표는 엑셀이나 CSV 파일로 올려 주세요.');
        parsed = mapCurriculum(r.rows);
        if (!cur && !name.value) name.value = f.name.replace(/\.\w+$/, '');
        preview();
      } catch (e) { toast(e.message, true); }
      file.value = '';
    } });
    const out = h('div');
    const saveBtn = h('button', { class: 'btn primary', disabled: true, onclick: save }, '저장하기');
    const LABEL = { seq: '순서', title: '차시 이름', content: '수업 내용', homework: '숙제' };
    function preview() {
      const L = parsed.lessons;
      saveBtn.disabled = !L.length;
      if (!L.length) { out.replaceChildren(h('div', { class: 'note warn' }, '읽은 차시가 없어요. 제목줄(주차/단원/내용/숙제 등)과 함께 붙여 넣어 주세요.')); return; }
      const colChips = Object.entries(parsed.columns).sort((a, b) => a[1] - b[1]).map(([k, i]) => h('span', { class: 'chip' }, `${String.fromCharCode(65 + i)}열 → ${LABEL[k]}`));
      out.replaceChildren(
        h('div', { class: 'note ok' }, h('b', null, `${L.length}개 차시를 읽었어요.`), ' 아래 목록이 맞는지 확인하고 저장해 주세요.'),
        h('div', { class: 'fields-check' }, colChips),
        h('div', { class: 'card mt-s', style: { maxHeight: '320px', overflow: 'auto' } }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', null, '순서'), h('th', null, '차시 이름'), h('th', null, '수업 내용'), h('th', null, '숙제'))),
          h('tbody', null, L.map((l) => h('tr', null, h('td', { class: 'num' }, fmt(l.seq)), h('td', null, l.title), h('td', { class: 'small', style: { whiteSpace: 'pre-line' } }, l.content), h('td', { class: 'small', style: { whiteSpace: 'pre-line' } }, l.homework)))))));
    }
    async function save() {
      if (!cur && !name.value.trim()) { toast('진도표 이름을 적어 주세요', true); name.focus(); return; }
      saveBtn.disabled = true;
      try {
        const r = await api('/api/admin/curriculum/import', { curriculum_id: cur ? cur.id : null, name: name.value.trim(), course_id: Number(course.value) || null, cycle: cycle.checked, mode, lessons: parsed.lessons });
        toast(`${r.count}개 차시를 저장했어요`); close(); done && done(r.id);
      } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
    }
    return h('div', { class: 'stack' },
      cur ? h('div', { class: 'seg' }, [['replace', '전체 바꾸기'], ['append', '뒤에 이어 붙이기']].map(([v, l]) => h('button', { 'aria-pressed': String(mode === v), onclick: (e) => { mode = v; for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); } }, l)))
        : h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', { class: 'lbl' }, '진도표 이름'), name), h('label', { class: 'field' }, h('span', { class: 'lbl' }, '과정'), course)),
      !cur ? h('label', { class: 'switch' }, cycle, '순환 (마지막 차시 뒤에 1차시부터 다시)') : null,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => file.click() }, '엑셀 파일 올리기'), h('span', { class: 'small muted' }, '또는 아래에 붙여 넣기'), file),
      paste, out, h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn', onclick: close }, '취소'), saveBtn));
  });
}

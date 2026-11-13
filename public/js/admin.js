// 관리 (원장님): 학원 · 선생님 · 과정 · 반 · 학생 · 문구 · 발송 방식 · 일정

import { h, $, api, icon, toast, sheet, outbox, saveLabel, saveState, confirmBox, copyText, debounce, kstToday, addDays, DOW_KO } from './core.js';
import { S } from './state.js';
import { parseDelimited, readTableFile, mapStudents, studentsFromPdf } from './parse.js';
import { refreshTitle } from './main.js';

let A = null; // 관리 데이터
const SECTIONS = [['aca', '학원'], ['teachers', '선생님'], ['courses', '과정'], ['classes', '반'], ['students', '학생'], ['hw', '숙제 버튼'], ['tpl', '메시지 문구'], ['cushion', '쿠션 멘트'], ['send', '발송 방식'], ['schedule', '발송 일정'], ['att', '출결 알림'], ['media', '사진·영상'], ['export', '기록 내려받기']];

function setSetting(key, value, delay = 800) {
  A.settings[key] = value;
  outbox.put(`set:${key}`, '/api/admin/settings', { key, value }, delay);
}
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input, hint ? h('div', { class: 'tiny muted', style: { marginTop: '4px' } }, hint) : null);
const section = (id, title, ...kids) => h('section', { class: 'card card-pad', id: `sec-${id}`, style: { scrollMarginTop: '120px' } }, h('div', { class: 'row', style: { marginBottom: '12px' } }, h('h3', null, title), h('span', { class: 'savest small', style: { marginLeft: 'auto' }, 'data-sec': id })), ...kids);

export async function renderAdmin(main) {
  main.replaceChildren(h('div', { class: 'empty' }, '불러오는 중…'));
  try { A = await api('/api/admin'); S.meta = await api('/api/meta'); } catch (e) { main.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
  const nav = h('div', { class: 'admin-nav' }, SECTIONS.map(([id, l]) => h('button', { class: 'tab', onclick: () => $(`#sec-${id}`).scrollIntoView({ behavior: 'smooth' }) }, l)));
  main.replaceChildren(nav,
    h('div', { class: 'stack' }, secAcademy(), secTeachers(), secCourses(), secClasses(), secStudents(), secHw(), secTemplates(), secCushions(), secSend(), secSchedule(), secAtt(), secMedia(), secExport()));
  const off = outbox.on((key) => {
    if (!key.startsWith('set:')) return;
    const st = saveState.get(key);
    if (st && st.state === 'ok' && st.res && st.res.warnings && st.res.warnings.length) toast(st.res.warnings[0], true);
    const lab = saveLabel(key);
    for (const el of document.querySelectorAll('[data-sec]')) if (el.dataset.watch && el.dataset.watch.split(',').includes(key)) { el.className = 'savest small ' + lab.cls; el.textContent = lab.cls ? lab.text : ''; }
  });
  S.stopPoll = () => off();
  const watch = { aca: 'set:academy,set:director_phone', hw: 'set:hw_buttons,set:reasons', tpl: 'set:sms_templates', cushion: 'set:cushions', send: 'set:kakao', schedule: 'set:schedule', att: 'set:att_alerts,set:sms_templates' };
  for (const [id, keys] of Object.entries(watch)) { const el = document.querySelector(`[data-sec="${id}"]`); if (el) el.dataset.watch = keys; }
  if (location.hash.includes('admin') && !A.settings.academy) $('#sec-aca input')?.focus();
}

// ───────── 학원 ─────────
function secAcademy() {
  const name = h('input', { class: 'input', value: A.settings.academy || '', placeholder: '예: 파머스어학원 진영캠퍼스', oninput: () => { setSetting('academy', name.value.trim()); S.meta.academy = name.value.trim(); refreshTitle(); } });
  const phone = h('input', { class: 'input', value: A.settings.director_phone || '', inputmode: 'tel', placeholder: '010-0000-0000', oninput: () => setSetting('director_phone', phone.value.trim()) });
  return section('aca', '학원 정보',
    !A.settings.academy ? h('div', { class: 'note warn', style: { marginBottom: '12px' } }, '먼저 학원 이름부터 정해 주세요. 학부모 메시지의 {학원} 자리에 들어가요.') : null,
    h('div', { class: 'grid2' }, field('학원 이름', name, '메시지 맨 앞 [학원 이름]에 들어가요'), field('원장님 휴대폰', phone, '"나에게 테스트 문자"를 받을 번호예요')),
    h('div', { class: 'row mt' },
      h('span', { class: 'small muted grow' }, '앱 주소: ', h('code', null, A.settings.base_url || location.origin)),
      h('button', { class: 'btn small', onclick: changeDirectorPw }, '원장 비밀번호 바꾸기')));
}
function changeDirectorPw() {
  sheet('원장 비밀번호 바꾸기', (close) => {
    const p1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '새 비밀번호 (4자 이상)' });
    const p2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '한 번 더' });
    return h('div', { class: 'stack' }, p1, p2, h('button', { class: 'btn primary block', onclick: async () => {
      if (p1.value !== p2.value) return toast('두 비밀번호가 달라요', true);
      try { await api('/api/admin/director-password', { password: p1.value }); toast('바꿨어요'); close(); } catch (e) { toast(e.message, true); }
    } }, '바꾸기'));
  });
}

// ───────── 선생님 ─────────
function secTeachers() {
  const list = h('div');
  const draw = () => list.replaceChildren(...(A.teachers.filter((t) => t.active).length ? A.teachers.filter((t) => t.active).map((t) => h('div', { class: 'row', style: { padding: '8px 0', borderBottom: '1px solid var(--line)' } },
    h('b', { class: 'grow' }, t.name), t.has_pw ? null : h('span', { class: 'chip warn' }, '비밀번호 없음'),
    h('span', { class: 'small muted' }, `${A.classes.filter((c) => c.teacher_id === t.id).length}개 반`),
    h('button', { class: 'btn small', onclick: () => editTeacher(t, draw) }, '이름·비밀번호'),
    h('button', { class: 'btn small ghost danger', onclick: async () => {
      if (!(await confirmBox(`${t.name} 선생님을 내보낼까요?`, '더 이상 로그인할 수 없게 돼요. 지난 기록은 그대로 남아요.', '내보내기', true))) return;
      await api('/api/admin/teacher', { id: t.id, delete: true }); t.active = 0; draw(); toast('내보냈어요');
    } }, '내보내기'))) : [h('div', { class: 'muted small' }, '아직 등록된 선생님이 없어요.')]));
  draw();
  const name = h('input', { class: 'input', placeholder: '선생님 이름' });
  const pw = h('input', { class: 'input', type: 'password', placeholder: '비밀번호 (4자 이상)', autocomplete: 'new-password' });
  return section('teachers', '선생님',
    h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, '선생님마다 비밀번호를 정해서 알려 주세요. 로그인 화면에서 이름을 고르고 비밀번호를 넣으면 자기 반만 보여요.'),
    list,
    h('div', { class: 'grid3 mt' }, name, pw, h('button', { class: 'btn primary', onclick: async () => {
      try {
        const r = await api('/api/admin/teacher', { name: name.value, password: pw.value });
        A.teachers.push({ id: r.id, name: name.value.trim(), active: 1, has_pw: pw.value ? 1 : 0 }); name.value = ''; pw.value = ''; draw(); toast('추가했어요');
      } catch (e) { toast(e.message, true); }
    } }, icon('plus'), '선생님 추가')));
}
function editTeacher(t, draw) {
  sheet(`${t.name} 선생님`, (close) => {
    const name = h('input', { class: 'input', value: t.name });
    const pw = h('input', { class: 'input', type: 'password', placeholder: '새 비밀번호 (바꿀 때만)', autocomplete: 'new-password' });
    return h('div', { class: 'stack' }, field('이름', name), field('비밀번호', pw, '바꾸면 그 선생님은 다시 로그인해야 해요'),
      h('button', { class: 'btn primary block', onclick: async () => {
        try { await api('/api/admin/teacher', { id: t.id, name: name.value, password: pw.value || undefined }); t.name = name.value.trim(); if (pw.value) t.has_pw = 1; draw(); toast('저장했어요'); close(); }
        catch (e) { toast(e.message, true); }
      } }, '저장하기'));
  });
}

// ───────── 과정 ─────────
function secCourses() {
  const list = h('div', { class: 'stack' });
  const draw = () => list.replaceChildren(...S.meta.courses.map((c) => {
    const inp = h('input', { class: 'input', value: c.name, oninput: () => { c.name = inp.value; outbox.put(`course:${c.id}`, '/api/admin/course', { id: c.id, name: inp.value }, 800); } });
    return h('div', { class: 'row nowrap' }, inp, h('button', { class: 'icon-btn', 'aria-label': '과정 지우기', onclick: async () => {
      if (!(await confirmBox(`"${c.name}" 과정을 지울까요?`, '반·진도표는 그대로 남고, 과정 탭에서만 빠져요.', '지우기', true))) return;
      await api('/api/admin/course', { id: c.id, delete: true }); S.meta.courses = S.meta.courses.filter((x) => x.id !== c.id); draw();
    } }, icon('trash')));
  }));
  draw();
  const add = h('input', { class: 'input', placeholder: '새 과정 이름 (예: 중등 문법)' });
  return section('courses', '과정 (탭)',
    h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, '오늘 수업 화면과 진도표 목록이 이 과정 탭으로 나뉘어 보여요. 이름을 바꾸면 자동 저장돼요.'),
    list, h('div', { class: 'row nowrap mt' }, add, h('button', { class: 'btn', onclick: async () => {
      try { const r = await api('/api/admin/course', { name: add.value }); S.meta.courses.push({ id: r.id, name: add.value.trim() }); add.value = ''; draw(); } catch (e) { toast(e.message, true); }
    } }, icon('plus'), '추가')));
}

// ───────── 반 ─────────
const daysLabel = (days) => { const d = String(days || '').split(',').filter(Boolean).map(Number); if (d.join() === '1,2,3,4,5') return '월~금'; return d.map((x) => DOW_KO[x]).join('·') || '요일 없음'; };
function secClasses() {
  const list = h('div', { class: 'card', style: { boxShadow: 'none' } });
  const draw = () => {
    const tName = (id) => (A.teachers.find((t) => t.id === id) || {}).name;
    const cName = (id) => (S.meta.curricula.find((c) => c.id === id) || {}).name;
    const coName = (id) => (S.meta.courses.find((c) => c.id === id) || {}).name;
    list.replaceChildren(...(A.classes.length ? A.classes.map((c) => h('div', { class: 'list-item', onclick: () => editClass(c, draw) },
      h('div', { class: 'grow' }, h('b', null, c.name),
        h('div', { class: 'small muted' }, [c.type === 'individual' ? '개별수업' : '그룹수업', daysLabel(c.days), c.time, c.room, tName(c.teacher_id) || '선생님 미지정'].filter(Boolean).join(' · ')),
        h('div', { class: 'small muted' }, [coName(c.course_id) || '과정 미지정', c.type === 'individual' ? '진도표는 학생마다' : (cName(c.curriculum_id) ? `${cName(c.curriculum_id)}${c.start_seq != null ? ` (${c.start_seq}차시부터)` : ''}` : '진도표 미지정')].join(' · '))),
      h('span', { class: 'small muted' }, `${A.students.filter((s) => s.class_id === c.id).length}명`), icon('right'))) : [h('div', { class: 'empty' }, '아직 반이 없어요')]));
  };
  draw();
  return section('classes', '반', list, h('button', { class: 'btn mt', onclick: () => editClass(null, draw) }, icon('plus'), '반 추가'));
}

async function lessonOptions(curId) {
  if (!curId) return [];
  try { return (await api(`/api/lessons?curriculum_id=${curId}`)).lessons; } catch { return []; }
}

function curriculumPicker(courseSel, curId, startSeq) {
  const cur = h('select', { class: 'input' });
  const start = h('select', { class: 'input' });
  async function fillCur() {
    const cid = Number(courseSel.value) || null;
    const list = S.meta.curricula.filter((c) => !cid || c.course_id === cid || c.id === curId);
    cur.replaceChildren(h('option', { value: '' }, list.length ? '진도표 고르기' : '이 과정에 진도표가 없어요'), ...list.map((c) => h('option', { value: c.id, selected: c.id === curId }, c.name)));
    await fillStart();
  }
  async function fillStart() {
    const L = await lessonOptions(Number(cur.value) || null);
    start.replaceChildren(h('option', { value: '' }, L.length ? '첫 차시부터' : '-'), ...L.map((l) => h('option', { value: l.seq, selected: startSeq != null && Number(startSeq) === l.seq }, `${l.seq}. ${l.title}`)));
  }
  courseSel.addEventListener('change', () => { curId = null; fillCur(); });
  cur.addEventListener('change', () => { startSeq = null; fillStart(); });
  fillCur();
  return { cur, start };
}

function editClass(c, draw) {
  const isNew = !c;
  c = c || { name: '', type: 'group', days: '1,2,3,4,5', time: '', room: '', teacher_id: null, course_id: S.course !== 'all' ? Number(S.course) : null, curriculum_id: null, start_seq: null };
  sheet(isNew ? '반 추가' : (/반$/.test(c.name) ? c.name : `${c.name} 반`), (close) => {
    let type = c.type;
    const days = new Set(String(c.days || '').split(',').filter(Boolean));
    const name = h('input', { class: 'input', value: c.name, placeholder: '예: 리딩 A반' });
    const typeSeg = h('div', { class: 'seg' }, [['group', '그룹수업'], ['individual', '개별수업']].map(([v, l]) => h('button', { 'aria-pressed': String(type === v), onclick: (e) => { type = v; for (const b of typeSeg.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); curBox.classList.toggle('hidden', type === 'individual'); indNote.classList.toggle('hidden', type !== 'individual'); } }, l)));
    const dayBox = h('div', { class: 'pick' }, [1, 2, 3, 4, 5, 6, 0].map((d) => h('button', { class: 'ok', 'aria-pressed': String(days.has(String(d))), style: { minWidth: '44px' }, onclick: (e) => { days.has(String(d)) ? days.delete(String(d)) : days.add(String(d)); e.currentTarget.setAttribute('aria-pressed', String(days.has(String(d)))); } }, DOW_KO[d])));
    const time = h('input', { class: 'input', value: c.time || '', placeholder: '예: 16:00' });
    const rooms = [...new Set(A.classes.map((x) => x.room).filter(Boolean))];
    const room = h('input', { class: 'input', value: c.room || '', placeholder: '예: 1관', list: 'rooms-dl' });
    const dl = h('datalist', { id: 'rooms-dl' }, rooms.map((r) => h('option', { value: r })));
    const teacher = h('select', { class: 'input' }, h('option', { value: '' }, '선생님 고르기'), A.teachers.filter((t) => t.active).map((t) => h('option', { value: t.id, selected: t.id === c.teacher_id }, t.name)));
    const course = h('select', { class: 'input' }, h('option', { value: '' }, '과정 고르기'), S.meta.courses.map((x) => h('option', { value: x.id, selected: x.id === c.course_id }, x.name)));
    const picker = curriculumPicker(course, c.curriculum_id, c.start_seq);
    const curBox = h('div', { class: 'grid2' + (type === 'individual' ? ' hidden' : '') }, field('진도표 (과정을 먼저 고르세요)', picker.cur), field('몇 차시부터 시작', picker.start));
    const indNote = h('div', { class: 'note small' + (type === 'individual' ? '' : ' hidden') }, '개별수업은 학생마다 진도표를 따로 지정해요 (학생 설정이나 오늘 수업 화면에서).');
    return h('div', { class: 'stack' },
      field('반 이름', name), typeSeg,
      field('수업 요일', dayBox),
      h('div', { class: 'grid3' }, field('수업 시간', time), field('교실', room), field('담당 선생님', teacher)), dl,
      field('과정', course), curBox, indNote,
      h('div', { class: 'row mt' },
        !isNew ? h('button', { class: 'btn ghost danger', onclick: async () => {
          if (!(await confirmBox(`${c.name} 반을 지울까요?`, '지난 수업 기록은 그대로 남아요. 이 반 학생들은 다른 반으로 옮겨 주세요.', '지우기', true))) return;
          await api('/api/admin/class', { id: c.id, delete: true }); A.classes = A.classes.filter((x) => x.id !== c.id); draw(); close();
        } }, '반 지우기') : null,
        h('button', { class: 'btn primary', style: { marginLeft: 'auto' }, onclick: async () => {
          const body = { id: c.id, name: name.value, type, days: [...days].sort().join(','), time: time.value, room: room.value, teacher_id: Number(teacher.value) || null, course_id: Number(course.value) || null, curriculum_id: type === 'group' ? Number(picker.cur.value) || null : null, start_seq: type === 'group' && picker.start.value !== '' ? Number(picker.start.value) : null };
          try {
            const r = await api('/api/admin/class', body);
            if (isNew) A.classes.push({ ...body, id: r.id }); else Object.assign(c, body);
            draw(); close(); toast('저장했어요');
          } catch (e) { toast(e.message, true); }
        } }, '저장하기')));
  });
}

// ───────── 학생 ─────────
function secStudents() {
  let q = '', cls = '';
  const list = h('div', { class: 'card', style: { boxShadow: 'none', maxHeight: '520px', overflow: 'auto' } });
  const count = h('span', { class: 'small muted' });
  const draw = () => {
    const cName = (id) => (A.classes.find((c) => c.id === id) || {}).name || '반 없음';
    const rows = A.students.filter((s) => (!q || s.name.includes(q) || String(s.phone || '').includes(q.replace(/\D/g, '') || '@@')) && (!cls || String(s.class_id) === cls));
    count.textContent = `${rows.length}명`;
    list.replaceChildren(...(rows.length ? rows.map((s) => h('div', { class: 'list-item', onclick: () => editStudent(s, draw) },
      h('b', { style: { minWidth: '64px' } }, s.name), h('span', { class: 'small muted grow' }, cName(s.class_id)),
      h('span', { class: 'small muted' }, fmtPhone(s.phone)), s.phone ? null : h('span', { class: 'chip warn' }, '번호 없음'))) : [h('div', { class: 'empty' }, A.students.length ? '찾는 학생이 없어요' : '아직 학생이 없어요. "명단 불러오기"로 한 번에 넣을 수 있어요.')]));
  };
  draw();
  const search = h('input', { class: 'input', placeholder: '이름·번호 찾기', oninput: debounce(() => { q = search.value.trim(); draw(); }, 150) });
  const filter = h('select', { class: 'input', onchange: () => { cls = filter.value; draw(); } }, h('option', { value: '' }, '모든 반'), A.classes.map((c) => h('option', { value: c.id }, c.name)));
  return section('students', '학생',
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => importStudents(draw) }, '명단 불러오기 (엑셀·PDF·붙여넣기)'), h('button', { class: 'btn', onclick: () => editStudent(null, draw) }, icon('plus'), '학생 추가')),
    h('div', { class: 'grid2 mt' }, search, filter), h('div', { class: 'row mt-s' }, count, h('span', { class: 'tiny muted' }, '· 학생을 지워도 지난 수업 기록은 남아요')), h('div', { class: 'mt-s' }, list));
}
function fmtPhone(p) { const d = String(p || '').replace(/\D/g, ''); if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`; if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`; return d; }

function editStudent(s, draw) {
  const isNew = !s;
  s = s || { name: '', class_id: null, phone: '', course_id: null, curriculum_id: null, start_seq: null, msg_style: '' };
  sheet(isNew ? '학생 추가' : s.name, (close) => {
    const name = h('input', { class: 'input', value: s.name });
    const phone = h('input', { class: 'input', value: fmtPhone(s.phone), inputmode: 'tel', placeholder: '010-0000-0000' });
    const cls = h('select', { class: 'input' }, h('option', { value: '' }, '반 고르기'), A.classes.map((c) => h('option', { value: c.id, selected: c.id === s.class_id }, `${c.name}${c.type === 'individual' ? ' (개별)' : ''}`)));
    const course = h('select', { class: 'input' }, h('option', { value: '' }, '과정 고르기'), S.meta.courses.map((x) => h('option', { value: x.id, selected: x.id === s.course_id }, x.name)));
    const picker = curriculumPicker(course, s.curriculum_id, s.start_seq);
    const indBox = h('div', { class: 'stack' }, h('div', { class: 'note small' }, '개별수업 학생의 진도표예요. 과정을 먼저 고르면 그 과정 진도표만 보여요.'), h('div', { class: 'grid3' }, field('과정', course), field('진도표', picker.cur), field('시작 차시', picker.start)));
    const paintInd = () => { const c = A.classes.find((x) => x.id === Number(cls.value)); indBox.classList.toggle('hidden', !(c && c.type === 'individual')); if (c && !course.value && c.course_id) { course.value = c.course_id; course.dispatchEvent(new Event('change')); } };
    cls.addEventListener('change', paintInd); paintInd();
    const style = h('select', { class: 'input' }, [['', '전체 설정 따름'], ['basic', '알림톡 기본형'], ['cushion', '알림톡 쿠션멘트형']].map(([v, l]) => h('option', { value: v, selected: s.msg_style === v }, l)));
    return h('div', { class: 'stack' },
      h('div', { class: 'grid2' }, field('이름', name), field('학부모 번호', phone)), field('반', cls), indBox,
      field('메시지 형식', style, '알림톡 템플릿을 넣은 경우에만 쓰여요'),
      !isNew && s.code ? h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, '사진·영상 모아 보기 링크 (로그인 없이 열려요)'), h('button', { class: 'btn small', onclick: () => copyText(`${location.origin}/g/${s.code}`) }, icon('link'), '링크 복사')) : null,
      h('div', { class: 'row mt' },
        !isNew ? h('button', { class: 'btn ghost danger', onclick: async () => {
          if (!(await confirmBox(`${s.name} 학생을 지울까요?`, '명단과 오늘 수업 화면에서 빠져요. 지난 수업 기록은 그대로 남아요.', '지우기', true))) return;
          await api('/api/admin/student', { id: s.id, delete: true }); A.students = A.students.filter((x) => x.id !== s.id); draw(); close();
        } }, '학생 지우기') : null,
        h('button', { class: 'btn primary', style: { marginLeft: 'auto' }, onclick: async () => {
          const c = A.classes.find((x) => x.id === Number(cls.value));
          const ind = c && c.type === 'individual';
          const body = { id: s.id, name: name.value, phone: phone.value, class_id: Number(cls.value) || null, course_id: Number(course.value) || (c ? c.course_id : null), curriculum_id: ind ? Number(picker.cur.value) || null : s.curriculum_id, start_seq: ind && picker.start.value !== '' ? Number(picker.start.value) : (ind ? null : s.start_seq), msg_style: style.value };
          try {
            const r = await api('/api/admin/student', body);
            body.phone = String(phone.value).replace(/\D/g, '');
            if (isNew) A.students.push({ ...body, id: r.id }); else Object.assign(s, body);
            A.students.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
            draw(); close(); toast('저장했어요');
          } catch (e) { toast(e.message, true); }
        } }, '저장하기')));
  });
}

function importStudents(draw) {
  sheet('학생 명단 불러오기', (close) => {
    let rows = [];
    const out = h('div');
    const paste = h('textarea', { class: 'input', rows: 5, placeholder: '엑셀에서 이름 · 반 · 학부모 번호 칸을 복사해 붙여 넣으세요.\n제목줄이 있어도 되고 없어도 돼요.', oninput: () => { rows = mapStudents(parseDelimited(paste.value)); preview(); } });
    const file = h('input', { type: 'file', class: 'hidden', accept: '.xlsx,.xlsm,.csv,.txt,.pdf,.xls', onchange: async () => {
      const f = file.files[0]; if (!f) return;
      out.replaceChildren(h('div', { class: 'muted small' }, '읽는 중…'));
      try {
        const r = await readTableFile(f);
        rows = r.rows ? mapStudents(r.rows) : studentsFromPdf(r.pdfLines, A.classes.map((c) => c.name));
        preview();
      } catch (e) { out.replaceChildren(h('div', { class: 'note bad' }, e.message)); }
      file.value = '';
    } });
    const saveBtn = h('button', { class: 'btn primary', disabled: true, onclick: async () => {
      saveBtn.disabled = true;
      try {
        const r = await api('/api/admin/students/import', { rows });
        toast(`새 학생 ${r.added}명 · 번호·반 바뀜 ${r.updated}명${r.createdClasses ? ` · 새 반 ${r.createdClasses}개` : ''}`);
        const fresh = await api('/api/admin'); A.students = fresh.students; A.classes = fresh.classes;
        close(); renderAdmin(document.querySelector('main.view'));
      } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
    } }, '저장하기');
    function preview() {
      saveBtn.disabled = !rows.length;
      if (!rows.length) { out.replaceChildren(h('div', { class: 'note warn' }, '읽은 학생이 없어요. 이름 · 반 · 번호가 들어간 표를 붙여 넣어 주세요.')); return; }
      const existing = new Set(A.students.map((s) => s.name.replace(/\s+/g, '')));
      const classNames = new Set(A.classes.map((c) => c.name.replace(/\s+/g, '')));
      const newClasses = [...new Set(rows.map((r) => r.class).filter((c) => c && !classNames.has(c.replace(/\s+/g, ''))))];
      out.replaceChildren(
        h('div', { class: 'note ok' }, h('b', null, `${rows.length}명을 읽었어요.`), ' 칸을 눌러 바로 고칠 수 있어요. 같은 이름이 이미 있으면 번호와 반만 바뀌어요.'),
        newClasses.length ? h('div', { class: 'note warn mt-s small' }, `처음 보는 반: ${newClasses.join(', ')} — 저장하면 새 반(그룹수업, 월~금)으로 만들어져요.`) : null,
        h('div', { class: 'card mt-s', style: { maxHeight: '340px', overflow: 'auto' } }, h('table', { class: 'tbl', style: { minWidth: '520px' } },
          h('thead', null, h('tr', null, h('th', null, '이름'), h('th', null, '반'), h('th', null, '학부모 번호'), h('th', null, ''), h('th', null, ''))),
          h('tbody', null, rows.map((r, i) => {
            const d = String(r.phone).replace(/\D/g, '');
            const bad = d && !/^0?1\d{8,9}$/.test(d);
            return h('tr', null,
              h('td', null, h('input', { class: 'input', style: { minWidth: '80px' }, value: r.name, oninput: (e) => { r.name = e.target.value; } })),
              h('td', null, h('input', { class: 'input', style: { minWidth: '96px' }, value: r.class, oninput: (e) => { r.class = e.target.value; } })),
              h('td', null, h('input', { class: 'input', value: r.phone, style: bad ? { borderColor: 'var(--bad)', minWidth: '130px' } : { minWidth: '130px' }, oninput: (e) => { r.phone = e.target.value; } })),
              h('td', null, existing.has(r.name.replace(/\s+/g, '')) ? h('span', { class: 'chip info' }, '번호·반 바꿈') : h('span', { class: 'chip ok' }, '새 학생')),
              h('td', null, h('button', { class: 'icon-btn', 'aria-label': '빼기', onclick: () => { rows.splice(i, 1); preview(); } }, icon('x'))));
          })))));
    }
    return h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => file.click() }, '엑셀·PDF 파일 올리기'), h('span', { class: 'small muted' }, '또는 아래에 붙여 넣기'), file),
      paste, out, h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn', onclick: close }, '취소'), saveBtn));
  });
}

// ───────── 숙제 버튼 · 사유 ─────────
function secHw() {
  const btns = h('textarea', { class: 'input', rows: 8, value: (A.settings.hw_buttons || []).join('\n'), oninput: () => setSetting('hw_buttons', btns.value.split('\n').map((x) => x.trim()).filter(Boolean)) });
  const reasons = h('textarea', { class: 'input', rows: 4, value: (A.settings.reasons || []).join('\n'), oninput: () => setSetting('reasons', reasons.value.split('\n').map((x) => x.trim()).filter(Boolean)) });
  return section('hw', '숙제 빠른 선택 버튼 · 출결 사유',
    h('div', { class: 'grid2' }, field('숙제 버튼 (한 줄에 하나)', btns, '"오늘 숙제" 칸 아래 버튼으로 보여요'), field('출결 사유 (한 줄에 하나)', reasons, '사유를 고른 학생은 즉시 알림·일간 리포트에서 빠져요')));
}

// ───────── 메시지 문구 ─────────
const PH_DAILY = ['학원', '학생명', '반', '날짜', '출석', '오늘 할 일', '숙제', '다음 수업', '지난 숙제 내용', '지난 숙제 결과', '선생님 한마디', '사진 링크', '인사', '출석 멘트', '숙제 멘트', '마무리'];
const PH_PERIOD = ['학원', '학생명', '반', '기간', '대상월', '출석 요약', '숙제 완료율', '진도', '코멘트', '인사', '주간 멘트', '마무리'];
function tplEditor(kind, label) {
  const ta = h('textarea', { class: 'input', rows: 12, value: A.settings.sms_templates[kind] || '', oninput: save });
  const warn = h('div', { class: 'note warn small hidden mt-s' }, '#{…} 칸은 알림톡용이에요. "발송 방식"의 알림톡 칸에 넣어 주세요.');
  function save() { warn.classList.toggle('hidden', !/#\{/.test(ta.value)); setSetting('sms_templates', { ...A.settings.sms_templates, [kind]: ta.value }); }
  const ph = kind === 'weekly' || kind === 'monthly' ? PH_PERIOD : PH_DAILY;
  const chips = h('div', { class: 'ph-chips' }, ph.map((p) => h('button', { type: 'button', onclick: () => {
    const s = ta.selectionStart ?? ta.value.length; ta.setRangeText(`{${p}}`, s, ta.selectionEnd ?? s, 'end'); ta.focus(); save();
  } }, `{${p}}`)));
  warn.classList.toggle('hidden', !/#\{/.test(ta.value));
  return h('div', { class: 'mt' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, label),
    h('button', { class: 'btn small ghost', onclick: () => { ta.value = A.defaults.sms[kind]; save(); toast('추천 문구로 바꿨어요'); } }, '추천 문구로 바꾸기')), chips, ta, warn);
}
function secTemplates() {
  return section('tpl', '메시지 문구 (문자)',
    h('p', { class: 'small muted', style: { margin: 0 } }, '{ } 칸은 자동으로 채워져요. 내용이 빈 줄(예: 한마디를 안 쓴 날, 사진이 없는 날)은 자동으로 빠져요. 칸 이름을 눌러 넣을 수 있어요.'),
    tplEditor('daily', '일간 리포트'), tplEditor('missing', '미제출 알림'), tplEditor('weekly', '주간 리포트'), tplEditor('monthly', '월간 리포트'));
}

// ───────── 쿠션 멘트 ─────────
function secCushions() {
  const keys = Object.keys(A.defaults.cushionLabels);
  return section('cushion', '쿠션 멘트 (AI 없이, 무료)',
    h('p', { class: 'small muted', style: { margin: '0 0 6px' } }, '상황별 문장 중 하나가 학생·날짜마다 골라져서 메시지에 들어가요. 미리보기를 다시 만들어도 같은 학생·같은 날은 같은 문장이에요. 한 줄에 하나씩, 원장님 말투로 적어 주세요. {학생명} {학원}도 쓸 수 있어요.'),
    h('div', { class: 'grid2' }, keys.map((k) => {
      const ta = h('textarea', { class: 'input', rows: 4, value: (A.settings.cushions[k] || []).join('\n'), oninput: () => setSetting('cushions', { ...A.settings.cushions, [k]: ta.value.split('\n').map((x) => x.trim()).filter(Boolean) }) });
      return h('div', { class: 'field' }, h('div', { class: 'row' }, h('span', { class: 'lbl grow', style: { margin: 0 } }, A.defaults.cushionLabels[k]),
        h('button', { class: 'btn small ghost', onclick: () => { ta.value = A.defaults.cushions[k].join('\n'); ta.dispatchEvent(new Event('input')); } }, '추천')), ta);
    })));
}

// ───────── 발송 방식 (솔라피 · 알림톡) ─────────
function secSend() {
  const k = A.settings.kakao = { pfId: '', style: 'basic', templates: [], ...A.settings.kakao };
  const saveKakao = () => setSetting('kakao', { ...k, templates: k.templates }, 700);
  const status = h('div', { class: 'stack' });
  async function loadStatus() {
    status.replaceChildren(h('div', { class: 'muted small' }, '확인 중…'));
    let st; try { st = await api('/api/admin/solapi'); } catch (e) { status.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
    status.replaceChildren(
      st.ready ? h('div', { class: 'note ok' }, h('b', null, '솔라피 연결됨'), st.error ? ` · 잔액 확인 실패: ${st.error}` : st.balance != null ? ` · 잔액 ${Number(st.balance).toLocaleString()}원` : '')
        : h('div', { class: 'note warn' }, h('b', null, '아직 솔라피 연결 전이에요. '), '아래 3가지를 Cloudflare에 "비밀(Secret)"로 넣어 주세요. 채팅이나 코드에는 넣지 마세요.'),
      h('dl', { class: 'kv' },
        h('dt', null, 'API Key'), h('dd', null, st.keyPrefix ? `${st.keyPrefix} (${st.keyLength}자)` : '없음'),
        h('dt', null, 'API Secret'), h('dd', null, st.secretLength ? `${st.secretLength}자` : '없음'),
        h('dt', null, '발신번호'), h('dd', null, st.sender || '없음')),
      !st.ready ? h('ol', { class: 'steps' },
        h('li', null, 'Cloudflare → Workers & Pages → ', h('b', null, 'class-manager'), ' → Settings → Variables and Secrets → ', h('b', null, '+ Add')),
        h('li', null, 'Type은 ', h('b', null, 'Secret'), ', 이름은 ', h('code', null, 'SOLAPI_API_KEY'), ' / ', h('code', null, 'SOLAPI_API_SECRET'), ' / ', h('code', null, 'SOLAPI_SENDER'), ' (발신번호, 숫자만)'),
        h('li', null, '세 개 모두 넣고 ', h('b', null, 'Deploy'), '를 누른 뒤 아래 "다시 확인"을 눌러 주세요.')) : null,
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: loadStatus }, '다시 확인'),
        h('button', { class: 'btn small primary', onclick: async () => {
          try { const r = await api('/api/admin/test-sms', { phone: A.settings.director_phone }); r.ok ? toast(`${fmtPhone(r.to)}으로 테스트 문자를 보냈어요`) : toast(r.error, true); } catch (e) { toast(e.message, true); }
        } }, '나에게 테스트 문자'), h('span', { class: 'tiny muted' }, A.settings.director_phone ? `받는 번호: ${A.settings.director_phone}` : '받는 번호: 발신번호 (학원 정보에서 원장님 휴대폰을 넣으면 그 번호로)')));
  }
  loadStatus();

  const pf = h('input', { class: 'input', value: k.pfId, placeholder: 'KA01PF…', oninput: () => { k.pfId = pf.value.trim(); saveKakao(); } });
  const styleSeg = h('div', { class: 'seg' }, [['basic', '전체 기본형'], ['cushion', '전체 쿠션형']].map(([v, l]) => h('button', { 'aria-pressed': String(k.style === v), onclick: (e) => { k.style = v; for (const b of styleSeg.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); saveKakao(); } }, l)));
  const tplBox = h('div', { class: 'stack' });
  const KINDS = ['daily', 'missing', 'weekly', 'monthly', 'att'];
  const drawTpl = () => {
    tplBox.replaceChildren(...KINDS.map((kind) => h('div', { class: 'card card-pad', style: { boxShadow: 'none', background: '#fbfaf7' } },
      h('b', null, A.defaults.kinds[kind]),
      ...['basic', 'cushion'].map((style) => {
        const t = k.templates.find((x) => x.kind === kind && x.style === style);
        const label = style === 'basic' ? '기본형' : '쿠션멘트형';
        if (!t) return h('div', { class: 'row mt-s' }, h('span', { class: 'small muted grow' }, `${label}: 비어 있음 → ${style === 'basic' ? '문자로 나가요' : '기본형으로 나가요'}`),
          h('button', { class: 'btn small', onclick: () => { k.templates.push({ uid: 'n' + Date.now(), kind, style, templateId: '', text: '', approved: style === 'basic' }); saveKakao(); drawTpl(); } }, icon('plus'), `${label} 칸 추가`));
        return tplSlot(t, label, kind, style, saveKakao, () => { k.templates = k.templates.filter((x) => x !== t); saveKakao(); drawTpl(); });
      }))));
  };
  drawTpl();
  const link = `${location.origin}/g/#{사진코드}`;
  return section('send', '발송 방식',
    h('div', { class: 'sec-title', style: { marginTop: 0 } }, '솔라피 (문자 발송)'), status,
    h('div', { class: 'sec-title' }, '카카오 알림톡'),
    h('div', { class: 'note small' }, '처음엔 문자(SMS/LMS)로 나가요. 카카오 심사를 통과한 템플릿을 아래에 넣으면 그 종류는 알림톡으로 바뀌어요. 비워 둔 종류는 문자로 나가고, 알림톡이 실패하면 같은 내용을 문자로 대신 보내요. (친구톡은 끝나고 광고용 브랜드 메시지로 바뀌어서, 수업 안내는 알림톡을 써요)'),
    h('div', { class: 'grid2 mt' }, field('카카오 채널 ID (pfId)', pf, '솔라피 → 카카오 채널 연동 화면의 KA01PF… 값'), field('메시지 형식', styleSeg, '학생마다 따로 정하려면 관리 → 학생에서')),
    h('div', { class: 'note small mt' }, h('b', null, '사진 버튼 만들기: '), '알림톡 템플릿에 "웹링크" 버튼을 추가하고 주소를 아래처럼 넣으세요. 버튼을 누르면 그 학생의 사진·영상 모아 보기가 열려요.',
      h('div', { class: 'row mt-s' }, h('code', { class: 'grow' }, link), h('button', { class: 'btn small', onclick: () => copyText(link) }, '복사'))),
    h('div', { class: 'mt' }, tplBox));
}

function tplSlot(t, label, kind, style, saveKakao, remove) {
  const checks = h('div', { class: 'fields-check' });
  const runCheck = debounce(async () => {
    if (!t.text.trim()) { checks.replaceChildren(); return; }
    try {
      const r = await api('/api/admin/kakao-check', { text: t.text });
      checks.replaceChildren(...(r.fields.length ? r.fields.map((f) => h('span', { class: 'chip ' + (f.ok ? 'ok' : 'bad'), title: f.ok ? '자동으로 채워져요' : '앱이 모르는 칸이에요' }, `${f.ok ? '✓' : '✕'} #{${f.name}}`)) : [h('span', { class: 'tiny muted' }, '#{…} 칸이 없어요')]));
    } catch { /* */ }
  }, 300);
  const id = h('input', { class: 'input', value: t.templateId, placeholder: 'KA01TP…', oninput: () => { t.templateId = id.value.trim(); saveKakao(); } });
  const ta = h('textarea', { class: 'input', rows: 8, value: t.text, placeholder: '카카오에서 승인받은 문구를 그대로 붙여 넣으세요', oninput: () => { t.text = ta.value; saveKakao(); runCheck(); } });
  const approved = style === 'cushion' ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: t.approved !== false, onchange: (e) => { t.approved = e.target.checked; saveKakao(); } }), '승인 완료 (체크 안 하면 기본형으로 나가요)') : null;
  runCheck();
  return h('div', { class: 'mt', style: { borderTop: '1px solid var(--line)', paddingTop: '10px' } },
    h('div', { class: 'row' }, h('span', { class: 'chip dark' }, label), h('span', { class: 'grow' }),
      h('button', { class: 'btn small ghost', onclick: () => { ta.value = A.defaults.kakao[kind][style]; ta.dispatchEvent(new Event('input')); toast('카카오 심사에 낼 추천 문구를 넣었어요'); } }, '추천 문구'),
      h('button', { class: 'btn small', onclick: async () => {
        await outbox.flushAll();
        try { const r = await api('/api/admin/kakao-test', { uid: t.uid, phone: A.settings.director_phone }); r.ok ? toast(r.channel === 'kakao' ? '알림톡 테스트를 보냈어요' : '알림톡이 안 돼서 문자로 보냈어요') : toast(r.error, true); } catch (e) { toast(e.message, true); }
      } }, '알림톡 테스트'),
      h('button', { class: 'icon-btn', 'aria-label': '템플릿 지우기', onclick: remove }, icon('trash'))),
    h('div', { class: 'grid2 mt-s', style: { gridTemplateColumns: '1fr 2fr' } }, field('템플릿 ID', id), field('승인받은 문구', ta)), checks, approved);
}

// ───────── 발송 일정 ─────────
function secSchedule() {
  const s = A.settings.schedule;
  const save = () => { setSetting('schedule', { ...s }); S.meta.schedule = { ...s }; };
  const time = (key) => h('input', { class: 'input', type: 'time', value: s[key], step: 600, onchange: (e) => { s[key] = e.target.value; save(); } });
  const sw = (key, label) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!s[key], onchange: (e) => { s[key] = e.target.checked; save(); } }), label);
  return section('schedule', '발송 일정',
    h('div', { class: 'grid2' }, field('미리보기 만드는 시간', time('preview'), '이 시간에 그날 기록으로 메시지를 만들어요'), field('자동 발송 시간', time('send'), '그 전까지 문구를 고치거나 체크를 풀 수 있어요')),
    h('div', { class: 'stack mt' }, sw('auto_send', '일간 리포트 자동 발송 (체크된 메시지만)')),
    h('div', { class: 'sec-title' }, '미제출 알림'),
    h('div', { class: 'stack' }, sw('missing_on', '미제출 알림 미리보기 만들기'), sw('missing_auto', '미제출 알림도 자동 발송'),
      h('select', { class: 'input', style: { maxWidth: '260px' }, onchange: (e) => { s.missing_target = e.target.value; save(); } }, [['missing', '대상: 미제출만'], ['missing+partial', '대상: 미제출 + 미흡']].map(([v, l]) => h('option', { value: v, selected: s.missing_target === v }, l)))),
    h('div', { class: 'sec-title' }, '주간 · 월간 리포트'),
    h('div', { class: 'stack' }, sw('weekly_on', '주간 리포트 미리보기 만들기'),
      h('div', { class: 'row' }, h('span', { class: 'small' }, '요일'), h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => { s.weekly_day = Number(e.target.value); save(); } }, [1, 2, 3, 4, 5, 6, 0].map((d) => h('option', { value: d, selected: Number(s.weekly_day) === d }, `${DOW_KO[d]}요일`)))),
      sw('weekly_exclude_today', '기준일 당일 수업은 빼기 (일간 리포트로 따로 나가니까)'),
      sw('weekly_auto', '주간 리포트 자동 발송 (끄면 직접 골라서 보내기)'),
      sw('monthly_on', '월간 리포트 미리보기 만들기 (매달 말일)'),
      sw('monthly_auto', '월간 리포트 자동 발송 (끄면 직접 골라서 보내기)')));
}

// ───────── 출결 즉시 알림 ─────────
function secAtt() {
  const a = A.settings.att_alerts;
  const sw = (key, label) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!a[key], onchange: (e) => { a[key] = e.target.checked; setSetting('att_alerts', { ...a }); } }), label);
  const ta = h('textarea', { class: 'input', rows: 3, value: A.settings.sms_templates.att, oninput: () => setSetting('sms_templates', { ...A.settings.sms_templates, att: ta.value }) });
  return section('att', '출결 즉시 알림',
    h('div', { class: 'note small' }, '출결은 저녁 일간 리포트에 함께 들어가서 기본으로 모두 꺼져 있어요. 켜면 오늘 날짜에만, 학생당 하루 한 번만 나가요 (실수로 바꿔도 다시 나가지 않아요). 사유를 고른 학생에게는 나가지 않아요.'),
    h('div', { class: 'stack mt' }, sw('arrive', '등원(출석) 알림'), sw('late', '지각 알림'), sw('absent', '결석 알림')),
    h('div', { class: 'mt' }, field('알림 문구', ta, '{학원} {학생명} {날짜} {출석} 칸을 쓸 수 있어요')));
}

// ───────── 사진·영상 ─────────
function secMedia() {
  return section('media', '사진·영상 저장소 (Cloudflare R2)',
    A.r2 ? h('div', { class: 'note ok' }, '연결되어 있어요. 올린 사진·영상은 30일 뒤 자동으로 지워져요.')
      : h('div', { class: 'stack' }, h('div', { class: 'note warn' }, '아직 R2가 연결되지 않았어요. 아래 순서대로 한 번만 켜 주세요.'),
        h('ol', { class: 'steps' },
          h('li', null, 'Cloudflare 왼쪽 메뉴 ', h('b', null, 'R2 Object Storage'), ' → ', h('b', null, 'Purchase R2 Plan'), ' (무료 10GB, 결제 수단 등록만 필요)'),
          h('li', null, h('b', null, 'Create bucket'), ' → 이름에 ', h('code', null, 'class-manager-media'), ' 그대로 → Create'),
          h('li', null, 'GitHub에 다시 올리면(또는 Cloudflare에서 다시 배포하면) 자동으로 연결돼요.'))));
}

// ───────── 기록 내려받기 ─────────
function secExport() {
  const from = h('input', { class: 'input', type: 'date', value: addDays(kstToday(), -30) });
  const to = h('input', { class: 'input', type: 'date', value: kstToday() });
  return section('export', '수업 기록 내려받기',
    h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, '날짜 · 반 · 학생 · 출결 · 숙제 · 진도 · 한마디를 CSV 파일로 받아요. 엑셀이나 구글 시트(파일 → 가져오기)에서 바로 열려요.'),
    h('div', { class: 'grid3' }, field('시작', from), field('끝', to), h('div', { class: 'field' }, h('span', { class: 'lbl' }, ' '), h('button', { class: 'btn primary block', onclick: () => { location.href = `/api/export.csv?from=${from.value}&to=${to.value}`; } }, '내려받기'))));
}

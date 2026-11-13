// 앱 화면이 부르는 기능들 (주소별 처리)

import { all, first, run, getSettings, setSetting, DEFAULT_SETTINGS } from './db.js';
import { json, bad, HttpError, randomToken, hashPassword, kstNow, addDays, normPhone, dowOf } from './util.js';
import { buildDay } from './context.js';
import { generate, sendMessages, refreshIfExists, attendanceAlert, buildSendItem, ATT_LABEL, HW_LABEL } from './messages.js';
import { solapiStatus, solapiBalance, sendBatch } from './solapi.js';
import { renderTemplate, checkKakaoFields, kakaoVariables } from './render.js';
import { RECOMMENDED_KAKAO, DEFAULT_SMS, KIND_LABELS, CUSHION_LABELS } from './defaults.js';
import { mediaStart, mediaPart, mediaComplete, mediaDelete, mediaList, r2Ready } from './media.js';

const SESSION_DAYS = 60;

// ───────── 로그인 ─────────
function cookieOf(request, name) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function getMe(env, request) {
  const token = cookieOf(request, 'sid');
  if (!token) return null;
  const s = await first(env, 'SELECT * FROM sessions WHERE token = ? AND expires > ?', token, Date.now());
  if (!s) return null;
  if (s.role === 'director') return { role: 'director', id: 0, name: '원장' };
  const t = await first(env, 'SELECT id, name, active FROM teachers WHERE id = ?', s.teacher_id);
  if (!t || !t.active) return null;
  return { role: 'teacher', id: t.id, name: t.name };
}

async function newSession(env, role, teacherId, request) {
  const token = randomToken(32);
  await run(env, 'INSERT INTO sessions (token, role, teacher_id, expires) VALUES (?, ?, ?, ?)', token, role, teacherId || null, Date.now() + SESSION_DAYS * 864e5);
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

async function boot(env, request, me, version) {
  const settings = await getSettings(env);
  const teachers = await all(env, 'SELECT id, name FROM teachers WHERE active = 1 ORDER BY sort, name');
  return {
    setup: !settings.director_pw, academy: settings.academy, version, me,
    people: [{ who: 'director', name: '원장' }, ...teachers.map((t) => ({ who: String(t.id), name: t.name }))],
    today: kstNow().date,
  };
}

async function setup(env, request, body) {
  const settings = await getSettings(env);
  if (settings.director_pw) throw bad('이미 설정이 끝났어요');
  if (!String(body.password || '').trim() || String(body.password).length < 4) throw bad('비밀번호는 4자 이상으로 정해 주세요');
  const salt = randomToken(16);
  await setSetting(env, 'director_salt', salt);
  await setSetting(env, 'director_pw', await hashPassword(String(body.password), salt));
  await setSetting(env, 'academy', String(body.academy || '').trim());
  const c = await first(env, 'SELECT COUNT(*) AS n FROM courses');
  if (!c.n) {
    let i = 0;
    for (const n of ['중등', '초등 리딩', '초등 파닉스']) await run(env, 'INSERT INTO courses (name, sort) VALUES (?, ?)', n, i++);
  }
  return newSession(env, 'director', null, request);
}

async function login(env, request, body) {
  const settings = await getSettings(env);
  const pw = String(body.password || '');
  if (body.who === 'director') {
    if (!settings.director_pw || (await hashPassword(pw, settings.director_salt)) !== settings.director_pw) throw new HttpError(401, '비밀번호가 맞지 않아요');
    return newSession(env, 'director', null, request);
  }
  const t = await first(env, 'SELECT * FROM teachers WHERE id = ? AND active = 1', Number(body.who));
  if (!t || !t.pw || (await hashPassword(pw, t.salt)) !== t.pw) throw new HttpError(401, '비밀번호가 맞지 않아요');
  return newSession(env, 'teacher', t.id, request);
}

// ───────── 권한 ─────────
async function teacherOwnsClass(env, me, classId) {
  if (me.role === 'director') return true;
  const c = await first(env, 'SELECT teacher_id FROM classes WHERE id = ?', Number(classId));
  return c && c.teacher_id === me.id;
}
async function assertStudent(env, me, studentId) {
  const s = await first(env, 'SELECT s.id, s.class_id, c.teacher_id FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.id = ?', Number(studentId));
  if (!s) throw bad('학생을 찾을 수 없어요');
  if (me.role !== 'director' && s.teacher_id !== me.id) throw new HttpError(403, '내 반 학생이 아니에요');
  return s;
}
function directorOnly(me) { if (me.role !== 'director') throw new HttpError(403, '원장님만 바꿀 수 있어요'); }

async function visibleStudentIds(env, me) {
  if (me.role === 'director') return null;
  const rows = await all(env, 'SELECT s.id FROM students s JOIN classes c ON c.id = s.class_id WHERE c.teacher_id = ?', me.id);
  return new Set(rows.map((r) => r.id));
}

// ───────── 공통 정보 ─────────
async function meta(env, me) {
  const settings = await getSettings(env);
  const courses = await all(env, 'SELECT id, name, sort FROM courses WHERE deleted = 0 ORDER BY sort, id');
  const curricula = await all(env, `SELECT c.id, c.name, c.course_id, c.cycle, COUNT(l.id) AS lessons, MIN(l.seq) AS first_seq, MAX(l.seq) AS last_seq
    FROM curricula c LEFT JOIN lessons l ON l.curriculum_id = c.id WHERE c.deleted = 0 GROUP BY c.id ORDER BY c.name`);
  const teachers = await all(env, 'SELECT id, name FROM teachers WHERE active = 1 ORDER BY sort, name');
  return {
    me, academy: settings.academy, courses, curricula, teachers,
    hw_buttons: settings.hw_buttons, reasons: settings.reasons, schedule: settings.schedule,
    r2: r2Ready(env), today: kstNow().date,
  };
}

async function today(env, me, url) {
  const date = url.searchParams.get('date') || kstNow().date;
  const allDays = url.searchParams.get('all') === '1';
  const ctx = await buildDay(env, date, { allDays, teacherId: me.role === 'teacher' ? me.id : null });
  const lessons = {};
  for (const [id, c] of ctx.curricula) lessons[id] = c.lessons.map((l) => ({ id: l.id, seq: l.seq, title: l.title, content: l.content, homework: l.homework }));
  const teachers = await all(env, 'SELECT id, name FROM teachers');
  const tMap = new Map(teachers.map((t) => [t.id, t.name]));
  // 출석 현황판 (요일 기준 오늘 수업 반 전체)
  const boardCtx = allDays ? await buildDay(env, date, { teacherId: me.role === 'teacher' ? me.id : null }) : ctx;
  const board = { present: 0, late: 0, absent: 0, none: 0, pendingClasses: [] };
  for (const c of boardCtx.classes) {
    let pending = 0;
    for (const s of c.students) {
      const a = s.day.att;
      if (a === 'present' || a === 'late' || a === 'absent') board[a]++;
      else if (!s.day.reason) { board.none++; pending++; }
    }
    if (pending && pending === c.students.filter((s) => !s.day.reason).length) board.pendingClasses.push({ id: c.id, name: c.name, time: c.time });
  }
  return {
    date, dow: dowOf(date), board,
    classes: ctx.classes.map((c) => ({ ...c, teacher_name: tMap.get(c.teacher_id) || '' })),
    lessons,
    curricula: [...ctx.curricula.values()].map((c) => ({ id: c.id, name: c.name, course_id: c.course_id, cycle: c.cycle })),
  };
}

async function saveAttendance(env, me, body, ctx) {
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('날짜가 올바르지 않아요');
  const s = await assertStudent(env, me, body.student_id);
  const att = ['present', 'late', 'absent', ''].includes(body.att) ? body.att : undefined;
  const reason = body.reason !== undefined ? String(body.reason || '') : undefined;
  const stamp = kstNow().stamp;
  const prev = await first(env, 'SELECT att, reason FROM days WHERE date = ? AND student_id = ?', date, s.id);
  const newAtt = att !== undefined ? att : prev ? prev.att : '';
  const newReason = reason !== undefined ? reason : prev ? prev.reason : '';
  await run(env, `INSERT INTO days (date, student_id, class_id, att, reason, att_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, student_id) DO UPDATE SET att = excluded.att, reason = excluded.reason,
    att_at = CASE WHEN days.att = excluded.att THEN days.att_at ELSE excluded.att_at END, updated_at = excluded.updated_at`,
  date, s.id, s.class_id, newAtt, newReason, stamp, stamp);
  if (newAtt && !newReason && (!prev || prev.att !== newAtt)) ctx.waitUntil(attendanceAlert(env, s.id, date, newAtt).catch(() => {}));
  ctx.waitUntil(refreshIfExists(env, date).catch(() => {}));
  return { ok: true, saved_at: stamp };
}

async function attendanceAll(env, me, body, ctx) {
  if (!(await teacherOwnsClass(env, me, body.class_id))) throw new HttpError(403, '내 반이 아니에요');
  const date = String(body.date);
  const students = await all(env, 'SELECT id FROM students WHERE class_id = ? AND deleted = 0', Number(body.class_id));
  const stamp = kstNow().stamp;
  const changed = [];
  for (const st of students) {
    const d = await first(env, 'SELECT att, reason FROM days WHERE date = ? AND student_id = ?', date, st.id);
    if (d && (d.att || d.reason)) continue; // 아직 체크 안 한 학생만
    await run(env, `INSERT INTO days (date, student_id, class_id, att, att_at, updated_at) VALUES (?, ?, ?, 'present', ?, ?)
      ON CONFLICT(date, student_id) DO UPDATE SET att = 'present', att_at = excluded.att_at, updated_at = excluded.updated_at`, date, st.id, Number(body.class_id), stamp, stamp);
    changed.push(st.id);
  }
  ctx.waitUntil((async () => { for (const id of changed) await attendanceAlert(env, id, date, 'present').catch(() => {}); await refreshIfExists(env, date); })().catch(() => {}));
  return { ok: true, changed };
}

async function saveRecord(env, me, body, ctx) {
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('날짜가 올바르지 않아요');
  const classId = Number(body.class_id);
  if (!(await teacherOwnsClass(env, me, classId))) throw new HttpError(403, '내 반이 아니에요');
  const stamp = kstNow().stamp;
  const stmts = [];
  for (const l of body.logs || []) {
    if (!/^[cs]\d+$/.test(String(l.target))) continue;
    stmts.push(env.DB.prepare(`INSERT INTO logs (date, target, class_id, curriculum_id, lesson_id, seq, today, next, homework, repeat, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(date, target) DO UPDATE SET class_id = excluded.class_id,
      curriculum_id = excluded.curriculum_id, lesson_id = excluded.lesson_id, seq = excluded.seq, today = excluded.today,
      next = excluded.next, homework = excluded.homework, repeat = excluded.repeat, updated_at = excluded.updated_at`)
      .bind(date, l.target, classId, l.curriculum_id || null, l.lesson_id || null, l.seq ?? null,
        String(l.today || ''), String(l.next || ''), String(l.homework || ''), l.repeat ? 1 : 0, stamp));
  }
  const allowed = new Set((await all(env, 'SELECT id FROM students WHERE class_id = ?', classId)).map((r) => r.id));
  for (const s of body.students || []) {
    if (!allowed.has(Number(s.id))) continue;
    stmts.push(env.DB.prepare(`INSERT INTO days (date, student_id, class_id, hw, comment, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, student_id) DO UPDATE SET hw = excluded.hw, comment = excluded.comment, updated_at = excluded.updated_at`)
      .bind(date, Number(s.id), classId, ['done', 'partial', 'missing', ''].includes(s.hw) ? s.hw : '', String(s.comment || ''), stamp));
  }
  if (stmts.length) await env.DB.batch(stmts);
  ctx.waitUntil(refreshIfExists(env, date).catch(() => {}));
  return { ok: true, saved_at: stamp };
}

async function setStudentCurriculum(env, me, body) {
  await assertStudent(env, me, body.student_id);
  const cur = body.curriculum_id ? await first(env, 'SELECT id, course_id FROM curricula WHERE id = ?', Number(body.curriculum_id)) : null;
  await run(env, 'UPDATE students SET curriculum_id = ?, start_seq = ?, course_id = COALESCE(?, course_id) WHERE id = ?',
    cur ? cur.id : null, body.start_seq === '' || body.start_seq == null ? null : Number(body.start_seq), cur ? cur.course_id : null, Number(body.student_id));
  // 오늘 이미 저장된 기록이 다른 진도표라면 지워서 새 진도표로 다시 채워지게
  if (body.date) await run(env, 'DELETE FROM logs WHERE date = ? AND target = ? AND (curriculum_id IS NULL OR curriculum_id != ?)', body.date, `s${Number(body.student_id)}`, cur ? cur.id : -1);
  return { ok: true };
}

// ───────── 숙제 현황 ─────────
async function homework(env, me, url) {
  const date = url.searchParams.get('date') || kstNow().date;
  const ctx = await buildDay(env, date, { teacherId: me.role === 'teacher' ? me.id : null });
  const msgs = await all(env, "SELECT student_id, kind, status, sent_at, checked, error FROM messages WHERE ref = ? AND kind IN ('daily','missing')", date);
  const mMap = new Map(msgs.map((m) => [`${m.kind}|${m.student_id}`, m]));
  const dow = dowOf(date);
  const weekFrom = addDays(date, -((dow + 6) % 7));
  const monthFrom = date.slice(0, 8) + '01';
  const d30 = addDays(date, -29);
  const from = [weekFrom, monthFrom, d30].sort()[0];
  const rows = await all(env, `SELECT student_id,
      SUM(CASE WHEN date >= ? AND hw = 'missing' THEN 1 ELSE 0 END) AS w_m, SUM(CASE WHEN date >= ? AND hw = 'partial' THEN 1 ELSE 0 END) AS w_p,
      SUM(CASE WHEN date >= ? AND hw = 'missing' THEN 1 ELSE 0 END) AS m_m, SUM(CASE WHEN date >= ? AND hw = 'partial' THEN 1 ELSE 0 END) AS m_p,
      SUM(CASE WHEN date >= ? AND hw = 'missing' THEN 1 ELSE 0 END) AS d_m, SUM(CASE WHEN date >= ? AND hw = 'partial' THEN 1 ELSE 0 END) AS d_p
    FROM days WHERE date >= ? AND date <= ? GROUP BY student_id`, weekFrom, weekFrom, monthFrom, monthFrom, d30, d30, from, date);
  const acc = new Map(rows.map((r) => [r.student_id, r]));
  return {
    date,
    classes: ctx.classes.map((c) => ({
      id: c.id, name: c.name, type: c.type, course_id: c.course_id, time: c.time,
      prevHomework: c.progress ? c.progress.prevHomework : '',
      students: c.students.map((s) => ({
        id: s.id, name: s.name, att: s.day.att, reason: s.day.reason, hw: s.day.hw,
        prevHomework: s.progress ? s.progress.prevHomework : (c.progress ? c.progress.prevHomework : ''),
        daily: mMap.get(`daily|${s.id}`) || null, missing: mMap.get(`missing|${s.id}`) || null,
        acc: acc.get(s.id) || { w_m: 0, w_p: 0, m_m: 0, m_p: 0, d_m: 0, d_p: 0 },
      })),
    })),
  };
}

// ───────── 학부모 메시지 ─────────
async function listMessages(env, me, url) {
  const kind = url.searchParams.get('kind') || 'daily';
  const ref = url.searchParams.get('ref') || kstNow().date;
  const exists = await first(env, 'SELECT id FROM messages WHERE kind = ? AND ref = ? LIMIT 1', kind, ref);
  if (exists) await generate(env, kind, ref); // 열 때마다 가장 최근 수업 기록으로 다시 맞추기
  const vis = await visibleStudentIds(env, me);
  const rows = await all(env, `SELECT m.*, s.name AS student_name, s.phone, s.msg_style, c.name AS class_name, c.course_id, c.id AS class_id
    FROM messages m LEFT JOIN students s ON s.id = m.student_id LEFT JOIN classes c ON c.id = s.class_id
    WHERE m.kind = ? AND m.ref = ? ORDER BY c.sort, c.name, s.name`, kind, ref);
  const settings = await getSettings(env);
  const list = rows.filter((r) => !vis || vis.has(r.student_id)).map((r) => {
    let vars = {}; try { vars = JSON.parse(r.vars || '{}'); } catch { /* */ }
    const item = r.edited ? { kakao: null, style: 'sms' } : buildSendItem(settings, kind, r.id, r.phone, r.text, vars, r.msg_style);
    return {
      id: r.id, student_id: r.student_id, student_name: r.student_name, class_name: r.class_name, class_id: r.class_id, course_id: r.course_id,
      text: r.text, edited: r.edited, checked: r.checked, locked: r.locked, note: r.note, status: r.status,
      sent_at: r.sent_at, error: r.error, channel: r.channel, phone: r.phone,
      via: item.kakao ? (item.style === 'cushion' ? '알림톡 쿠션형' : '알림톡 기본형') : '문자',
      kakaoPreview: item.kakao ? renderTemplate((settings.kakao.templates || []).find((t) => t.templateId === item.kakao.templateId)?.text || '', vars, 'kakao') : '',
    };
  });
  return { kind, ref, generated: !!exists, list };
}

async function checkMessages(env, me, body) {
  if (body.set && typeof body.set === 'object') {
    // { set: { 메시지id: 1/0, ... } } — 화면에서 바꾼 체크 상태를 한 번에
    const on = [], off = [];
    for (const [id, v] of Object.entries(body.set)) (v ? on : off).push(Number(id));
    if (on.length) await checkMessages(env, me, { ids: on, checked: 1 });
    if (off.length) await checkMessages(env, me, { ids: off, checked: 0 });
    return { ok: true, saved_at: kstNow().stamp };
  }
  const vis = await visibleStudentIds(env, me);
  const ids = (body.ids || []).map(Number);
  const rows = await all(env, 'SELECT id, student_id FROM messages WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids));
  const ok = rows.filter((r) => !vis || vis.has(r.student_id)).map((r) => r.id);
  if (ok.length) await run(env, 'UPDATE messages SET checked = ?, user_set = 1 WHERE id IN (SELECT value FROM json_each(?))', body.checked ? 1 : 0, JSON.stringify(ok));
  return { ok: true, count: ok.length };
}

async function editMessage(env, me, body) {
  const m = await first(env, 'SELECT id, student_id FROM messages WHERE id = ?', Number(body.id));
  if (!m) throw bad('메시지를 찾을 수 없어요');
  const vis = await visibleStudentIds(env, me);
  if (vis && !vis.has(m.student_id)) throw new HttpError(403, '내 반 학생이 아니에요');
  await run(env, 'UPDATE messages SET text = ?, edited = 1, updated_at = ? WHERE id = ?', String(body.text || ''), kstNow().stamp, m.id);
  return { ok: true, saved_at: kstNow().stamp };
}

async function restoreMessage(env, me, body) {
  const m = await first(env, 'SELECT * FROM messages WHERE id = ?', Number(body.id));
  if (!m) throw bad('메시지를 찾을 수 없어요');
  const vis = await visibleStudentIds(env, me);
  if (vis && !vis.has(m.student_id)) throw new HttpError(403, '내 반 학생이 아니에요');
  await run(env, 'UPDATE messages SET edited = 0 WHERE id = ?', m.id);
  await generate(env, m.kind, m.ref);
  return { ok: true };
}

async function sendNow(env, me, body) {
  const vis = await visibleStudentIds(env, me);
  const rows = await all(env, 'SELECT id, student_id FROM messages WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify((body.ids || []).map(Number)));
  const ids = rows.filter((r) => !vis || vis.has(r.student_id)).map((r) => r.id);
  return sendMessages(env, ids, { resend: !!body.resend });
}

// ───────── 관리 (원장) ─────────
async function adminData(env) {
  const settings = await getSettings(env);
  const { director_pw, director_salt, ...safe } = settings;
  const teachers = await all(env, 'SELECT id, name, active, sort, (pw IS NOT NULL) AS has_pw FROM teachers ORDER BY active DESC, sort, name');
  const classes = await all(env, 'SELECT * FROM classes WHERE deleted = 0 ORDER BY sort, name');
  const students = await all(env, 'SELECT id, name, class_id, phone, course_id, curriculum_id, start_seq, code, msg_style FROM students WHERE deleted = 0 ORDER BY name');
  return {
    settings: safe, teachers, classes, students,
    solapi: solapiStatus(env), r2: r2Ready(env),
    defaults: { sms: DEFAULT_SMS, kakao: RECOMMENDED_KAKAO, kinds: KIND_LABELS, cushionLabels: CUSHION_LABELS, cushions: DEFAULT_SETTINGS.cushions },
  };
}

const SETTING_KEYS = new Set(['academy', 'base_url', 'director_phone', 'hw_buttons', 'reasons', 'schedule', 'att_alerts', 'sms_templates', 'cushions', 'kakao']);
async function saveSetting(env, body) {
  if (!SETTING_KEYS.has(body.key)) throw bad('바꿀 수 없는 설정이에요');
  let value = body.value;
  const warnings = [];
  if (body.key === 'sms_templates') {
    for (const [k, v] of Object.entries(value || {})) if (/#\{/.test(v)) warnings.push(`${KIND_LABELS[k] || k}: #{…} 칸은 알림톡용이에요. "발송 방식"의 알림톡 칸에 넣어 주세요.`);
  }
  if (body.key === 'kakao') {
    value = { pfId: String(value.pfId || '').trim(), style: value.style === 'cushion' ? 'cushion' : 'basic',
      templates: (value.templates || []).map((t) => ({ uid: t.uid || randomToken(8), kind: t.kind, style: t.style === 'cushion' ? 'cushion' : 'basic',
        templateId: String(t.templateId || '').trim(), text: String(t.text || '').replace(/\r/g, ''), approved: t.approved !== false })) };
  }
  await setSetting(env, body.key, value);
  return { ok: true, warnings };
}

async function saveTeacher(env, body) {
  if (body.delete) { await run(env, 'UPDATE teachers SET active = 0 WHERE id = ?', Number(body.id)); await run(env, 'DELETE FROM sessions WHERE teacher_id = ?', Number(body.id)); return { ok: true }; }
  const name = String(body.name || '').trim();
  if (!name) throw bad('이름을 적어 주세요');
  let id = Number(body.id) || 0;
  if (id) await run(env, 'UPDATE teachers SET name = ?, active = 1 WHERE id = ?', name, id);
  else id = (await run(env, 'INSERT INTO teachers (name) VALUES (?)', name)).meta.last_row_id;
  if (body.password) {
    if (String(body.password).length < 4) throw bad('비밀번호는 4자 이상으로 정해 주세요');
    const salt = randomToken(16);
    await run(env, 'UPDATE teachers SET pw = ?, salt = ? WHERE id = ?', await hashPassword(String(body.password), salt), salt, id);
    await run(env, 'DELETE FROM sessions WHERE teacher_id = ?', id);
  }
  return { ok: true, id };
}

async function saveDirectorPw(env, body) {
  if (String(body.password || '').length < 4) throw bad('비밀번호는 4자 이상으로 정해 주세요');
  const salt = randomToken(16);
  await setSetting(env, 'director_salt', salt);
  await setSetting(env, 'director_pw', await hashPassword(String(body.password), salt));
  return { ok: true };
}

async function saveCourse(env, body) {
  if (body.delete) { await run(env, 'UPDATE courses SET deleted = 1 WHERE id = ?', Number(body.id)); return { ok: true }; }
  const name = String(body.name || '').trim();
  if (!name) throw bad('과정 이름을 적어 주세요');
  if (body.id) { await run(env, 'UPDATE courses SET name = ?, sort = COALESCE(?, sort) WHERE id = ?', name, body.sort ?? null, Number(body.id)); return { ok: true, id: Number(body.id) }; }
  const max = await first(env, 'SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM courses');
  return { ok: true, id: (await run(env, 'INSERT INTO courses (name, sort) VALUES (?, ?)', name, max.n)).meta.last_row_id };
}

async function saveClass(env, body) {
  if (body.delete) { await run(env, 'UPDATE classes SET deleted = 1 WHERE id = ?', Number(body.id)); return { ok: true }; }
  const name = String(body.name || '').trim();
  if (!name) throw bad('반 이름을 적어 주세요');
  const vals = [name, body.type === 'individual' ? 'individual' : 'group', String(body.days || ''), String(body.time || ''), String(body.room || ''),
    body.teacher_id ? Number(body.teacher_id) : null, body.course_id ? Number(body.course_id) : null,
    body.curriculum_id ? Number(body.curriculum_id) : null, body.start_seq === '' || body.start_seq == null ? null : Number(body.start_seq)];
  if (body.id) {
    await run(env, 'UPDATE classes SET name=?, type=?, days=?, time=?, room=?, teacher_id=?, course_id=?, curriculum_id=?, start_seq=? WHERE id=?', ...vals, Number(body.id));
    return { ok: true, id: Number(body.id) };
  }
  return { ok: true, id: (await run(env, 'INSERT INTO classes (name, type, days, time, room, teacher_id, course_id, curriculum_id, start_seq) VALUES (?,?,?,?,?,?,?,?,?)', ...vals)).meta.last_row_id };
}

async function uniqueCode(env) {
  for (;;) {
    const code = randomToken(10);
    if (!(await first(env, 'SELECT id FROM students WHERE code = ?', code))) return code;
  }
}

async function saveStudent(env, body) {
  if (body.delete) { await run(env, 'UPDATE students SET deleted = 1 WHERE id = ?', Number(body.id)); return { ok: true }; }
  const name = String(body.name || '').trim();
  if (!name) throw bad('학생 이름을 적어 주세요');
  const phone = normPhone(body.phone);
  const cls = body.class_id ? await first(env, 'SELECT id, course_id FROM classes WHERE id = ?', Number(body.class_id)) : null;
  const vals = [name, cls ? cls.id : null, phone, body.course_id ? Number(body.course_id) : (cls ? cls.course_id : null),
    body.curriculum_id ? Number(body.curriculum_id) : null, body.start_seq === '' || body.start_seq == null ? null : Number(body.start_seq),
    ['basic', 'cushion'].includes(body.msg_style) ? body.msg_style : ''];
  if (body.id) {
    await run(env, 'UPDATE students SET name=?, class_id=?, phone=?, course_id=?, curriculum_id=?, start_seq=?, msg_style=? WHERE id=?', ...vals, Number(body.id));
    return { ok: true, id: Number(body.id) };
  }
  const code = await uniqueCode(env);
  return { ok: true, id: (await run(env, 'INSERT INTO students (name, class_id, phone, course_id, curriculum_id, start_seq, msg_style, code, created_at) VALUES (?,?,?,?,?,?,?,?,?)', ...vals, code, kstNow().stamp)).meta.last_row_id };
}

async function importStudents(env, body) {
  const rows = (body.rows || []).filter((r) => String(r.name || '').trim());
  const classes = await all(env, 'SELECT id, name, course_id FROM classes WHERE deleted = 0');
  const cMap = new Map(classes.map((c) => [c.name.replace(/\s+/g, ''), c]));
  const existing = await all(env, 'SELECT id, name FROM students WHERE deleted = 0');
  const sMap = new Map(existing.map((s) => [s.name.replace(/\s+/g, ''), s]));
  let added = 0, updated = 0, createdClasses = 0;
  for (const r of rows) {
    const name = String(r.name).trim();
    const cname = String(r.class || '').trim();
    let cls = cname ? cMap.get(cname.replace(/\s+/g, '')) : null;
    if (cname && !cls) {
      const id = (await run(env, "INSERT INTO classes (name, type, days) VALUES (?, 'group', '1,2,3,4,5')", cname)).meta.last_row_id;
      cls = { id, name: cname, course_id: null }; cMap.set(cname.replace(/\s+/g, ''), cls); createdClasses++;
    }
    const phone = normPhone(r.phone);
    const ex = sMap.get(name.replace(/\s+/g, ''));
    if (ex) {
      // 같은 이름이 이미 있으면 번호와 반만 바꾸기
      await run(env, 'UPDATE students SET phone = COALESCE(NULLIF(?, \'\'), phone), class_id = COALESCE(?, class_id) WHERE id = ?', phone, cls ? cls.id : null, ex.id);
      updated++;
    } else {
      const code = await uniqueCode(env);
      const id = (await run(env, 'INSERT INTO students (name, class_id, phone, course_id, code, created_at) VALUES (?, ?, ?, ?, ?, ?)', name, cls ? cls.id : null, phone, cls ? cls.course_id : null, code, kstNow().stamp)).meta.last_row_id;
      sMap.set(name.replace(/\s+/g, ''), { id, name }); added++;
    }
  }
  return { ok: true, added, updated, createdClasses };
}

async function saveCurriculum(env, body) {
  if (body.delete) { await run(env, 'UPDATE curricula SET deleted = 1 WHERE id = ?', Number(body.id)); return { ok: true }; }
  const name = String(body.name || '').trim();
  if (!name) throw bad('진도표 이름을 적어 주세요');
  const vals = [name, body.course_id ? Number(body.course_id) : null, body.cycle === false || body.cycle === 0 ? 0 : 1, kstNow().stamp];
  if (body.id) { await run(env, 'UPDATE curricula SET name=?, course_id=?, cycle=?, updated_at=? WHERE id=?', ...vals, Number(body.id)); return { ok: true, id: Number(body.id) }; }
  return { ok: true, id: (await run(env, 'INSERT INTO curricula (name, course_id, cycle, updated_at) VALUES (?,?,?,?)', ...vals)).meta.last_row_id };
}

async function importCurriculum(env, body) {
  let id = Number(body.curriculum_id) || 0;
  if (!id) id = (await saveCurriculum(env, { name: body.name, course_id: body.course_id, cycle: body.cycle !== false })).id;
  const lessons = (body.lessons || []).filter((l) => String(l.title || l.content || '').trim());
  if (!lessons.length) throw bad('읽은 차시가 없어요');
  const stmts = [];
  if (body.mode !== 'append') stmts.push(env.DB.prepare('DELETE FROM lessons WHERE curriculum_id = ?').bind(id));
  let base = 0;
  if (body.mode === 'append') base = (await first(env, 'SELECT COALESCE(MAX(seq), 0) AS m FROM lessons WHERE curriculum_id = ?', id)).m;
  lessons.forEach((l, i) => {
    const seq = l.seq != null && l.seq !== '' && !isNaN(Number(l.seq)) ? Number(l.seq) + (body.mode === 'append' && Number(l.seq) <= base ? base : 0) : base + i + 1;
    stmts.push(env.DB.prepare('INSERT INTO lessons (curriculum_id, seq, title, content, homework) VALUES (?, ?, ?, ?, ?)')
      .bind(id, seq, String(l.title || '').trim() || `${seq}차시`, String(l.content || '').trim(), String(l.homework || '').trim()));
  });
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  await run(env, 'UPDATE curricula SET updated_at = ? WHERE id = ?', kstNow().stamp, id);
  return { ok: true, id, count: lessons.length };
}

async function saveLesson(env, body) {
  if (body.delete) { await run(env, 'DELETE FROM lessons WHERE id = ?', Number(body.id)); return { ok: true }; }
  const seq = Number(body.seq);
  if (isNaN(seq)) throw bad('차시 번호는 숫자로 적어 주세요');
  const vals = [seq, String(body.title || '').trim(), String(body.content || ''), String(body.homework || '')];
  if (body.id) { await run(env, 'UPDATE lessons SET seq=?, title=?, content=?, homework=? WHERE id=?', ...vals, Number(body.id)); return { ok: true, id: Number(body.id) }; }
  return { ok: true, id: (await run(env, 'INSERT INTO lessons (seq, title, content, homework, curriculum_id) VALUES (?,?,?,?,?)', ...vals, Number(body.curriculum_id))).meta.last_row_id };
}

async function lessonsOf(env, url) {
  const id = Number(url.searchParams.get('curriculum_id'));
  const cur = await first(env, 'SELECT * FROM curricula WHERE id = ?', id);
  if (!cur) throw bad('진도표를 찾을 수 없어요');
  const lessons = await all(env, 'SELECT * FROM lessons WHERE curriculum_id = ? ORDER BY seq, id', id);
  const used = await all(env, `SELECT 'class' AS t, name FROM classes WHERE curriculum_id = ? AND deleted = 0
    UNION ALL SELECT 'student' AS t, name FROM students WHERE curriculum_id = ? AND deleted = 0`, id, id);
  return { curriculum: cur, lessons, used };
}

async function testSms(env, body) {
  const settings = await getSettings(env);
  const to = normPhone(body.phone || settings.director_phone || env.SOLAPI_SENDER);
  const text = `[${settings.academy || '수업 관리'}] 테스트 문자예요. 이 문자가 보이면 솔라피 연결이 잘 된 거예요.`;
  const r = (await sendBatch(env, [{ key: 't', to, text, kakao: null }])).get('t');
  return { ok: r.ok, error: r.error, to };
}

async function kakaoTest(env, body) {
  const settings = await getSettings(env);
  const t = (settings.kakao.templates || []).find((x) => x.uid === body.uid);
  if (!t) throw bad('먼저 저장해 주세요');
  if (!settings.kakao.pfId) throw bad('카카오 채널 ID(KA01PF…)를 먼저 넣어 주세요');
  const to = normPhone(body.phone || settings.director_phone || env.SOLAPI_SENDER);
  const sample = { 학원: settings.academy || '학원', 학생명: '홍길동', 반: '테스트반', 날짜: '11월 13일 (금)', 출석: '출석', 오늘할일: 'Unit 3 · 본문 읽기', 학습내용: '본문 읽기', 숙제: '워크북 12~13쪽', 다음수업: 'Unit 4', 지난숙제내용: '단어 암기', 지난숙제결과: '완료', 선생님한마디: '발표를 아주 잘했어요.', 학습성취: '발표를 아주 잘했어요.', 사진코드: 'test', 인사: '안녕하세요, 어머님!', 마무리: '감사합니다.', 출석멘트: '', 숙제멘트: '숙제를 꼼꼼하게 해 왔어요.', 주간멘트: '꾸준히 잘하고 있어요.', 기간: '11/10(월) ~ 11/13(목)', 대상월: '11월', 출석요약: '출석 4 · 지각 0 · 결석 0', 숙제완료율: '100% (미제출 0회)', 숙제현황: '100% (미제출 0회)', 진도: 'Unit 1 → Unit 4', 코멘트: '잘하고 있어요.', 보완사항: '특별히 보완할 점 없이 잘 해내고 있어요.', 다음학습계획: 'Unit 5' };
  const item = { key: 'k', to, text: renderTemplate(t.text, sample, 'kakao'), kakao: { pfId: settings.kakao.pfId, templateId: t.templateId, variables: kakaoVariables(t.text, sample) } };
  const r = (await sendBatch(env, [item])).get('k');
  return { ok: r.ok, channel: r.channel, error: r.error, to };
}

async function exportCsv(env, me, url) {
  const from = url.searchParams.get('from') || addDays(kstNow().date, -30);
  const to = url.searchParams.get('to') || kstNow().date;
  const days = await all(env, `SELECT d.*, s.name AS student_name, c.name AS class_name, c.type AS class_type, c.teacher_id
    FROM days d LEFT JOIN students s ON s.id = d.student_id LEFT JOIN classes c ON c.id = d.class_id
    WHERE d.date >= ? AND d.date <= ? ORDER BY d.date, c.name, s.name`, from, to);
  const logs = await all(env, 'SELECT * FROM logs WHERE date >= ? AND date <= ?', from, to);
  const lMap = new Map(logs.map((l) => [`${l.date}|${l.target}`, l]));
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['날짜', '반', '학생', '출결', '사유', '지난 숙제 결과', '오늘 할 일', '오늘 숙제', '다음 수업', '선생님 한마디'].map(q).join(',')];
  for (const d of days) {
    if (me.role === 'teacher' && d.teacher_id !== me.id) continue;
    const l = lMap.get(`${d.date}|${d.class_type === 'individual' ? 's' + d.student_id : 'c' + d.class_id}`) || {};
    lines.push([d.date, d.class_name, d.student_name, ATT_LABEL[d.att] || '', d.reason, HW_LABEL[d.hw] || '', l.today, l.homework, l.next, d.comment].map(q).join(','));
  }
  return new Response('﻿' + lines.join('\r\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`수업기록_${from}_${to}.csv`)}` },
  });
}

// ───────── 주소 연결 ─────────
export async function handleApi(request, env, ctx, url, version) {
  const path = url.pathname;
  const method = request.method;
  const body = method === 'POST' && (request.headers.get('content-type') || '').includes('json') ? await request.json().catch(() => ({})) : {};

  if (path === '/api/version') return json({ version });
  if (path === '/api/boot') return json(await boot(env, request, await getMe(env, request), version));
  if (path === '/api/setup' && method === 'POST') { const c = await setup(env, request, body); return json({ ok: true }, 200, { 'Set-Cookie': c }); }
  if (path === '/api/login' && method === 'POST') { const c = await login(env, request, body); return json({ ok: true }, 200, { 'Set-Cookie': c }); }
  if (path === '/api/logout') {
    const t = cookieOf(request, 'sid'); if (t) await run(env, 'DELETE FROM sessions WHERE token = ?', t);
    return json({ ok: true }, 200, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  }

  const me = await getMe(env, request);
  if (!me) throw new HttpError(401, '다시 로그인해 주세요');

  // 앱 주소 기억 (예약 발송 메시지 속 사진 링크용)
  if (!/localhost|127\.0\.0\.1/.test(url.host)) {
    const s = await first(env, "SELECT v FROM settings WHERE k = 'base_url'");
    const origin = url.origin;
    if (!s || JSON.parse(s.v) !== origin) await setSetting(env, 'base_url', origin);
  }

  const R = {
    'GET /api/meta': () => meta(env, me),
    'GET /api/today': () => today(env, me, url),
    'POST /api/attendance': () => saveAttendance(env, me, body, ctx),
    'POST /api/attendance/all': () => attendanceAll(env, me, body, ctx),
    'POST /api/record': () => saveRecord(env, me, body, ctx),
    'POST /api/student-curriculum': () => setStudentCurriculum(env, me, body),
    'GET /api/homework': () => homework(env, me, url),
    'GET /api/messages': () => listMessages(env, me, url),
    'POST /api/messages/generate': async () => { await generate(env, body.kind, body.ref); return { ok: true }; },
    'POST /api/messages/check': () => checkMessages(env, me, body),
    'POST /api/messages/edit': () => editMessage(env, me, body),
    'POST /api/messages/restore': () => restoreMessage(env, me, body),
    'POST /api/messages/send': () => sendNow(env, me, body),
    'GET /api/lessons': () => lessonsOf(env, url),
    'GET /api/media': async () => { await assertStudent(env, me, url.searchParams.get('student_id')); return { list: await mediaList(env, Number(url.searchParams.get('student_id')), url.searchParams.get('date')) }; },
    'POST /api/media/start': async () => { await assertStudent(env, me, body.student_id); return mediaStart(env, body); },
    'GET /api/admin': () => { directorOnly(me); return adminData(env); },
    'POST /api/admin/settings': () => { directorOnly(me); return saveSetting(env, body); },
    'POST /api/admin/director-password': () => { directorOnly(me); return saveDirectorPw(env, body); },
    'POST /api/admin/teacher': () => { directorOnly(me); return saveTeacher(env, body); },
    'POST /api/admin/course': () => { directorOnly(me); return saveCourse(env, body); },
    'POST /api/admin/class': () => { directorOnly(me); return saveClass(env, body); },
    'POST /api/admin/student': () => { directorOnly(me); return saveStudent(env, body); },
    'POST /api/admin/students/import': () => { directorOnly(me); return importStudents(env, body); },
    'POST /api/admin/curriculum': () => { directorOnly(me); return saveCurriculum(env, body); },
    'POST /api/admin/curriculum/import': () => { directorOnly(me); return importCurriculum(env, body); },
    'POST /api/admin/lesson': () => { directorOnly(me); return saveLesson(env, body); },
    'POST /api/admin/test-sms': () => { directorOnly(me); return testSms(env, body); },
    'POST /api/admin/kakao-test': () => { directorOnly(me); return kakaoTest(env, body); },
    'POST /api/admin/kakao-check': () => ({ fields: checkKakaoFields(body.text) }),
    'GET /api/admin/solapi': async () => {
      directorOnly(me);
      const st = solapiStatus(env);
      if (st.ready) { try { const b = await solapiBalance(env); st.balance = b.balance ?? b.cash ?? null; st.point = b.point ?? null; } catch (e) { st.error = e.message; } }
      return st;
    },
  };
  const key = `${method} ${path}`;
  if (R[key]) return json(await R[key]());

  if (path === '/api/export.csv') return exportCsv(env, me, url);

  let m;
  if ((m = path.match(/^\/api\/media\/(\d+)\/part$/)) && method === 'PUT') {
    const row = await first(env, 'SELECT student_id FROM media WHERE id = ?', Number(m[1]));
    if (!row) throw bad('업로드 정보를 찾을 수 없어요');
    await assertStudent(env, me, row.student_id);
    return json(await mediaPart(env, Number(m[1]), Number(url.searchParams.get('n') || 1), request));
  }
  if ((m = path.match(/^\/api\/media\/(\d+)\/complete$/)) && method === 'POST') {
    const row = await first(env, 'SELECT student_id FROM media WHERE id = ?', Number(m[1]));
    if (!row) throw bad('업로드 정보를 찾을 수 없어요');
    await assertStudent(env, me, row.student_id);
    const r = await mediaComplete(env, Number(m[1]), body);
    ctx.waitUntil(refreshIfExists(env, r.date).catch(() => {})); // 사진을 올리면 그 학생 미리보기도 바로 다시 만들기
    return json(r);
  }
  if ((m = path.match(/^\/api\/media\/(\d+)$/)) && method === 'DELETE') {
    const row = await first(env, 'SELECT student_id FROM media WHERE id = ?', Number(m[1]));
    if (row) await assertStudent(env, me, row.student_id);
    const r = await mediaDelete(env, Number(m[1]));
    if (r.date) ctx.waitUntil(refreshIfExists(env, r.date).catch(() => {}));
    return json(r);
  }
  throw new HttpError(404, '없는 주소예요');
}

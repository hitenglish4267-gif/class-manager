// 하루치 수업 정보 모으기 (오늘 수업 화면 + 메시지 만들기에서 함께 사용)

import { all } from './db.js';
import { dowOf } from './util.js';
import { loadCurricula, loadLogs, computeProgress, targetOf, assignOf } from './progress.js';

export function hasClassOn(cls, date) {
  const d = String(dowOf(date));
  return String(cls.days || '').split(',').map((s) => s.trim()).includes(d);
}

/**
 * opts: { teacherId (선생님이면 자기 반만), allDays (요일 상관없이), classId }
 */
export async function buildDay(env, date, opts = {}) {
  let classes = await all(env, 'SELECT * FROM classes WHERE deleted = 0 ORDER BY sort, name');
  if (opts.teacherId) classes = classes.filter((c) => c.teacher_id === opts.teacherId);
  if (opts.classId) classes = classes.filter((c) => c.id === Number(opts.classId));
  const classIds = classes.map((c) => c.id);
  const students = classIds.length
    ? await all(env, 'SELECT * FROM students WHERE deleted = 0 AND class_id IN (SELECT value FROM json_each(?)) ORDER BY name', JSON.stringify(classIds))
    : [];
  const days = await all(env, 'SELECT * FROM days WHERE date = ?', date);
  const dayMap = new Map(days.map((d) => [d.student_id, d]));

  if (!opts.allDays) {
    classes = classes.filter((c) => hasClassOn(c, date) || students.some((s) => s.class_id === c.id && dayMap.get(s.id)?.att));
  }
  const byClass = new Map(classes.map((c) => [c.id, { ...c, students: [] }]));
  for (const s of students) byClass.get(s.class_id)?.students.push(s);

  const targets = [];
  const curIds = [];
  for (const c of byClass.values()) {
    if (c.type === 'individual') {
      for (const s of c.students) { targets.push(targetOf(c, s)); curIds.push(s.curriculum_id); }
    } else { targets.push(targetOf(c)); curIds.push(c.curriculum_id); }
  }
  const curMap = await loadCurricula(env, curIds);
  const logs = targets.length ? await loadLogs(env, targets, date) : { today: new Map(), prev: new Map() };

  const mediaRows = students.length ? await all(env,
    "SELECT student_id, COUNT(*) AS n FROM media WHERE date = ? AND status = 'ready' GROUP BY student_id", date) : [];
  const mediaMap = new Map(mediaRows.map((r) => [r.student_id, r.n]));
  const msgRows = await all(env, "SELECT id, student_id, status, checked, sent_at, error, locked FROM messages WHERE kind = 'daily' AND ref = ?", date);
  const msgMap = new Map(msgRows.map((r) => [r.student_id, r]));
  const alertRows = await all(env, 'SELECT * FROM att_alerts WHERE date = ?', date);
  const alertMap = new Map(alertRows.map((r) => [r.student_id, r]));

  const out = [];
  for (const c of byClass.values()) {
    const cls = { ...c, progress: null };
    if (c.type !== 'individual') {
      const t = targetOf(c);
      cls.target = t;
      cls.progress = computeProgress(assignOf(c), curMap.get(c.curriculum_id), logs.today.get(t), logs.prev.get(t));
    }
    cls.students = c.students.map((s) => {
      const st = {
        id: s.id, name: s.name, phone: s.phone, code: s.code, msg_style: s.msg_style,
        curriculum_id: s.curriculum_id, start_seq: s.start_seq, course_id: s.course_id,
        day: dayMap.get(s.id) || { att: '', reason: '', hw: '', comment: '' },
        media: mediaMap.get(s.id) || 0,
        msg: msgMap.get(s.id) || null,
        alert: alertMap.get(s.id) || null,
      };
      if (c.type === 'individual') {
        const t = targetOf(c, s);
        st.target = t;
        st.progress = computeProgress(assignOf(c, s), curMap.get(s.curriculum_id), logs.today.get(t), logs.prev.get(t));
      }
      return st;
    });
    out.push(cls);
  }
  return { date, classes: out, curricula: curMap };
}

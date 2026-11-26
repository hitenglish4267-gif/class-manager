// 하루치 수업 정보 모으기 (오늘 수업 화면 + 메시지 만들기에서 함께 사용)

import { all } from './db.js';
import { dowOf, kstNow, addDays } from './util.js';
import { loadCurricula, loadLogs, targetOf, classTracks, studentTracks, isSolo, buildTracks, trackOnDefault } from './progress.js';

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

  // 오늘만 개별 수업으로 바꾼 학생
  const soloToday = new Set((await all(env, 'SELECT student_id FROM solo_days WHERE date = ?', date).catch(() => [])).map((r) => r.student_id));
  for (const s of students) { s.solo_today = soloToday.has(s.id) && !s.solo; }
  const targets = [];
  const curIds = [];
  for (const c of byClass.values()) {
    if (c.type !== 'individual') {
      c.trackDefs = classTracks(c);
      for (const t of c.trackDefs) { targets.push(t.target); curIds.push(t.curriculum_id); }
    }
    // 개별 진도 학생 (개별수업 반 전원 + 그룹 반에서 "개별 진도"로 바꾼 학생)
    for (const s of c.students) if (isSolo(c, s) || s.solo_today) {
      s.trackDefs = studentTracks(s);
      for (const t of s.trackDefs) { targets.push(t.target); curIds.push(t.curriculum_id); }
    }
  }
  const trackDays = new Map((await all(env, 'SELECT class_id, keys FROM track_days WHERE date = ?', date).catch(() => [])).map((r) => {
    let k = null; try { k = JSON.parse(r.keys); } catch { k = null; } return [r.class_id, Array.isArray(k) ? k.map(String) : null];
  }));
  const dow = dowOf(date);
  // 미리 적기 (오늘 이후 날짜): 오늘부터 그 전날까지 아직 기록이 없는 수업 날 수만큼 진도를 앞으로
  const todayKst = kstNow().date;
  const aheadFor = (classDays) => (date > todayKst ? (t, prevLog) => {
    let n = 0;
    let d = prevLog && prevLog.date >= todayKst ? addDays(prevLog.date, 1) : todayKst;
    for (; d < date; d = addDays(d, 1)) {
      const w = String(dowOf(d));
      if (String(classDays || '').split(',').map((x) => x.trim()).includes(w) && trackOnDefault(t, w)) n++;
    }
    return n;
  } : null);
  const curMap = await loadCurricula(env, curIds);
  const logs = targets.length ? await loadLogs(env, targets, date) : { today: new Map(), prev: new Map() };

  const mediaRows = students.length ? await all(env,
    "SELECT student_id, COUNT(*) AS n FROM media WHERE date = ? AND status = 'ready' GROUP BY student_id", date) : [];
  const mediaMap = new Map(mediaRows.map((r) => [r.student_id, r.n]));
  const msgRows = await all(env, "SELECT id, student_id, status, checked, sent_at, error, locked FROM messages WHERE kind = 'daily' AND ref = ?", date);
  const msgMap = new Map(msgRows.map((r) => [r.student_id, r]));
  const testRows = await all(env, 'SELECT * FROM tests WHERE date = ? ORDER BY kind', date);
  const testMap = new Map();
  for (const t of testRows) { if (!testMap.has(t.student_id)) testMap.set(t.student_id, []); testMap.get(t.student_id).push({ kind: t.kind, correct: t.correct, total: t.total, result: t.result }); }
  const alertRows = await all(env, 'SELECT * FROM att_alerts WHERE date = ?', date);
  const alertMap = new Map(alertRows.map((r) => [r.student_id, r]));

  const out = [];
  for (const c of byClass.values()) {
    const cls = { ...c, progress: null };
    if (c.type !== 'individual') {
      cls.target = targetOf(c);
      const b = buildTracks(c.trackDefs, trackDays.get(c.id), logs, curMap, dow, aheadFor(c.days));
      cls.tracks = b.tracks; cls.progress = b.progress;
      delete cls.trackDefs;
    }
    cls.students = c.students.map((s) => {
      const st = {
        id: s.id, name: s.name, phone: s.phone, code: s.code, msg_style: s.msg_style,
        curriculum_id: s.curriculum_id, start_seq: s.start_seq, course_id: s.course_id, solo: isSolo(c, s) || !!s.solo_today, solo_today: !!s.solo_today,
        day: dayMap.get(s.id) || { att: '', reason: '', hw: '', comment: '' },
        tests: testMap.get(s.id) || [],
        media: mediaMap.get(s.id) || 0,
        msg: msgMap.get(s.id) || null,
        alert: alertMap.get(s.id) || null,
      };
      if (st.solo) {
        st.target = targetOf({ type: 'individual' }, s);
        // 학생별 요일 바꿈은 track_days에 class_id = -학생번호로 저장
        const b = buildTracks(s.trackDefs, trackDays.get(-s.id), logs, curMap, dow, s.solo_today ? null : aheadFor(c.days));
        st.tracks = b.tracks; st.progress = b.progress;
        // 오늘만 개별이면, 지난 수업·숙제는 반 수업과 개별 수업 중 더 최근 것으로
        if (s.solo_today && cls.progress && (cls.progress.prevDate || '') > (st.progress.prevDate || '')) {
          for (const k of ['prevDate', 'prevHomework', 'prevToday']) { st.progress[k] = cls.progress[k]; for (const t of st.tracks) t.progress[k] = cls.progress[k]; }
        }
      }
      return st;
    });
    out.push(cls);
  }
  return { date, classes: out, curricula: curMap };
}

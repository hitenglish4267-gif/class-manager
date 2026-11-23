// 하루치 수업 정보 모으기 (오늘 수업 화면 + 메시지 만들기에서 함께 사용)

import { all } from './db.js';
import { dowOf } from './util.js';
import { loadCurricula, loadLogs, computeProgress, targetOf, classTracks, studentTracks, trackOnDefault, combineProgress } from './progress.js';

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
      for (const s of c.students) { s.trackDefs = studentTracks(s); for (const t of s.trackDefs) { targets.push(t.target); curIds.push(t.curriculum_id); } }
    } else {
      c.trackDefs = classTracks(c);
      for (const t of c.trackDefs) { targets.push(t.target); curIds.push(t.curriculum_id); }
    }
  }
  const trackDays = new Map((await all(env, 'SELECT class_id, keys FROM track_days WHERE date = ?', date).catch(() => [])).map((r) => {
    let k = null; try { k = JSON.parse(r.keys); } catch { k = null; } return [r.class_id, Array.isArray(k) ? k.map(String) : null];
  }));
  const stuDays = new Map((await all(env, 'SELECT student_id, keys FROM stu_track_days WHERE date = ?', date).catch(() => [])).map((r) => {
    let k = null; try { k = JSON.parse(r.keys); } catch { k = null; } return [r.student_id, Array.isArray(k) ? k.map(String) : null];
  }));
  const dow = dowOf(date);
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
      Object.assign(cls, resolveTracks(c.trackDefs, trackDays.get(c.id), logs, curMap, dow));
      delete cls.trackDefs;
    }
    cls.students = c.students.map((s) => {
      const st = {
        id: s.id, name: s.name, phone: s.phone, code: s.code, msg_style: s.msg_style,
        curriculum_id: s.curriculum_id, start_seq: s.start_seq, course_id: s.course_id,
        day: dayMap.get(s.id) || { att: '', reason: '', hw: '', comment: '' },
        tests: testMap.get(s.id) || [],
        media: mediaMap.get(s.id) || 0,
        msg: msgMap.get(s.id) || null,
        alert: alertMap.get(s.id) || null,
      };
      if (c.type === 'individual') {
        st.target = targetOf(c, s);
        st.tracks_raw = s.tracks || '';
        st.cur_days = s.cur_days || '';
        Object.assign(st, resolveTracks(s.trackDefs, stuDays.get(s.id), logs, curMap, dow));
      }
      return st;
    });
    out.push(cls);
  }
  return { date, classes: out, curricula: curMap };
}

/** 진도표 여러 개(반 또는 개별 학생)를 오늘 날짜로 풀기 → { tracks, progress } */
function resolveTracks(defs, override, logs, curMap, dow) {
  const tracks = defs.map((t) => {
    const cur = curMap.get(t.curriculum_id);
    const on = override ? override.includes(t.key) : (logs.today.has(t.target) || trackOnDefault(t, dow));
    return { key: t.key, target: t.target, curriculum_id: t.curriculum_id, name: t.free ? '추가 학습' : cur ? cur.name : '', days: t.days, free: !!t.free, on,
      progress: computeProgress({ curriculum_id: t.curriculum_id, start_seq: t.start_seq }, cur, logs.today.get(t.target), logs.prev.get(t.target)) };
  });
  const progress = combineProgress(tracks, (id) => (curMap.get(id) || {}).name);
  // 지난 숙제·지난 수업: 가장 최근 수업 날 기록 (어느 진도표든)
  const prevs = tracks.map((t) => logs.prev.get(t.target)).filter(Boolean);
  const lastDate = prevs.map((l) => l.date).sort().pop();
  const label = (l) => { const t = tracks.find((x) => x.target === l.target); return t ? t.name || '수업' : '수업'; };
  const lastHw = prevs.filter((l) => l.date === lastDate && String(l.homework || '').trim());
  progress.prevDate = lastDate || null;
  progress.prevHomework = lastHw.length > 1 ? lastHw.map((l) => `[${label(l)}] ${l.homework}`).join(' / ') : lastHw[0] ? lastHw[0].homework : '';
  const lastLogs = prevs.filter((l) => l.date === lastDate && String(l.today || '').trim());
  progress.prevToday = lastLogs.map((l) => `${lastLogs.length > 1 ? `[${label(l)}] ` : ''}${String(l.today).replace(/\s*\n+\s*/g, ' / ')}${l.repeat ? ' (다시 하기로 함)' : ''}`).join(' / ');
  for (const t of tracks) { t.progress.prevHomework = progress.prevHomework; t.progress.prevToday = progress.prevToday; t.progress.prevDate = progress.prevDate; }
  return { tracks, progress };
}

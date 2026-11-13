// 진도 계산: 오늘 어떤 차시를 할지 자동으로 정하기

import { all } from './db.js';

export async function loadCurricula(env, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const curs = await all(env, 'SELECT id, name, course_id, cycle FROM curricula WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(list));
  const lessons = await all(env, 'SELECT id, curriculum_id, seq, title, content, homework FROM lessons WHERE curriculum_id IN (SELECT value FROM json_each(?)) ORDER BY curriculum_id, seq, id', JSON.stringify(list));
  for (const c of curs) map.set(c.id, { ...c, lessons: [] });
  for (const l of lessons) map.get(l.curriculum_id)?.lessons.push(l);
  return map;
}

export function lessonAfter(cur, seq) {
  const L = cur?.lessons || [];
  const n = L.find((l) => l.seq > seq);
  if (n) return n;
  return cur && cur.cycle && L.length ? L[0] : null;
}
export function lessonFrom(cur, startSeq) {
  const L = cur?.lessons || [];
  if (startSeq == null || startSeq === '') return L[0] || null;
  return L.find((l) => l.seq >= Number(startSeq)) || L[0] || null;
}

export function oneLine(s) { return String(s || '').replace(/\s*\n+\s*/g, ' / ').trim(); }

export function todayText(lesson) {
  if (!lesson) return '';
  const c = oneLine(lesson.content);
  return c ? `${lesson.title} · ${c}` : lesson.title || '';
}
export function nextText(lesson) { return lesson ? lesson.title || '' : ''; }

/**
 * assign = { curriculum_id, start_seq }
 * todayLog = 오늘 저장된 기록 (있으면 그대로)
 * prevLog = 오늘 전 가장 최근 기록
 */
export function computeProgress(assign, cur, todayLog, prevLog) {
  const prevHomework = prevLog ? prevLog.homework || '' : '';
  const prevDate = prevLog ? prevLog.date : null;
  if (todayLog) {
    const lesson = cur?.lessons.find((l) => l.id === todayLog.lesson_id) || null;
    return {
      saved: true, curriculum_id: todayLog.curriculum_id, lesson_id: todayLog.lesson_id,
      seq: todayLog.seq, today: todayLog.today || '', next: todayLog.next || '', homework: todayLog.homework || '',
      repeat: todayLog.repeat ? 1 : 0, content: lesson ? lesson.content || '' : '', prevHomework, prevDate, ended: false,
    };
  }
  let lesson = null;
  if (cur) {
    if (prevLog && prevLog.curriculum_id === cur.id) {
      const base = cur.lessons.find((l) => l.id === prevLog.lesson_id)
        || cur.lessons.find((l) => l.seq === prevLog.seq) || null;
      if (base) lesson = prevLog.repeat ? base : lessonAfter(cur, base.seq);
      else if (prevLog.seq != null) {
        // 차시가 지워졌거나 진도표를 새로 올린 경우: 번호로 이어 가기
        lesson = prevLog.repeat ? (cur.lessons.find((l) => l.seq >= prevLog.seq) || lessonAfter(cur, prevLog.seq)) : lessonAfter(cur, prevLog.seq);
      } else lesson = lessonFrom(cur, assign.start_seq);
    } else {
      lesson = lessonFrom(cur, assign.start_seq);
    }
  }
  const nxt = lesson ? lessonAfter(cur, lesson.seq) : null;
  return {
    saved: false, curriculum_id: cur ? cur.id : null, lesson_id: lesson ? lesson.id : null, seq: lesson ? lesson.seq : null,
    today: todayText(lesson), next: nextText(nxt), homework: lesson ? lesson.homework || '' : '', repeat: 0,
    content: lesson ? lesson.content || '' : '', prevHomework, prevDate,
    ended: !!(cur && cur.lessons.length && !lesson),
  };
}

/** 반/학생 목록에서 대상(target)별 오늘 기록 + 직전 기록 가져오기 */
export async function loadLogs(env, targets, date) {
  const list = JSON.stringify([...new Set(targets)]);
  const today = await all(env, 'SELECT * FROM logs WHERE date = ? AND target IN (SELECT value FROM json_each(?))', date, list);
  const prev = await all(env, `SELECT l.* FROM logs l JOIN (
      SELECT target, MAX(date) AS d FROM logs WHERE date < ? AND target IN (SELECT value FROM json_each(?)) GROUP BY target
    ) m ON l.target = m.target AND l.date = m.d`, date, list);
  return { today: new Map(today.map((r) => [r.target, r])), prev: new Map(prev.map((r) => [r.target, r])) };
}

export function targetOf(cls, student) {
  return cls && cls.type === 'individual' && student ? `s${student.id}` : `c${cls ? cls.id : 0}`;
}
export function assignOf(cls, student) {
  if (cls && cls.type === 'individual' && student) return { curriculum_id: student.curriculum_id, start_seq: student.start_seq };
  return { curriculum_id: cls ? cls.curriculum_id : null, start_seq: cls ? cls.start_seq : null };
}

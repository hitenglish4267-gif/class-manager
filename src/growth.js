// AI 주간 성장 리포트
// - 선생님이 매 수업 누르는 학습 평가(8가지 버튼) + 기존 출결·숙제·시험·진도 기록을 한 주 단위로 모으고
// - Cloudflare Workers AI(무료 사용량 안)로 학부모용 리포트 문장을 쓰고
// - AI를 쓸 수 없을 때는 기록만으로 규칙에 따라 쓰고 "자동 정리"라고 표시해요 (AI가 쓴 척하지 않기)
// 점수·진도·출결 같은 사실은 AI가 아니라 기록에서 바로 넣어요. AI는 문장만 써요.

import { all, first, run, getSettings } from './db.js';
import { addDays, dateShort, dowOf, kstNow, randomToken } from './util.js';
import { oneLine } from './progress.js';
import { DEFAULT_EVAL, DEFAULT_GROWTH } from './defaults.js';

export { DEFAULT_EVAL, DEFAULT_GROWTH };

// ───────── 평가 버튼 8가지 ─────────
export const EVAL_MARKS = [
  { id: 'vg', label: '매우 잘함', cat: 'strength' },
  { id: 'g', label: '잘함', cat: 'strength' },
  { id: 'up', label: '향상 중', cat: 'growth' },
  { id: 'rep', label: '반복 연습 필요', cat: 'practice' },
  { id: 'con', label: '개념 확인 필요', cat: 'concept' },
  { id: 'ind', label: '개별 지도 필요', cat: 'individual' },
  { id: 'rev', label: '복습 진행', cat: 'review' },
  { id: 'hold', label: '진도 보류', cat: 'hold' },
];
const MARK = new Map(EVAL_MARKS.map((m) => [m.id, m]));
const POSITIVE = new Set(['vg', 'g', 'up']);

const FALLBACK_MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'];

export const NOTE_FIELDS = [
  ['done', '실제 완료한 진도'],
  ['next_plan', '다음 수업 예정 진도'],
  ['retest', '재시험 결과'],
  ['mistakes', '오답 · 반복되는 실수'],
  ['weak', '이해가 부족한 개념'],
  ['extra_done', '추가 지도한 내용'],
  ['extra_need', '추가 지도가 필요한 내용'],
  ['special', '선생님 특별 코멘트 (주간 리포트에 우선 반영)'],
  ['memo', '메모'],
];
const NOTE_KEYS = NOTE_FIELDS.map(([k]) => k);

export function evalSettings(settings) {
  const e = settings.eval || {};
  return { items: Array.isArray(e.items) && e.items.length ? e.items : DEFAULT_EVAL.items, byClass: e.byClass || {} };
}
export function growthSettings(settings) { return { ...DEFAULT_GROWTH, ...(settings.growth || {}) }; }
export function itemsForClass(settings, classId) {
  const { items, byClass } = evalSettings(settings);
  const ids = byClass[String(classId)];
  return Array.isArray(ids) && ids.length ? items.filter((i) => ids.includes(i.id)) : items;
}

// ───────── 주(週) 계산: 기준일(토요일)의 월~금 ─────────
export function saturdayOf(date) {
  const d = dowOf(date);
  return d === 0 ? addDays(date, -1) : addDays(date, 6 - d);
}
export function weekOf(ref) {
  const sat = saturdayOf(ref);
  return { ref: sat, from: addDays(sat, -5), to: addDays(sat, -1) };
}

// ───────── 한 주 사실 모으기 ─────────
function targetFor(classType, classId, studentId) { return classType === 'individual' ? `s${studentId}` : `c${classId}`; }
const pct = (c, t) => (t ? Math.round((c / t) * 100) : null);
const fmt = (n) => (n == null || n === '' ? '' : String(+Number(n).toFixed(1)));

async function rangeData(env, from, to) {
  const [days, tests, evals, notes, logs, media] = await Promise.all([
    all(env, 'SELECT * FROM days WHERE date >= ? AND date <= ? ORDER BY date', from, to),
    all(env, 'SELECT * FROM tests WHERE date >= ? AND date <= ? ORDER BY date, kind', from, to),
    all(env, 'SELECT * FROM evals WHERE date >= ? AND date <= ? ORDER BY date', from, to),
    all(env, 'SELECT * FROM daynotes WHERE date >= ? AND date <= ? ORDER BY date', from, to),
    all(env, 'SELECT * FROM logs WHERE date >= ? AND date <= ? ORDER BY date', from, to),
    all(env, "SELECT student_id, token, kind, date FROM media WHERE date >= ? AND date <= ? AND status = 'ready' ORDER BY date, id", from, to),
  ]);
  const by = (rows, key = 'student_id') => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; };
  return { days: by(days), tests: by(tests), evals: by(evals), notes: by(notes), media: by(media), logs: new Map(logs.map((l) => [`${l.date}|${l.target}`, l])) };
}

function evalSummary(rows, itemName) {
  const out = new Map(); // item id → { name, counts: {mark: n}, days }
  for (const r of rows || []) {
    let marks = []; try { marks = JSON.parse(r.marks || '[]'); } catch { /* */ }
    if (!marks.length) continue;
    if (!out.has(r.item)) out.set(r.item, { id: r.item, name: itemName(r.item), counts: {}, days: 0 });
    const o = out.get(r.item); o.days++;
    for (const m of marks) if (MARK.has(m)) o.counts[m] = (o.counts[m] || 0) + 1;
  }
  return [...out.values()].filter((o) => o.name);
}

function testSummary(rows) {
  const byKind = new Map();
  for (const t of rows || []) {
    if (t.correct == null && !t.result) continue;
    if (!byKind.has(t.kind)) byKind.set(t.kind, []);
    byKind.get(t.kind).push(t);
  }
  const kinds = [];
  for (const [kind, arr] of byKind) {
    const scored = arr.filter((t) => t.correct != null && t.total);
    const avg = scored.length ? Math.round(scored.reduce((a, t) => a + (t.correct / t.total) * 100, 0) / scored.length) : null;
    kinds.push({ kind, count: arr.length, avg, retests: arr.filter((t) => t.result === 'retest').length });
  }
  return kinds;
}

/** 학생 한 명의 한 주 사실 (리포트의 숫자·진도는 전부 여기서) */
export function buildFacts(settings, s, cur, prev, period) {
  const { items } = evalSettings(settings);
  const nameOf = (id) => (items.find((i) => i.id === id) || {}).name || '';
  const groupOf = (id) => (items.find((i) => i.id === id) || {}).group || 'area';
  const days = cur.days.get(s.id) || [];
  const pDays = prev.days.get(s.id) || [];
  const cnt = { present: 0, late: 0, absent: 0, done: 0, partial: 0, missing: 0 };
  for (const d of days) { if (d.att in cnt) cnt[d.att]++; if (d.hw in cnt) cnt[d.hw]++; }
  const hwTotal = cnt.done + cnt.partial + cnt.missing;
  const pc = { done: 0, total: 0 };
  for (const d of pDays) if (['done', 'partial', 'missing'].includes(d.hw)) { pc.total++; if (d.hw === 'done') pc.done++; }

  const notes = new Map((cur.notes.get(s.id) || []).map((n) => [n.date, n]));
  const progress = [];
  for (const d of days) {
    if (!(d.att === 'present' || d.att === 'late')) continue;
    const log = cur.logs.get(`${d.date}|${targetFor(s.class_type, d.class_id, s.id)}`);
    const n = notes.get(d.date) || {};
    if (!log && !n.done) continue;
    const planned = log ? oneLine(log.today) : '';
    progress.push({ date: d.date, book: log ? log.book || '' : '', planned, done: n.done || planned, changed: !!(n.done && planned && n.done !== planned), homework: log ? oneLine(log.homework) : '' });
  }
  for (const n of notes.values()) if (n.done && !progress.some((p) => p.date === n.date)) progress.push({ date: n.date, book: '', planned: '', done: n.done, changed: false, homework: '' });
  progress.sort((a, b) => a.date.localeCompare(b.date));
  const lastNote = [...notes.values()].filter((n) => n.next_plan).pop();
  const lastLog = [...days].reverse().map((d) => cur.logs.get(`${d.date}|${targetFor(s.class_type, d.class_id, s.id)}`)).find(Boolean);
  const nextPlan = lastNote ? lastNote.next_plan : lastLog ? (lastLog.repeat ? oneLine(lastLog.today) : oneLine(lastLog.next)) : '';

  const testsNow = (cur.tests.get(s.id) || []).filter((t) => t.correct != null || t.result).map((t) => ({
    date: t.date, kind: t.kind, score: t.correct != null && t.total ? `${fmt(t.correct)}/${fmt(t.total)}` : t.correct != null ? `${fmt(t.correct)}점` : '',
    pct: t.correct != null && t.total ? Math.round((t.correct / t.total) * 100) : null, result: t.result === 'good' ? '통과' : t.result === 'retest' ? '재시험' : '',
  }));
  const tNow = testSummary(cur.tests.get(s.id));
  const tPrev = testSummary(prev.tests.get(s.id));
  const testKinds = tNow.map((k) => { const p = tPrev.find((x) => x.kind === k.kind); return { ...k, prevAvg: p ? p.avg : null, change: p && p.avg != null && k.avg != null ? k.avg - p.avg : null }; });
  const scored = testsNow.filter((t) => t.pct != null);
  const prevScored = (prev.tests.get(s.id) || []).filter((t) => t.correct != null && t.total);

  const evNow = evalSummary(cur.evals.get(s.id), nameOf);
  const evPrev = evalSummary(prev.evals.get(s.id), nameOf);
  const cats = { strength: [], growth: [], practice: [], concept: [], individual: [], review: [], hold: [] };
  for (const e of evNow) for (const [m, n] of Object.entries(e.counts)) { const c = MARK.get(m).cat; if (!cats[c].includes(e.name)) cats[c].push(e.name); void n; }
  const areas = evNow.map((e) => {
    const p = evPrev.find((x) => x.id === e.id);
    const score = (o) => { const t = Object.values(o.counts).reduce((a, b) => a + b, 0); const g = Object.entries(o.counts).filter(([m]) => POSITIVE.has(m)).reduce((a, [, b]) => a + b, 0); return t ? g / t : null; };
    const now = score(e), before = p ? score(p) : null;
    return {
      name: e.name, group: groupOf(e.id), days: e.days,
      marks: Object.entries(e.counts).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${MARK.get(m).label}${n > 1 ? ` ${n}회` : ''}`),
      trend: now != null && before != null ? (now - before > 0.15 ? '상승' : before - now > 0.15 ? '하락' : '유지') : '',
    };
  });

  const pick = (k) => [...notes.values()].filter((n) => n[k]).map((n) => ({ date: n.date, text: String(n[k]).trim() }));
  const comments = days.filter((d) => String(d.comment || '').trim()).map((d) => ({ date: d.date, text: String(d.comment).trim() }));
  // 같은 실수가 여러 날 반복되면 표시
  const mistakes = pick('mistakes');
  const prevNotes = prev.notes.get(s.id) || [];
  const media = (cur.media.get(s.id) || []).filter((m) => m.kind === 'image').slice(0, 6).map((m) => m.token);

  return {
    student: s.name, class_name: s.class_name || '', teacher: s.teacher_name || '',
    period: { from: period.from, to: period.to, label: `${dateShort(period.from)} ~ ${dateShort(period.to)}` },
    attendance: { present: cnt.present, late: cnt.late, absent: cnt.absent },
    books: [...new Set(progress.map((p) => p.book).filter(Boolean))],
    progress, next_plan: nextPlan,
    progress_rate: progress.length ? pct(progress.filter((p) => !p.changed).length, progress.length) : null,
    tests: testsNow, test_kinds: testKinds,
    test_avg: scored.length ? Math.round(scored.reduce((a, t) => a + t.pct, 0) / scored.length) : null,
    prev_test_avg: prevScored.length ? Math.round(prevScored.reduce((a, t) => a + (t.correct / t.total) * 100, 0) / prevScored.length) : null,
    retests: pick('retest'),
    homework: { done: cnt.done, partial: cnt.partial, missing: cnt.missing, rate: pct(cnt.done, hwTotal), prev_rate: pct(pc.done, pc.total) },
    areas, categories: cats,
    notes: { mistakes, weak: pick('weak'), extra_done: pick('extra_done'), extra_need: pick('extra_need'), special: pick('special'), comments },
    prev_notes: { mistakes: prevNotes.filter((n) => n.mistakes).map((n) => String(n.mistakes).trim()), extra_need: prevNotes.filter((n) => n.extra_need).map((n) => String(n.extra_need).trim()) },
    media,
  };
}

function hasData(f) {
  return f.progress.length || f.tests.length || f.areas.length || f.attendance.present + f.attendance.late + f.attendance.absent
    || Object.values(f.notes).some((a) => a.length);
}

/** 리포트 행을 만들거나 사실만 최신으로 (AI 문장은 그대로) */
export async function ensureReports(env, settings, ref) {
  const w = weekOf(ref);
  const prevW = { from: addDays(w.from, -7), to: addDays(w.to, -7) };
  const [cur, prev] = await Promise.all([rangeData(env, w.from, w.to), rangeData(env, prevW.from, prevW.to)]);
  // 진도 기록에 교재 이름 붙이기
  const curNames = new Map((await all(env, 'SELECT id, name FROM curricula')).map((c) => [c.id, c.name]));
  for (const l of cur.logs.values()) l.book = curNames.get(l.curriculum_id) || '';
  const students = await all(env, `SELECT s.*, c.name AS class_name, c.type AS class_type, t.name AS teacher_name FROM students s
    LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN teachers t ON t.id = c.teacher_id WHERE s.deleted = 0`);
  const existing = new Map((await all(env, "SELECT * FROM reports WHERE kind = 'weekly' AND ref = ?", w.ref)).map((r) => [r.student_id, r]));
  const now = kstNow().stamp;
  const stmts = [];
  for (const s of students) {
    const facts = buildFacts(settings, s, cur, prev, w);
    const ex = existing.get(s.id);
    if (!hasData(facts)) continue;
    const fj = JSON.stringify(facts);
    if (!ex) {
      stmts.push(env.DB.prepare(`INSERT INTO reports (kind, ref, student_id, token, facts, status, tries, created_at, updated_at)
        VALUES ('weekly', ?, ?, ?, ?, 'queued', 0, ?, ?) ON CONFLICT(kind, ref, student_id) DO NOTHING`).bind(w.ref, s.id, randomToken(24), fj, now, now));
    } else if (ex.facts !== fj) {
      stmts.push(env.DB.prepare('UPDATE reports SET facts = ?, updated_at = ? WHERE id = ?').bind(fj, now, ex.id));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return w;
}

// ───────── AI로 문장 쓰기 ─────────
const SECTION_KEYS = ['overview', 'concepts', 'strengths', 'growth', 'practice', 'weak_concepts', 'academy_done', 'academy_plan', 'next_week', 'home_tips', 'teacher_comment'];
const LIST_KEYS = new Set(['strengths', 'growth', 'practice', 'weak_concepts', 'academy_done', 'academy_plan', 'home_tips']);

const SYSTEM = `당신은 초등·중등 영어학원의 경험 많은 영어 전문 선생님입니다. 학부모에게 보내는 주간 성장 리포트의 문장을 씁니다.
반드시 지킬 규칙:
- 아래 JSON 기록에 있는 사실만 씁니다. 기록에 없는 점수, 진도, 사건, 칭찬 사례를 절대 지어내지 않습니다.
- 기록이 없는 항목은 빈 배열 [] 또는 빈 문자열 ""로 둡니다. 억지로 채우지 않습니다.
- 다른 학생과 비교하지 않습니다. 이 학생의 지난주 기록(prev_*, change, trend)과 비교해 성장 중심으로 씁니다.
- 추상적인 칭찬 대신 기록에 있는 구체적인 학습 항목·날짜·시험을 근거로 씁니다.
- 부족한 부분은 지적만 하지 않고, 학원에서 할 구체적인 지도 계획을 함께 씁니다.
- 학부모가 불안해할 표현은 피하되 학습 상태는 정확하게 전합니다.
- notes.special(선생님 특별 코멘트)이 있으면 그 내용을 teacher_comment에 가장 먼저, 뜻을 바꾸지 않고 반영합니다.
- academy_done에는 이번 주 학원에서 실제로 한 지도(notes.extra_done, '복습 진행' 등 기록)만, academy_plan에는 앞으로 할 지도 계획(notes.extra_need, '개별 지도 필요', '반복 연습 필요', '개념 확인 필요', '진도 보류' 기록 바탕)을 나눠 씁니다.
- 과장된 칭찬, 형식적인 인사말, 이모지를 쓰지 않습니다. 따뜻하고 자연스러운 존댓말("~했어요", "~하고 있어요")로 씁니다.
- 각 문장은 짧게, 목록 항목은 1~2문장으로 씁니다. 학생 이름은 overview에서만 한 번 부릅니다.
출력은 설명 없이 JSON 하나만:
{"overview":"수업 이해도, 계획한 진도를 잘 따라가는지, 수업 태도와 과제 수행 2~3문장","concepts":"이번 주 주요 학습 개념 1~2문장","strengths":[],"growth":[],"practice":[],"weak_concepts":[],"academy_done":[],"academy_plan":[],"next_week":"다음 주 학습 예정 1~2문장","home_tips":[],"teacher_comment":""}`;

function factsForAi(f) {
  // 사진 토큰 등 AI에 필요 없는 값은 빼서 사용량 줄이기
  const { media, ...rest } = f; void media;
  return rest;
}

function parseJson(text) {
  if (text && typeof text === 'object') return text;
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI 답에서 JSON을 찾지 못했어요');
  return JSON.parse(t.slice(a, b + 1));
}

export function cleanContent(o) {
  const out = {};
  const str = (v, max) => String(v == null ? '' : v).replace(/\s+\n/g, '\n').trim().slice(0, max);
  for (const k of SECTION_KEYS) {
    if (LIST_KEYS.has(k)) out[k] = (Array.isArray(o[k]) ? o[k] : o[k] ? [o[k]] : []).map((x) => str(typeof x === 'object' ? Object.values(x).join(' ') : x, 300)).filter(Boolean).slice(0, 6);
    else out[k] = str(o[k], 700);
  }
  return out;
}

async function aiWrite(env, settings, facts) {
  if (!env.AI) throw new Error('Workers AI가 연결되지 않았어요 (wrangler.toml의 [ai] 설정 확인)');
  const g = growthSettings(settings);
  const models = [g.model, ...FALLBACK_MODELS.filter((m) => m !== g.model)];
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: `기록(JSON):\n${JSON.stringify(factsForAi(facts))}` }];
  let lastErr = null;
  for (const model of models) {
    try {
      const r = await env.AI.run(model, { messages, max_tokens: 2000, temperature: 0.5 });
      const text = typeof r === 'string' ? r : r?.response ?? r?.choices?.[0]?.message?.content ?? r?.result?.response;
      const content = cleanContent(parseJson(text));
      if (!content.overview && !content.strengths.length) throw new Error('AI 답이 비어 있어요');
      // 선생님이 직접 쓴 특별 코멘트는 AI가 빠뜨려도 그대로 맨 앞에
      const special = (facts.notes?.special || []).map((x) => x.text).filter(Boolean).join(' ');
      if (special && !content.teacher_comment.includes(special.slice(0, 15))) content.teacher_comment = [special, content.teacher_comment].filter(Boolean).join('\n');
      return { content, model };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('AI 호출 실패');
}

/** AI를 못 쓸 때: 기록만으로 정리 (지어내지 않고, 기록을 문장으로 옮기기만) */
export function ruleWrite(f) {
  const c = f.categories;
  const list = (names, tail) => names.map((n) => `${n}: ${tail}`);
  const j = (arr) => arr.map((x) => x.text).filter(Boolean);
  const att = f.attendance;
  const overview = [
    `${f.student} 학생은 이번 주 ${att.present + att.late}회 수업에 참여했어요${att.late ? ` (지각 ${att.late}회)` : ''}${att.absent ? `, 결석 ${att.absent}회가 있었어요` : ''}.`,
    f.homework.rate != null ? `숙제 완료율은 ${f.homework.rate}%${f.homework.prev_rate != null ? ` (지난주 ${f.homework.prev_rate}%)` : ''}예요.` : '',
    f.test_avg != null ? `이번 주 시험 평균은 ${f.test_avg}%${f.prev_test_avg != null ? ` (지난주 ${f.prev_test_avg}%)` : ''}예요.` : '',
  ].filter(Boolean).join(' ');
  return {
    overview,
    concepts: f.progress.length ? `이번 주에는 ${[...new Set(f.progress.map((p) => p.done).filter(Boolean))].slice(0, 4).join(', ')}을(를) 학습했어요.` : '',
    strengths: list(c.strength, '수업에서 잘 해냈어요.'),
    growth: list(c.growth, '지난 수업보다 나아지고 있어요.'),
    practice: list(c.practice, '반복 연습으로 더 익숙해지도록 하고 있어요.'),
    weak_concepts: [...list(c.concept, '개념을 한 번 더 확인하고 있어요.'), ...j(f.notes.weak)],
    academy_done: [...j(f.notes.extra_done), ...list(c.review, '복습을 진행했어요.')],
    academy_plan: [...j(f.notes.extra_need), ...list(c.individual, '개별 지도로 함께 보완할 예정이에요.'), ...list(c.hold, '진도를 조정해 충분히 익힌 뒤 넘어갈 예정이에요.')],
    next_week: f.next_plan ? `다음 주에는 ${f.next_plan}을(를) 학습할 예정이에요.` : '',
    home_tips: f.homework.missing || f.homework.partial ? ['가정에서 숙제를 끝까지 마쳤는지 한 번씩 확인해 주시면 큰 도움이 돼요.'] : [],
    teacher_comment: j(f.notes.special).join(' ') || j(f.notes.comments).slice(-2).join(' '),
  };
}

/** 대기 중인 리포트를 몇 개씩 AI로 쓰기 (10분마다) — 처리한 기준일 목록을 돌려줘요 */
export async function processQueue(env, opts = {}) {
  const settings = opts.settings || await getSettings(env);
  const g = growthSettings(settings);
  const where = opts.id ? 'id = ?' : "status = 'queued'";
  const rows = await all(env, `SELECT * FROM reports WHERE ${where} ORDER BY id LIMIT ?`, ...(opts.id ? [opts.id] : []), opts.id ? 1 : Math.max(1, Number(opts.limit || g.per_tick) || 4));
  const refs = new Set();
  for (const r of rows) {
    const facts = JSON.parse(r.facts || '{}');
    const stamp = kstNow().stamp;
    try {
      const { content, model } = await aiWrite(env, settings, facts);
      await run(env, "UPDATE reports SET ai = ?, source = 'ai', model = ?, status = 'ready', error = '', tries = tries + 1, updated_at = ? WHERE id = ?", JSON.stringify(content), model, stamp, r.id);
    } catch (e) {
      const tries = (r.tries || 0) + 1;
      if (tries >= 2 || opts.id) {
        // 두 번 실패하면 기록만으로 정리해서라도 준비 (화면에 "AI 미사용"으로 표시)
        await run(env, "UPDATE reports SET ai = ?, source = 'rule', model = '', status = 'ready', error = ?, tries = ?, updated_at = ? WHERE id = ?",
          JSON.stringify(cleanContent(ruleWrite(facts))), String(e.message || e).slice(0, 300), tries, stamp, r.id);
      } else {
        await run(env, 'UPDATE reports SET error = ?, tries = ?, updated_at = ? WHERE id = ?', String(e.message || e).slice(0, 300), tries, stamp, r.id);
      }
    }
    refs.add(r.ref);
  }
  return [...refs];
}

export function contentOf(r) {
  try { if (r.edited) return cleanContent(JSON.parse(r.edited)); } catch { /* */ }
  try { if (r.ai) return cleanContent(JSON.parse(r.ai)); } catch { /* */ }
  return null;
}

// ───────── 알림톡 값 ─────────
export function growthVars(settings, baseUrl, r, facts) {
  const tk = facts.test_kinds || [];
  return {
    학원: settings.academy || '', 학원연락처: settings.academy_phone || '', 학생명: facts.student, 반: facts.class_name,
    기간: facts.period?.label || '', 날짜: facts.period?.label || '',
    학습내용: [...new Set((facts.progress || []).map((p) => String(p.done || '').split(' · ')[0]).filter(Boolean))].slice(0, 4).join(', '),
    시험요약: tk.map((k) => `${k.kind} ${k.avg != null ? `평균 ${k.avg}%` : ''}${k.change != null ? `(${k.change >= 0 ? '+' : ''}${k.change})` : ''}`.trim()).join(', '),
    숙제현황: facts.homework && facts.homework.rate != null ? `${facts.homework.rate}%` : '',
    리포트코드: r.token, 리포트링크: baseUrl ? `${baseUrl}/r/${r.token}` : '',
  };
}

// ───────── 텍스트 (카카오톡 복사용) ─────────
export function reportText(settings, facts, c) {
  const L = [];
  const sec = (t, body) => { const b = Array.isArray(body) ? body.filter(Boolean).map((x) => `- ${x}`).join('\n') : String(body || '').trim(); if (b) L.push(`■ ${t}\n${b}`); };
  L.push(`[${settings.academy || '학원'}] 주간 성장 리포트`, `${facts.student} · ${facts.period.label}`);
  sec('이번 주 학습 진도', [...(facts.progress || []).map((p) => `${dateShort(p.date)} ${p.done}`), c.concepts]);
  sec('이번 주 시험 결과', (facts.tests || []).map((t) => `${dateShort(t.date)} ${t.kind} ${t.score}${t.result ? ` (${t.result})` : ''}`));
  sec('학습 성취도', c.overview);
  sec('잘하고 있는 부분', c.strengths);
  sec('지난주보다 성장한 부분', c.growth);
  sec('조금 더 연습이 필요한 부분', c.practice);
  sec('어려워하는 학습 개념', c.weak_concepts);
  sec('학원에서 지도한 내용', c.academy_done);
  sec('학원에서 추가로 지도할 부분', c.academy_plan);
  sec('다음 주 학습 예정', c.next_week);
  sec('가정에서 도와주시면 좋은 부분', c.home_tips);
  sec('선생님 코멘트', c.teacher_comment);
  return L.join('\n\n');
}

// ───────── 학부모 리포트 페이지 (파스텔톤, 인쇄·PDF 가능) ─────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const MARK_COLOR = { '매우 잘함': '#cdeec0', '잘함': '#e3f5d6', '향상 중': '#d8e8ff', '반복 연습 필요': '#fff1b8', '개념 확인 필요': '#ffe3cc', '개별 지도 필요': '#ffd2b0', '복습 진행': '#e8dcff', '진도 보류': '#e6e6e6' };

export function reportHtml(settings, r, facts, c, opts = {}) {
  const g = growthSettings(settings);
  const ul = (arr) => (arr && arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  const p = (t) => (t ? `<p>${esc(t).replace(/\n/g, '<br>')}</p>` : '');
  let n = 0;
  const sec = (title, inner, cls = '') => (inner && inner.replace(/<[^>]+>/g, '').trim() ? `<section class="sec ${cls}"><h2><span class="no">${++n}</span>${esc(title)}</h2>${inner}</section>` : '');
  const att = facts.attendance || {};
  const head = `<div class="kv"><div><b>학생</b>${esc(facts.student)}${facts.class_name ? ` <small>(${esc(facts.class_name)})</small>` : ''}</div><div><b>학습 기간</b>${esc(facts.period.label)}</div>
    <div><b>출결</b>출석 ${att.present || 0} · 지각 ${att.late || 0} · 결석 ${att.absent || 0}</div>${facts.teacher ? `<div><b>담당</b>${esc(facts.teacher)} 선생님</div>` : ''}</div>`;
  const prog = (facts.progress || []).length ? `<table><thead><tr><th>날짜</th><th>교재</th><th>완료한 진도</th></tr></thead><tbody>${facts.progress.map((x) => `<tr><td>${esc(dateShort(x.date))}</td><td>${esc(x.book)}</td><td>${esc(x.done)}${x.changed ? `<div class="sub">계획: ${esc(x.planned)}</div>` : ''}</td></tr>`).join('')}</tbody></table>` : '';
  const tk = facts.test_kinds || [];
  const tests = (facts.tests || []).length ? `<table><thead><tr><th>날짜</th><th>시험</th><th>점수</th><th>결과</th></tr></thead><tbody>${facts.tests.map((t) => `<tr><td>${esc(dateShort(t.date))}</td><td>${esc(t.kind)}</td><td>${esc(t.score)}</td><td>${esc(t.result)}</td></tr>`).join('')}</tbody></table>
    <div class="chips">${tk.map((k) => `<span class="chip">${esc(k.kind)} 평균 ${k.avg != null ? `${k.avg}%` : '-'}${k.change != null ? ` <b class="${k.change >= 0 ? 'up' : 'down'}">${k.change >= 0 ? '▲' : '▼'} ${Math.abs(k.change)}</b> <small>지난주 대비</small>` : ''}</span>`).join('')}</div>
    ${(facts.retests || []).length ? `<div class="sub">재시험: ${facts.retests.map((x) => esc(`${dateShort(x.date)} ${x.text}`)).join(' / ')}</div>` : ''}` : '';
  const areas = (facts.areas || []).length ? `<div class="areas">${facts.areas.map((a) => `<div class="area"><div class="an">${esc(a.name)}${a.trend ? ` <small class="tr ${a.trend === '상승' ? 'up' : a.trend === '하락' ? 'down' : ''}">${esc(a.trend)}</small>` : ''}</div><div>${a.marks.map((m) => { const base = m.replace(/ \d+회$/, ''); return `<span class="mk" style="background:${MARK_COLOR[base] || '#eee'}">${esc(m)}</span>`; }).join('')}</div></div>`).join('')}</div>` : '';
  const hw = facts.homework || {};
  const ach = `${p(c.overview)}${areas}<div class="chips">${hw.rate != null ? `<span class="chip">숙제 완료율 ${hw.rate}%${hw.prev_rate != null ? ` <small>(지난주 ${hw.prev_rate}%)</small>` : ''}</span>` : ''}${facts.progress_rate != null ? `<span class="chip">계획 진도 달성 ${facts.progress_rate}%</span>` : ''}</div>`;
  const academy = `${c.academy_done.length ? `<h3>이번 주 학원에서 지도한 내용</h3>${ul(c.academy_done)}` : ''}${c.academy_plan.length ? `<h3>앞으로 지도할 계획</h3>${ul(c.academy_plan)}` : ''}`;
  const photos = (facts.media || []).length ? `<div class="photos">${facts.media.map((t) => `<img src="/m/${esc(t)}" loading="lazy" alt="">`).join('')}</div>` : '';
  const badge = r.source === 'rule' ? '<div class="note">이번 리포트는 AI 없이 수업 기록만으로 정리했어요.</div>' : '';
  const body = [
    sec('학생 이름 및 학습 기간', head),
    sec('이번 주 학습 진도', prog + p(c.concepts)),
    sec('이번 주 시험 결과', tests),
    sec('학습 성취도', ach),
    sec('우리 아이가 잘하고 있는 부분', ul(c.strengths), 'mint'),
    sec('지난주보다 성장한 부분', ul(c.growth), 'sky'),
    sec('조금 더 연습이 필요한 부분', ul(c.practice), 'lemon'),
    sec('이해가 부족하거나 어려워하는 학습 개념', ul(c.weak_concepts), 'peach'),
    sec('학원에서 추가로 지도할 부분', academy, 'lilac'),
    sec('다음 주 학습 예정 내용', p(c.next_week) || p(facts.next_plan ? `다음 주에는 ${facts.next_plan}을(를) 학습할 예정이에요.` : '')),
    sec('가정에서 함께 도와주시면 좋은 부분', ul(c.home_tips)),
    sec('선생님의 특별 코멘트', p(c.teacher_comment), 'note-sec'),
    sec('학습 결과물 및 활동 사진', photos),
  ].join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(facts.student)} 주간 성장 리포트</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f4fb;color:#2b2a33;font-family:Pretendard,-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.6}
main{max-width:760px;margin:0 auto;padding:22px 16px 60px}
.cover{background:linear-gradient(135deg,#e7f6ef 0%,#e9efff 55%,#f6e9ff 100%);border-radius:20px;padding:26px 22px;margin-bottom:16px}
.brand{font-size:13px;letter-spacing:.18em;font-weight:700;color:#5b6bb5}.ttl{font-size:24px;font-weight:800;letter-spacing:.02em;margin:4px 0 2px;color:#2f3a6b}
.subt{font-size:15px;color:#4b5068}.campus{margin-top:12px;font-size:13px;color:#6b6f80}
.sec{background:#fff;border:1px solid #ece8f4;border-radius:16px;padding:16px 18px;margin:12px 0;break-inside:avoid}
.sec h2{font-size:16px;margin:0 0 10px;display:flex;align-items:center;gap:8px;color:#333a5c}.sec h3{font-size:14px;margin:12px 0 4px;color:#555b78}
.no{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#e9e6ff;color:#5b56a8;font-size:12px;font-weight:700}
.mint{background:#f1fbf5}.sky{background:#f2f7ff}.lemon{background:#fffbea}.peach{background:#fff5ee}.lilac{background:#f7f2ff}.note-sec{background:#fbf9f2}
p{margin:6px 0}ul{margin:4px 0;padding-left:20px}li{margin:3px 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 6px;border-bottom:1px solid #f0edf5;vertical-align:top}th{color:#7a7f94;font-weight:600;font-size:12px}
.sub{color:#8a8ea0;font-size:12px;margin-top:2px}.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 14px}.kv b{display:block;font-size:12px;color:#8a8ea0;font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.chip{background:#f3f1fa;border-radius:999px;padding:4px 10px;font-size:13px}.up{color:#2f8f5b}.down{color:#c4613b}
.areas{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-top:10px}.area{border:1px solid #efecf6;border-radius:12px;padding:8px 10px}.an{font-weight:600;font-size:14px;margin-bottom:4px}
.mk{display:inline-block;border-radius:8px;padding:2px 8px;font-size:12px;margin:2px 4px 2px 0}.tr{font-size:11px;font-weight:600}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}.photos img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:12px;background:#eee}
.note{background:#fff8e6;border-radius:10px;padding:8px 12px;font-size:13px;color:#7a6020;margin-bottom:10px}
.tools{display:flex;gap:8px;justify-content:flex-end;margin-bottom:10px}.tools button{border:1px solid #dcd7ea;background:#fff;border-radius:999px;padding:7px 14px;font:inherit;font-size:13px;cursor:pointer}
.foot{text-align:center;color:#9a9db0;font-size:12px;margin-top:20px}
@media print{body{background:#fff}.tools{display:none}main{padding:0}.sec{border-color:#e6e3ee}}
</style></head><body><main>
${opts.noTools ? '' : '<div class="tools"><button onclick="window.print()">PDF 저장 · 인쇄</button></div>'}
<div class="cover"><div class="brand">${esc(g.brand || 'PAMUS ENGLISH')}</div><div class="ttl">WEEKLY GROWTH REPORT</div><div class="subt">우리 아이의 일주일 성장 이야기</div><div class="campus">${esc(settings.academy || '')}</div></div>
${badge}${body}
<div class="foot">${esc(settings.academy || '')}${settings.academy_phone ? ` · 문의 ${esc(settings.academy_phone)}` : ''}</div>
</main></body></html>`;
}

// ───────── 학부모 링크 (/r/코드): 학부모 휴대폰 뒷자리 4자리 확인 ─────────
async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
function cookieOf(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
function page(title, inner, status = 200, headers = {}) {
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#f6f4fb;font-family:Pretendard,-apple-system,system-ui,sans-serif;color:#2b2a33}.box{max-width:380px;margin:12vh auto;background:#fff;border-radius:18px;padding:26px 22px;border:1px solid #ece8f4;text-align:center}
input{font:inherit;font-size:22px;letter-spacing:.4em;text-align:center;width:160px;padding:10px;border:1px solid #d9d4e8;border-radius:12px;margin:14px 0}button{font:inherit;background:#5b56a8;color:#fff;border:0;border-radius:12px;padding:11px 22px;font-size:15px}.err{color:#c4613b;font-size:14px}p{color:#666b80;font-size:14px}</style></head>
<body><div class="box">${inner}</div></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...headers } });
}

export async function reportPage(env, request, token) {
  const r = await first(env, 'SELECT r.*, s.phone FROM reports r LEFT JOIN students s ON s.id = r.student_id WHERE r.token = ?', token);
  if (!r || r.status !== 'ready') return page('리포트', '<h2>리포트를 찾을 수 없어요</h2><p>링크를 다시 확인해 주세요.</p>', 404);
  const last4 = String(r.phone || '').replace(/\D/g, '').slice(-4);
  const settings = await getSettings(env);
  const cname = `rv_${token.slice(0, 10)}`;
  const want = last4 ? await sha(`${token}|${last4}|${env.TOKEN_ENC_KEY || 'cm'}`) : null;
  if (want && request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    const pin = String(form && form.get('pin') || '').replace(/\D/g, '');
    const nowMs = Date.now();
    if ((r.fails || 0) >= 10 && nowMs - (r.fail_at || 0) < 3600e3) return page('리포트', '<h2>잠시 뒤 다시 시도해 주세요</h2><p>여러 번 틀려서 1시간 동안 잠겼어요.</p>', 429);
    if (pin !== last4) {
      await run(env, 'UPDATE reports SET fails = COALESCE(fails, 0) + 1, fail_at = ? WHERE id = ?', nowMs, r.id);
      return pinForm(settings, '번호가 맞지 않아요. 다시 입력해 주세요.');
    }
    await run(env, 'UPDATE reports SET fails = 0 WHERE id = ?', r.id);
    return new Response(null, { status: 303, headers: { Location: `/r/${token}`, 'Set-Cookie': `${cname}=${want}; Path=/r/; Max-Age=${60 * 60 * 24 * 60}; HttpOnly; Secure; SameSite=Lax` } });
  }
  if (want && cookieOf(request, cname) !== want) return pinForm(settings, '');
  if (!r.viewed_at) await run(env, 'UPDATE reports SET viewed_at = ? WHERE id = ?', kstNow().stamp, r.id);
  const facts = JSON.parse(r.facts || '{}');
  const c = contentOf(r) || cleanContent(ruleWrite(facts));
  return new Response(reportHtml(settings, r, facts, c), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
function pinForm(settings, err) {
  return page('리포트 확인', `<div style="font-size:12px;letter-spacing:.16em;color:#5b6bb5;font-weight:700">WEEKLY GROWTH REPORT</div><h2 style="margin:6px 0">${esc(settings.academy || '')}</h2>
  <p>학부모님 휴대폰 번호 <b>뒷자리 4자리</b>를 입력하시면<br>우리 아이 리포트를 보실 수 있어요.</p>
  <form method="post"><input name="pin" inputmode="numeric" maxlength="4" autocomplete="off" autofocus required><br>${err ? `<div class="err">${esc(err)}</div>` : ''}<button>리포트 보기</button></form>`);
}

// ───────── 일일 평가 저장·불러오기 (API에서 사용) ─────────
export async function evalDay(env, settings, classId, date, students) {
  const ids = JSON.stringify(students.map((s) => s.id));
  const [evals, notes, dayRow, prevDay] = await Promise.all([
    all(env, 'SELECT student_id, item, marks FROM evals WHERE date = ? AND student_id IN (SELECT value FROM json_each(?))', date, ids),
    all(env, 'SELECT * FROM daynotes WHERE date = ? AND student_id IN (SELECT value FROM json_each(?))', date, ids),
    first(env, 'SELECT items FROM eval_days WHERE date = ? AND class_id = ?', date, Number(classId)),
    first(env, 'SELECT items FROM eval_days WHERE date < ? AND class_id = ? ORDER BY date DESC LIMIT 1', date, Number(classId)),
  ]);
  const marks = {};
  for (const e of evals) { (marks[e.student_id] ||= {})[e.item] = JSON.parse(e.marks || '[]'); }
  const nmap = {};
  for (const n of notes) { const o = {}; for (const k of NOTE_KEYS) o[k] = n[k] || ''; nmap[n.student_id] = o; }
  let today = null;
  try { today = dayRow ? JSON.parse(dayRow.items) : null; } catch { /* */ }
  let suggested = null;
  try { suggested = prevDay ? JSON.parse(prevDay.items) : null; } catch { /* */ }
  return { items: itemsForClass(settings, classId), marks: EVAL_MARKS, selected: today, suggested, evals: marks, notes: nmap };
}

export async function saveEvalMarks(env, me, date, studentId, map) {
  const stamp = kstNow().stamp;
  const stmts = [env.DB.prepare('DELETE FROM evals WHERE date = ? AND student_id = ?').bind(date, studentId)];
  for (const [item, marks] of Object.entries(map || {})) {
    const list = (Array.isArray(marks) ? marks : []).filter((m) => MARK.has(m));
    if (!list.length) continue;
    stmts.push(env.DB.prepare('INSERT INTO evals (date, student_id, item, marks, teacher_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(date, studentId, String(item).slice(0, 20), JSON.stringify([...new Set(list)]), me.id || 0, stamp));
  }
  await env.DB.batch(stmts);
  return stamp;
}

export async function saveDayNote(env, me, date, studentId, fields) {
  const stamp = kstNow().stamp;
  const vals = NOTE_KEYS.map((k) => String((fields || {})[k] || '').slice(0, 1000));
  await run(env, `INSERT INTO daynotes (date, student_id, teacher_id, ${NOTE_KEYS.join(', ')}, updated_at) VALUES (?, ?, ?, ${NOTE_KEYS.map(() => '?').join(', ')}, ?)
    ON CONFLICT(date, student_id) DO UPDATE SET teacher_id = excluded.teacher_id, ${NOTE_KEYS.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`,
  date, studentId, me.id || 0, ...vals, stamp);
  return stamp;
}

export async function saveEvalDayItems(env, me, date, classId, items) {
  await run(env, `INSERT INTO eval_days (date, class_id, items, teacher_id, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date, class_id) DO UPDATE SET items = excluded.items, teacher_id = excluded.teacher_id, updated_at = excluded.updated_at`,
  date, Number(classId), JSON.stringify((items || []).map(String).slice(0, 60)), me.id || 0, kstNow().stamp);
}


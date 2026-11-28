// AI 주간 성장 리포트
// - 선생님이 매 수업 누르는 학습 평가(8가지 버튼) + 기존 출결·숙제·시험·진도 기록을 한 주 단위로 모으고
// - Cloudflare Workers AI(무료 사용량 안)로 학부모용 리포트 문장을 쓰고
// - AI를 쓸 수 없을 때는 기록만으로 규칙에 따라 쓰고 "자동 정리"라고 표시해요 (AI가 쓴 척하지 않기)
// 점수·진도·출결 같은 사실은 AI가 아니라 기록에서 바로 넣어요. AI는 문장만 써요.

import { worksForReport, typeLabel } from './works.js';
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

const FALLBACK_MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/qwen/qwen3-30b-a3b-fp8'];

export const NOTE_FIELDS = [
  ['done', '실제 완료한 진도'],
  ['next_plan', '다음 수업 예정 진도'],
  ['retest', '재시험 결과'],
  ['mistakes', '오답 · 반복되는 실수'],
  ['weak', '이해가 부족한 개념'],
  ['extra_done', '추가 지도한 내용'],
  ['extra_need', '추가 지도가 필요한 내용'],
  ['special', '선생님 특별 코멘트 (짧게 메모만 해도 리포트에서 다듬어 드려요)'],
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
/** 리포트 기간: 1주(월~금) 또는 2주(지지난주 월 ~ 지난 금). 2주마다면 기준 토요일과 짝이 맞는 토요일로 맞춰요 */
export function periodFor(settings, ref) {
  const g = growthSettings(settings || {});
  const weeks = Number(g.weeks) === 1 ? 1 : 2;
  let sat = saturdayOf(ref);
  if (weeks === 2) {
    const anchor = saturdayOf(/^\d{4}-\d{2}-\d{2}$/.test(String(g.anchor)) ? g.anchor : sat);
    const diff = Math.round((Date.parse(sat) - Date.parse(anchor)) / (7 * 864e5));
    if (((diff % 2) + 2) % 2 === 1) sat = addDays(sat, 7);
  }
  return { ref: sat, from: addDays(sat, 2 - 7 * weeks), to: addDays(sat, -1), weeks };
}
export function weekOf(ref, settings) { return periodFor(settings, ref); }
/** 1주 성장 리포트 (2주 리포트와 따로, 원할 때 만들어 보기) */
export function oneWeek(settings) { return { ...settings, growth: { ...growthSettings(settings), weeks: 1 } }; }
export const REPORT_KIND = { growth: 'weekly', growth1: 'week1', growth_m: 'month', growth_q: 'quarter', consult: 'consult' };
export const MSG_KIND = { weekly: 'growth', week1: 'growth1', month: 'growth_m', quarter: 'growth_q' }; // consult는 메시지 없이 리포트만

const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const prevMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
/** 리포트 종류별 기간: ref(기준), from~to(이번 기간), prevFrom~prevTo(비교할 지난 기간) */
export function periodOfKind(settings, rkind, ref) {
  const r = String(ref || kstNow().date);
  if (rkind === 'month') {
    const ym = /^\d{4}-\d{2}/.test(r) ? r.slice(0, 7) : kstNow().date.slice(0, 7);
    const pm = prevMonth(ym);
    return { ref: ym, from: `${ym}-01`, to: lastDay(ym), prevFrom: `${pm}-01`, prevTo: lastDay(pm), weeks: 4, unit: 'month' };
  }
  if (rkind === 'quarter') {
    let y, q;
    const m1 = r.match(/^(\d{4})-Q([1-4])$/);
    if (m1) { y = Number(m1[1]); q = Number(m1[2]); } else { y = Number(r.slice(0, 4)); q = Math.floor((Number(r.slice(5, 7)) - 1) / 3) + 1; }
    const sm = (q - 1) * 3 + 1;
    const ym = (mm) => `${y}-${String(mm).padStart(2, '0')}`;
    const py = q === 1 ? y - 1 : y, pq = q === 1 ? 4 : q - 1, psm = (pq - 1) * 3 + 1;
    const pym = (mm) => `${py}-${String(mm).padStart(2, '0')}`;
    return { ref: `${y}-Q${q}`, from: `${ym(sm)}-01`, to: lastDay(ym(sm + 2)), prevFrom: `${pym(psm)}-01`, prevTo: lastDay(pym(psm + 2)), weeks: 13, unit: 'quarter' };
  }
  if (rkind === 'consult') {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(r) ? r : kstNow().date;
    return { ref: d, from: addDays(d, -89), to: d, prevFrom: addDays(d, -179), prevTo: addDays(d, -90), weeks: 13, unit: 'consult' };
  }
  const p = periodFor(rkind === 'week1' ? oneWeek(settings) : settings, r);
  return { ...p, prevFrom: addDays(p.from, -7 * p.weeks), prevTo: addDays(p.to, -7 * p.weeks), unit: p.weeks === 2 ? 'w2' : 'w1' };
}
// 기간별 말 (2주·1주·월간·분기·상담)
const LABELS = {
  w2: { span: '2주', prev: '지난 2주', cur: '이번 2주', next: '다음 2주', title: 'BI-WEEKLY GROWTH REPORT', subt: '2주', name: '2주 성장 리포트' },
  w1: { span: '한 주', prev: '지난주', cur: '이번 주', next: '다음 주', title: 'WEEKLY GROWTH REPORT', subt: '일주일', name: '주간 성장 리포트' },
  month: { span: '한 달', prev: '지난달', cur: '이번 달', next: '다음 달', title: 'MONTHLY GROWTH REPORT', subt: '한 달', name: '월간 성장 리포트' },
  quarter: { span: '3개월', prev: '지난 분기', cur: '이번 분기', next: '다음 분기', title: 'QUARTERLY GROWTH REPORT', subt: '3개월', name: '분기 성장 리포트' },
  consult: { span: '최근 3개월', prev: '그 전 3개월', cur: '최근 3개월', next: '앞으로', title: 'CONSULTATION REPORT', subt: '최근 3개월', name: '상담용 리포트' },
};
export function labelsOf(p) {
  if (p && typeof p === 'object') return LABELS[p.unit] || (Number(p.weeks) === 2 ? LABELS.w2 : LABELS.w1);
  return Number(p) === 2 ? LABELS.w2 : LABELS.w1;
}
const unitWord = (w) => labelsOf(w).span;
const prevWord = (w) => labelsOf(w).prev;

// ───────── 한 주 사실 모으기 ─────────
function targetFor(classType, classId, studentId) { return classType === 'individual' ? `s${studentId}` : `c${classId}`; }
/** 그날 그 학생의 진도 기록들 (반에 진도표가 여러 개면 여러 개) */
function logsOf(cur, date, s, classId) {
  const mine = cur.studentLogs.get(`${date}|${s.id}`);
  if (mine && mine.length) return mine;
  if (s.class_type === 'individual') return [];
  return cur.classLogs.get(`${date}|${classId}`) || [];
}
const pct = (c, t) => (t ? Math.round((c / t) * 100) : null);
const fmt = (n) => (n == null || n === '' ? '' : String(+Number(n).toFixed(1)));

function byClassDay(logs, p = 'c') {
  const m = new Map();
  for (const l of logs) {
    const g = String(l.target).match(p === 's' ? /^s(\d+)(?:t(\d+|x))?$/ : /^c(\d+)(?:t(\d+|x))?$/);
    if (!g) continue;
    const k = `${l.date}|${g[1]}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(l);
  }
  for (const arr of m.values()) arr.sort((a, b) => (a.target.length - b.target.length) || a.target.localeCompare(b.target)); // 기본 진도표 먼저
  return m;
}
async function rangeData(env, from, to) {
  const [days, tests, evals, notes, logs, media, works] = await Promise.all([
    all(env, 'SELECT * FROM days WHERE date >= ? AND date <= ? ORDER BY date', from, to),
    all(env, 'SELECT * FROM tests WHERE date >= ? AND date <= ? ORDER BY date, kind', from, to),
    all(env, 'SELECT * FROM evals WHERE date >= ? AND date <= ? ORDER BY date', from, to),
    all(env, 'SELECT * FROM daynotes WHERE date >= ? AND date <= ? ORDER BY date', from, to),
    all(env, 'SELECT * FROM logs WHERE date >= ? AND date <= ? ORDER BY date', from, to),
    all(env, "SELECT student_id, token, kind, date FROM media WHERE date >= ? AND date <= ? AND status = 'ready' ORDER BY date, id", from, to),
    all(env, "SELECT student_id, date, type, comment FROM works WHERE date >= ? AND date <= ? AND include = 1 AND comment != '' ORDER BY date, id", from, to).catch(() => []),
  ]);
  const by = (rows, key = 'student_id') => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; };
  return { days: by(days), tests: by(tests), evals: by(evals), notes: by(notes), media: by(media), works: by(works), logs: new Map(logs.map((l) => [`${l.date}|${l.target}`, l])), classLogs: byClassDay(logs), studentLogs: byClassDay(logs, 's') };
}

function evalSummary(rows, itemName) {
  const out = new Map(); // item id → { name, counts: {mark: n}, days }
  for (const r of rows || []) {
    let marks = []; try { marks = JSON.parse(r.marks || '[]'); } catch { /* */ }
    if (!marks.length) continue;
    if (!out.has(r.item)) out.set(r.item, { id: r.item, name: itemName(r.item), counts: {}, days: 0, timeline: [] });
    const o = out.get(r.item); o.days++;
    o.timeline.push(`${dateShort(r.date)} ${marks.filter((m) => MARK.has(m)).map((m) => MARK.get(m).label).join('·')}`);
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
export const isVoca = (kind) => /voca|vocab|단어|word|spelling|스펠/i.test(String(kind || ''));
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
    const dayLogs = logsOf(cur, d.date, s, d.class_id);
    const n = notes.get(d.date) || {};
    if (!dayLogs.length && !n.done) continue;
    if (dayLogs.length > 1 && !n.done) {
      for (const log of dayLogs) { const planned = oneLine(log.today); if (planned) progress.push({ date: d.date, book: log.book || (log.target.endsWith('tx') ? '추가 학습' : ''), planned, done: planned, changed: false, homework: oneLine(log.homework) }); }
      continue;
    }
    const log = dayLogs[0];
    const planned = dayLogs.map((l) => oneLine(l.today)).filter(Boolean).join(' / ');
    progress.push({ date: d.date, book: dayLogs.map((l) => l.book || (l.target.endsWith('tx') ? '추가 학습' : '')).filter(Boolean).join(', '), planned, done: n.done || planned, changed: !!(n.done && planned && n.done !== planned), homework: dayLogs.map((l) => oneLine(l.homework)).filter(Boolean).join(' / ') || (log ? '' : '') });
  }
  for (const n of notes.values()) if (n.done && !progress.some((p) => p.date === n.date)) progress.push({ date: n.date, book: '', planned: '', done: n.done, changed: false, homework: '' });
  progress.sort((a, b) => a.date.localeCompare(b.date));
  const lastNote = [...notes.values()].filter((n) => n.next_plan).pop();
  // 진도표마다 가장 최근 기록의 다음 차시
  const latest = new Map();
  for (const d of days) for (const l of logsOf(cur, d.date, s, d.class_id)) if (!l.target.endsWith('tx')) latest.set(l.target, l);
  // 개별 진도로 바꾼 학생은 반 진도의 다음 차시는 빼기
  if (s.solo && [...latest.keys()].some((t) => t.startsWith('s'))) for (const t of [...latest.keys()]) if (t.startsWith('c')) latest.delete(t);
  const nexts = [...latest.values()].map((l) => ({ book: l.book, text: l.repeat ? oneLine(l.today) : oneLine(l.next) })).filter((x) => x.text);
  const nextPlan = lastNote ? lastNote.next_plan : nexts.length > 1 ? nexts.map((x) => `${x.book ? `[${x.book}] ` : ''}${x.text}`).join(' / ') : nexts[0] ? nexts[0].text : '';

  const testsNow = (cur.tests.get(s.id) || []).filter((t) => t.correct != null || t.result).map((t) => ({
    date: t.date, kind: t.kind, score: t.correct != null && t.total ? `${fmt(t.correct)}/${fmt(t.total)}` : t.correct != null ? `${fmt(t.correct)}점` : '',
    pct: t.correct != null && t.total ? Math.round((t.correct / t.total) * 100) : null, result: t.result === 'good' ? '통과' : t.result === 'retest' ? '재시험' : '',
  }));
  const tNow = testSummary(cur.tests.get(s.id));
  const tPrev = testSummary(prev.tests.get(s.id));
  const testKinds = tNow.map((k) => { const p = tPrev.find((x) => x.kind === k.kind); return { ...k, prevAvg: p ? p.avg : null, change: p && p.avg != null && k.avg != null ? k.avg - p.avg : null }; });
  const scored = testsNow.filter((t) => t.pct != null);
  // 그래프용: 지난 기간 + 이번 기간 시험 점수(%)
  const toPt = (t, period) => (t.correct != null && t.total ? { date: t.date, kind: t.kind, pct: Math.round((t.correct / t.total) * 100), period } : null);
  // 그래프는 단어 시험은 빼고, Weekly·Monthly(단원·최종 평가) 점수를 지난 6개월 누적으로
  const hist = (cur.history && cur.history.get(s.id)) || [...(prev.tests.get(s.id) || []), ...(cur.tests.get(s.id) || [])];
  const testSeries = hist.filter((t) => !isVoca(t.kind)).map((t) => toPt(t, t.date >= period.from && t.date <= period.to ? 'cur' : 'prev')).filter(Boolean);
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
      timeline: e.timeline,
      prev: p ? Object.entries(p.counts).map(([m, n]) => `${MARK.get(m).label}${n > 1 ? ` ${n}회` : ''}`).join(', ') : '',
    };
  });

  const pick = (k) => [...notes.values()].filter((n) => n[k]).map((n) => ({ date: n.date, text: String(n[k]).trim() }));
  const comments = days.filter((d) => String(d.comment || '').trim()).map((d) => ({ date: d.date, text: String(d.comment).trim() }));
  // 같은 실수가 여러 날 반복되면 표시
  const mistakes = pick('mistakes');
  const prevNotes = prev.notes.get(s.id) || [];
  const media = (cur.media.get(s.id) || []).filter((m) => m.kind === 'photo').slice(0, 6).map((m) => m.token);

  return {
    student: s.name, class_name: s.class_name || '', teacher: s.teacher_name || '',
    period: { from: period.from, to: period.to, weeks: period.weeks || 1, unit: period.unit || (period.weeks === 2 ? 'w2' : 'w1'), label: `${period.from.slice(0, 4) !== period.to.slice(0, 4) ? period.from.slice(2, 4) + '.' : ''}${dateShort(period.from)} ~ ${dateShort(period.to)}` },
    attendance: { present: cnt.present, late: cnt.late, absent: cnt.absent },
    books: [...new Set(progress.map((p) => p.book).filter(Boolean))],
    progress, next_plan: nextPlan,
    progress_rate: progress.length ? pct(progress.filter((p) => !p.changed).length, progress.length) : null,
    tests: testsNow, test_kinds: testKinds, test_series: testSeries,
    test_avg: scored.length ? Math.round(scored.reduce((a, t) => a + t.pct, 0) / scored.length) : null,
    prev_test_avg: prevScored.length ? Math.round(prevScored.reduce((a, t) => a + (t.correct / t.total) * 100, 0) / prevScored.length) : null,
    retests: pick('retest'),
    homework: { done: cnt.done, partial: cnt.partial, missing: cnt.missing, rate: pct(cnt.done, hwTotal), prev_rate: pct(pc.done, pc.total) },
    areas, categories: cats,
    notes: { mistakes, weak: pick('weak'), extra_done: pick('extra_done'), extra_need: pick('extra_need'), special: pick('special'), comments },
    prev_notes: { mistakes: prevNotes.filter((n) => n.mistakes).map((n) => String(n.mistakes).trim()), extra_need: prevNotes.filter((n) => n.extra_need).map((n) => String(n.extra_need).trim()) },
    media,
    works: ((cur.works && cur.works.get(s.id)) || []).map((w) => ({ date: w.date, type: typeLabel(w.type), comment: String(w.comment).trim() })),
  };
}

function hasData(f) {
  return f.progress.length || f.tests.length || f.areas.length || f.attendance.present + f.attendance.late + f.attendance.absent
    || Object.values(f.notes).some((a) => a.length) || (f.works || []).length;
}

/** 리포트 행을 만들거나 사실만 최신으로 (AI 문장은 그대로) */
export async function ensureReports(env, settings, ref, rkind = 'weekly', opts = {}) {
  const w = periodOfKind(settings, rkind, ref);
  const prevW = { from: w.prevFrom, to: w.prevTo };
  const [cur, prev, hist] = await Promise.all([rangeData(env, w.from, w.to), rangeData(env, prevW.from, prevW.to),
    all(env, 'SELECT student_id, date, kind, correct, total FROM tests WHERE date >= ? AND date <= ? AND correct IS NOT NULL AND total > 0 ORDER BY date', addDays(w.to, -180), w.to)]);
  cur.history = new Map();
  for (const t of hist) { if (!cur.history.has(t.student_id)) cur.history.set(t.student_id, []); cur.history.get(t.student_id).push(t); }
  // 진도 기록에 교재 이름 붙이기
  const curNames = new Map((await all(env, 'SELECT id, name FROM curricula')).map((c) => [c.id, c.name]));
  for (const l of cur.logs.values()) l.book = curNames.get(l.curriculum_id) || '';
  const students = await all(env, `SELECT s.*, c.name AS class_name, c.type AS class_type, t.name AS teacher_name FROM students s
    LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN teachers t ON t.id = c.teacher_id WHERE s.deleted = 0`);
  const existing = new Map((await all(env, 'SELECT * FROM reports WHERE kind = ? AND ref = ?', rkind, w.ref)).map((r) => [r.student_id, r]));
  const now = kstNow().stamp;
  const stmts = [];
  for (const s of students) {
    if (opts.studentId && s.id !== Number(opts.studentId)) continue;
    const facts = buildFacts(settings, s, cur, prev, w);
    const ex = existing.get(s.id);
    if (!hasData(facts)) continue;
    const fj = JSON.stringify(facts);
    if (!ex) {
      stmts.push(env.DB.prepare(`INSERT INTO reports (kind, ref, student_id, token, facts, status, tries, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?) ON CONFLICT(kind, ref, student_id) DO NOTHING`).bind(rkind, w.ref, s.id, randomToken(24), fj, now, now));
    } else if (ex.facts !== fj) {
      stmts.push(env.DB.prepare('UPDATE reports SET facts = ?, updated_at = ? WHERE id = ?').bind(fj, now, ex.id));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return w;
}

// ───────── AI로 문장 쓰기 ─────────
const SECTION_KEYS = ['overview', 'skills', 'concepts', 'strengths', 'growth', 'practice', 'weak_concepts', 'academy_done', 'academy_plan', 'goals', 'next_week', 'home_tips', 'consult_points', 'teacher_comment'];
const LIST_KEYS = new Set(['skills', 'strengths', 'growth', 'practice', 'weak_concepts', 'academy_done', 'academy_plan', 'goals', 'home_tips', 'consult_points']);
export const SKILL_AREAS = ['어휘', '읽기', '쓰기', '문법', '말하기·듣기', '학습 습관'];
export const SKILL_LEVELS = ['도입', '발전', '안정', '심화'];

// 학원에서 쓰는 학습 항목을 학부모가 알아듣게 풀어 주는 말 (AI가 전문 용어를 설명할 때 참고)
const TERM_HINTS = {
  '구문 분석': '문장을 주어·동사·목적어 같은 덩어리로 나눠 구조를 파악하는 연습',
  '직독직해': '영어 문장을 앞에서부터 의미 단위로 끊어 바로 이해하는 읽기',
  '누적 단어 복습': '지난 Day 단어까지 섞어서 다시 확인하는 복습',
  '문장 낭독': '본문을 소리 내어 정확하고 자연스럽게 읽는 연습',
  '영어홀릭 라이팅': '영어홀릭 교재로 하는 주제 글쓰기',
  '클래스카드 학습': '클래스카드 앱으로 하는 단어 반복 학습',
  '오답 정리': '틀린 문제를 다시 풀고 왜 틀렸는지 적어 보는 활동',
};

const SYSTEM = `당신은 15년 넘게 초등·중등 아이들을 가르쳐 온 영어학원 원장이자 학습 코치입니다.
지금부터 학부모님께 보내는 "성장 리포트"의 문장을 씁니다. 학부모님이 읽고 "선생님이 우리 아이를 정말 자세히 보고 계시구나" 하고 느낄 수 있어야 합니다.

[가장 중요한 원칙]
1. 사실은 아래 "기록 요약"에 있는 것만 씁니다. 기록에 없는 점수·진도·행동·일화를 절대 지어내지 않습니다. 근거가 없는 칸은 비워 둡니다("" 또는 []).
2. 모든 문장에 근거를 넣습니다. 날짜, 학습 항목 이름, 교재·Unit·Day, 시험 점수, 횟수, 지난 기간과의 변화 중 하나 이상을 꼭 넣습니다.
3. 한 항목은 "관찰 → 의미 → 다음 지도" 순서로 2~3문장으로 씁니다.
   - 관찰: 언제, 무엇을, 어떻게 했는지
   - 의미: 그것이 영어 실력의 어떤 부분이 자라고 있다는 뜻인지(어휘력, 문장 구조 이해, 읽기 유창성, 쓰기 표현력, 자기주도 습관 등)
   - 다음 지도: 학원에서 무엇을, 얼마나 자주, 어떤 방법으로 할지
4. 부족한 부분은 "아직 ~하는 단계예요"처럼 성장 과정으로 표현하고, 반드시 구체적인 지도 계획(방법·빈도·확인 방법)을 함께 씁니다. 학부모님이 불안해할 표현(심각, 문제, 부진, 걱정)은 쓰지 않되, 상태는 정확하게 전합니다.
5. 다른 학생과 비교하지 않습니다. 이 학생의 지난 기간 기록과만 비교합니다.
6. 학원 용어는 처음 나올 때 괄호로 쉽게 풀어 줍니다. 예: 구문 분석(문장을 주어·동사 같은 덩어리로 나눠 구조를 파악하는 연습)
7. "학원에서 이미 한 지도"(academy_done)와 "앞으로 할 지도"(academy_plan)를 섞지 않습니다.
8. 선생님 특별 코멘트는 짧은 메모일 수 있습니다. 메모의 뜻과 사실은 그대로 살리되, 학부모님께 드리는 따뜻하고 전문적인 3~4문장으로 풀어 teacher_comment에 씁니다. (예: 메모 "발표 자신감 생김, 단어 실수 줄이기" → 발표할 때 목소리와 표정에서 자신감이 느껴진다는 점, 그것이 어떤 성장인지, 단어 철자 실수를 줄이기 위해 학원에서 어떻게 도울지, 가정에서의 격려 부탁) 메모에 없는 사실(날짜·점수·일화)은 기록 요약에 있을 때만 보탭니다.

[중복 금지 — 매우 중요]
- 같은 사실·같은 문장을 두 칸 이상에 쓰지 않습니다. 각 사실은 가장 알맞은 한 칸에만 씁니다.
- 칸마다 쓸 수 있는 근거가 정해져 있습니다. 근거가 부족하면 짧게 쓰되, 다른 칸의 내용을 가져와 채우지 않습니다.
  · strengths: '매우 잘함·잘함' 평가, 통과한 시험, 좋은 숙제 기록
  · growth: '향상 중' 평가, 지난 기간보다 오른 점수·완료율
  · practice: '반복 연습 필요' 평가, 반복되는 실수·오답 기록
  · weak_concepts: '개념 확인 필요' 평가, 이해가 부족한 개념 기록
  · academy_done: "학원에서 이미 한 추가 지도" 기록, '복습 진행' 평가 (진도를 나간 것은 여기에 쓰지 않습니다)
  · academy_plan: "추가 지도가 필요한 내용", '개별 지도 필요'·'진도 보류' 평가, practice·weak_concepts에 대한 지도 방법
  · next_week: "다음 학습 예정"과 숙제 계획 (다음 진도·시험 준비 이야기는 이 칸에만)
  · teacher_comment: 선생님 메모·한마디 (다른 칸 내용을 되풀이하지 않고, 아이에 대한 따뜻한 총평으로)
- 교재·Unit·Day 이름 같은 긴 표현을 여러 번 반복하지 않습니다.

[말투 — 매우 중요: AI가 쓴 티가 나지 않게]
- 원장님이 어머님께 카톡으로 아이 소식을 전하듯, 친근하고 자연스러운 존댓말로 씁니다. ("~했어요", "~하고 있어요", "~해 볼게요", "~해 주시면 좋아요")
- 아이는 "학생", "해당 학생", "아동"이라고 부르지 않고 이름으로 부릅니다. 기록 요약의 "부르는 이름"(예: 민준이, 지우)을 쓰고, 매 문장마다 부르지 않습니다.
- 보고서·논문 같은 딱딱한 표현을 쓰지 않습니다. 쓰지 말 것: "~라는 뜻이에요", "~을 의미합니다", "~단계에 있습니다", "~이 자리 잡고 있다", "~이 관찰되었습니다", "~으로 보입니다", "~할 필요가 있습니다", "향상되었습니다", "기반으로", "측면에서", "역량", "도모", "함양", "~하는 모습을 보였습니다", "긍정적인", "효과적으로", "지속적으로", "체계적으로".
- 대신 일상 말로 풀어 씁니다. 예: "단어 실력이 자리 잡고 있다는 뜻이에요" → "요즘 단어는 거의 놓치지 않고 외워 와요", "구문 분석 역량이 향상되었습니다" → "긴 문장도 이제 혼자 끊어 읽어요", "지속적으로 지도하겠습니다" → "수업 시작할 때마다 5분씩 같이 연습해 볼게요".
- 문장은 짧고 쉽게. 한 문장에 한 가지 이야기. 같은 말로 시작하는 문장을 이어 쓰지 않습니다.
- 칭찬은 구체적인 장면으로("발표할 때 목소리가 커졌어요"), 부족한 점은 걱정이 아니라 함께 할 계획으로("아직 헷갈려해서 다음 주에 한 번 더 짚어 줄게요") 씁니다.
- 느낌표, 이모지, 형식적인 인사말("안녕하세요 어머님")은 쓰지 않습니다.
- 금지: "열심히 했어요", "잘했어요", "최선을 다하겠습니다", "앞으로도 지켜봐 주세요" 같은 내용 없는 상투어만 쓰는 것.

[영역별 학습 진단 — skills]
- 기록에 근거가 있는 영역만 2~5개 씁니다. 영역은 어휘, 읽기, 쓰기, 문법, 말하기·듣기, 학습 습관 중에서 고릅니다.
- 형식: "영역|단계|진단" 한 줄 문자열. 단계는 도입(처음 배우는 중) · 발전(도움을 받아 해내는 중) · 안정(스스로 정확히 해냄) · 심화(응용·확장까지 함) 중 하나입니다.
- 단계는 평가 기록으로 정합니다: '매우 잘함·잘함'이 대부분이면 안정, 응용 기록까지 있으면 심화, '향상 중'이 많으면 발전, '반복 연습 필요·개념 확인 필요'가 많으면 도입~발전.
- 진단은 2~3문장: 근거(평가 횟수·점수·날짜) → 이 단계의 의미(무엇을 할 수 있고 무엇이 다음 단계인지). 구체 사례는 strengths·practice에 쓰고 여기서는 영역 수준의 종합 진단만 합니다.
- 예: "어휘|안정|이번 기간 Voca 시험 네 번이 모두 90% 이상이었고 단어 암기에서 '매우 잘함'이 세 번 있었어요. 배운 단어를 정확히 기억하는 단계라, 다음에는 문장 속에서 바르게 쓰는 단계로 넓혀 갈 거예요."

[상담 때 나눌 이야기 — consult_points]
- 기록 요약의 "리포트 종류"가 상담용일 때만 3~5개 씁니다. 그 밖의 리포트에서는 []로 둡니다.
- 상담 때 학부모님과 함께 이야기 나누면 좋은 주제를 씁니다: 지금 수준과 다음 목표, 가정 학습 습관(숙제·단어 암기), 진도·교재 방향, 학부모님께 여쭤보고 싶은 점(집에서의 모습 등).
- 항목마다 1~2문장, 기록 근거와 함께.

[다음 기간 학습 목표 — goals]
- 2~3개. 다음 기간이 끝났을 때 확인할 수 있는 구체적인 목표로 씁니다(숫자·횟수·항목 이름). 기록에 근거한 목표만 씁니다.
- 예: "Voca 시험 평균 85% 이상 유지하기", "구문 분석에서 '잘함' 2회 이상 받기", "숙제 완료율 90% 이상"

[분량]
- overview: 5~6문장. 이 기간 전체를 한눈에 정리(수업 이해도, 계획한 진도를 따라가는 정도, 수업 태도와 과제 수행, 가장 눈에 띈 변화, 다음 기간의 초점).
- concepts: 이 기간에 배운 핵심 개념·활동 2~3문장.
- strengths, growth, practice, weak_concepts, academy_done, academy_plan: 근거가 있는 것만, 항목마다 2~3문장(관찰→의미→다음 지도). 최대 4개.
- next_week: 다음 기간 학습 예정 2문장 (교재·Unit 이름 포함).
- home_tips: 가정에서 하루 5~10분 안에 할 수 있는 구체적인 행동 1~3개 (무엇을, 어떻게, 얼마나).
- teacher_comment: 3~4문장.

[좋은 예시 — 문체와 구체성만 참고하세요. 내용은 절대 옮기지 마세요]
{"strengths":["11/18, 11/20 단어 암기를 둘 다 '매우 잘함'으로 마쳤고, Voca 시험도 18/20, 19/20이 나왔어요. 요즘 새 단어를 외워 오는 게 정말 탄탄해요. 다음 2주는 그 단어로 짧은 문장을 직접 만들어 보는 연습까지 해 볼게요."],
"practice":["구문 분석(문장을 주어·동사 덩어리로 나눠 보는 연습)은 11/19에 아직 헷갈려했어요. 문장이 길어지면 동사를 먼저 찾는 게 조금 어려운가 봐요. 수업 시작할 때마다 5분씩 짧은 문장 3개로 같이 연습하고, 다음 리포트에서 어떻게 달라졌는지 꼭 알려 드릴게요."]}

출력은 설명 없이 아래 형식의 JSON 하나만 씁니다:
{"overview":"","skills":[],"concepts":"","strengths":[],"growth":[],"practice":[],"weak_concepts":[],"academy_done":[],"academy_plan":[],"goals":[],"next_week":"","home_tips":[],"consult_points":[],"teacher_comment":""}`;

const POLISH = `당신은 영어학원 원장입니다. 아래 "초안"은 학부모님께 보낼 성장 리포트 문장이고, "기록 요약"은 근거 자료입니다.
[말투 — 매우 중요: AI가 쓴 티가 나지 않게]
- 원장님이 어머님께 카톡으로 아이 소식을 전하듯, 친근하고 자연스러운 존댓말로 씁니다. ("~했어요", "~하고 있어요", "~해 볼게요", "~해 주시면 좋아요")
- 아이는 "학생", "해당 학생", "아동"이라고 부르지 않고 이름으로 부릅니다. 기록 요약의 "부르는 이름"(예: 민준이, 지우)을 쓰고, 매 문장마다 부르지 않습니다.
- 보고서·논문 같은 딱딱한 표현을 쓰지 않습니다. 쓰지 말 것: "~라는 뜻이에요", "~을 의미합니다", "~단계에 있습니다", "~이 자리 잡고 있다", "~이 관찰되었습니다", "~으로 보입니다", "~할 필요가 있습니다", "향상되었습니다", "기반으로", "측면에서", "역량", "도모", "함양", "~하는 모습을 보였습니다", "긍정적인", "효과적으로", "지속적으로", "체계적으로".
- 대신 일상 말로 풀어 씁니다. 예: "단어 실력이 자리 잡고 있다는 뜻이에요" → "요즘 단어는 거의 놓치지 않고 외워 와요", "구문 분석 역량이 향상되었습니다" → "긴 문장도 이제 혼자 끊어 읽어요", "지속적으로 지도하겠습니다" → "수업 시작할 때마다 5분씩 같이 연습해 볼게요".
- 문장은 짧고 쉽게. 한 문장에 한 가지 이야기. 같은 말로 시작하는 문장을 이어 쓰지 않습니다.
- 칭찬은 구체적인 장면으로("발표할 때 목소리가 커졌어요"), 부족한 점은 걱정이 아니라 함께 할 계획으로("아직 헷갈려해서 다음 주에 한 번 더 짚어 줄게요") 씁니다.
- 느낌표, 이모지, 형식적인 인사말("안녕하세요 어머님")은 쓰지 않습니다.

초안을 다듬어 같은 JSON 형식으로만 답하세요.
- 기록 요약에 없는 사실(점수, 날짜, 행동, 일화)이 있으면 지웁니다. 사실을 새로 만들지 않습니다.
- 근거(날짜·항목·점수·횟수·변화)가 빠진 막연한 문장은 기록 요약에서 근거를 찾아 넣고, 찾을 수 없으면 지웁니다.
- 상투어("열심히 했어요", "잘했어요" 단독, "지켜봐 주세요"), 느낌표, 이모지, 반복되는 문장 시작을 고칩니다.
- 부족한 부분에는 학원의 구체적인 지도 방법·빈도가 함께 있는지 확인하고, 없으면 기록에 맞게 보탭니다.
- 문장은 따뜻하고 차분한 존댓말로, 경험 많은 선생님이 직접 쓴 것처럼 자연스럽게 다듬습니다.
- 빈 칸("" 또는 [])은 근거가 없으면 그대로 둡니다.
- 여러 칸에 같은 사실·비슷한 문장이 있으면 가장 알맞은 한 칸에만 남기고 나머지는 지웁니다. 다음 진도·시험 준비 이야기는 next_week에만 둡니다.
- skills는 "영역|단계|진단" 형식을 지키고, 단계는 도입·발전·안정·심화 중 하나만 씁니다. goals는 확인 가능한 목표(숫자·횟수·항목)로 다듬습니다.`;

/** 아이를 부르는 이름: 김민준 → 민준이, 이지우 → 지우 */
export function callName(name) {
  const n = String(name || '').trim();
  if (!/^[가-힣]+$/.test(n)) return n;
  const given = n.length >= 3 ? n.slice(1) : n;
  const last = given.charCodeAt(given.length - 1) - 0xac00;
  return last >= 0 && last % 28 !== 0 ? `${given}이` : given;
}

/** AI에게 줄 기록 요약 (JSON 대신 한국어 문장 — 더 자연스럽고 정확하게 써요) */
export function briefFor(f) {
  const w = f.period || 1;
  const L = [];
  const add = (t) => { if (t) L.push(t); };
  add(`학생: ${f.student}${f.class_name ? ` (${f.class_name})` : ''}${f.teacher ? `, 담당 ${f.teacher} 선생님` : ''} / 부르는 이름: ${callName(f.student)}`);
  add(`리포트 종류: ${labelsOf(w).name}${f.period?.unit === 'consult' ? ' (상담 때 학부모님과 함께 보며 이야기 나눌 리포트 — consult_points를 꼭 씁니다)' : ''}`);
  add(`리포트 기간: ${f.period.label} (${unitWord(w)})${f.books?.length ? `, 교재: ${f.books.join(', ')}` : ''}`);
  const a = f.attendance || {};
  add(`출결: 출석 ${a.present || 0}회, 지각 ${a.late || 0}회, 결석 ${a.absent || 0}회`);
  if (f.progress?.length > 24) {
    // 한 달·분기처럼 기간이 길면 교재별로 처음~마지막만 (AI가 길게 읽지 않게)
    add(`진도 요약 (수업 ${f.progress.length}회):`);
    const byBook = new Map();
    for (const p of f.progress) { const b = p.book || '수업'; if (!byBook.has(b)) byBook.set(b, []); byBook.get(b).push(p); }
    for (const [b, arr] of byBook) add(`- ${b}: ${dateShort(arr[0].date)} ${String(arr[0].done).split(' · ')[0]} → ${dateShort(arr[arr.length - 1].date)} ${String(arr[arr.length - 1].done).split(' · ')[0]} (${arr.length}회)`);
  } else if (f.progress?.length) {
    add('진도 (날짜: 실제 완료 / 계획):');
    for (const p of f.progress) add(`- ${dateShort(p.date)}: ${p.done}${p.changed ? ` (계획은 ${p.planned})` : ''}${p.homework ? ` / 숙제: ${p.homework}` : ''}`);
  }
  if (f.progress_rate != null) add(`계획한 진도 달성: ${f.progress_rate}%`);
  if (f.next_plan) add(`다음 학습 예정: ${f.next_plan}`);
  if (f.tests?.length) {
    add('시험:');
    for (const t of f.tests) add(`- ${dateShort(t.date)} ${t.kind} ${t.score}${t.result ? ` (${t.result})` : ''}`);
    for (const k of f.test_kinds || []) add(`- ${k.kind} 평균 ${k.avg ?? '-'}%${k.prevAvg != null ? ` (${prevWord(w)} ${k.prevAvg}%, 변화 ${k.change >= 0 ? '+' : ''}${k.change}%p)` : ''}${k.retests ? `, 재시험 ${k.retests}회` : ''}`);
  }
  for (const r of f.retests || []) add(`- 재시험 기록 ${dateShort(r.date)}: ${r.text}`);
  const hw = f.homework || {};
  if (hw.rate != null) add(`숙제: 완료 ${hw.done}회, 미흡 ${hw.partial}회, 미제출 ${hw.missing}회 → 완료율 ${hw.rate}%${hw.prev_rate != null ? ` (${prevWord(w)} ${hw.prev_rate}%)` : ''}`);
  if (f.areas?.length) {
    add('수업 중 학습 평가 (항목: 날짜별 평가 / 지난 기간과 비교):');
    for (const ar of f.areas) {
      const hint = TERM_HINTS[ar.name] ? ` [${ar.name} = ${TERM_HINTS[ar.name]}]` : '';
      add(`- ${ar.name}${ar.group === 'attitude' ? '(학습 태도)' : ''}: ${(ar.timeline && ar.timeline.length <= 10 ? ar.timeline : ar.marks).join(', ')}${ar.trend ? ` / 추세 ${ar.trend}` : ''}${ar.prev ? ` / ${prevWord(w)}: ${ar.prev}` : ''}${hint}`);
    }
  }
  const n = f.notes || {};
  const notesOut = (label, arr) => { if (arr?.length) { add(`${label}:`); for (const x of arr) add(`- ${dateShort(x.date)} ${x.text}`); } };
  notesOut('반복되는 실수·오답', n.mistakes);
  notesOut('이해가 부족한 개념', n.weak);
  notesOut('학원에서 이미 한 추가 지도', n.extra_done);
  notesOut('추가 지도가 필요한 내용', n.extra_need);
  notesOut('수업 중 선생님 한마디', n.comments);
  notesOut('선생님 특별 코멘트 (teacher_comment에 우선 반영)', n.special);
  if (f.works?.length) { add('학습 결과물 사진에 대한 선생님 확인 코멘트 (라이팅·교재 등 실제 결과물 근거 — strengths·practice·growth에 활용):'); for (const x of f.works) add(`- ${dateShort(x.date)} ${x.type}: ${x.comment}`); }
  if (f.prev_notes?.mistakes?.length) add(`${prevWord(w)} 기록된 실수: ${f.prev_notes.mistakes.join(' / ')} (이번 기간에 같은 실수가 줄었는지 비교)`);
  if (f.prev_notes?.extra_need?.length) add(`${prevWord(w)} 보강이 필요했던 내용: ${f.prev_notes.extra_need.join(' / ')} (보강 후 나아졌는지 비교)`);
  return L.join('\n');
}

function parseJson(text) {
  if (text && typeof text === 'object') return text;
  let t = String(text || '').trim();
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI 답에서 JSON을 찾지 못했어요');
  return JSON.parse(t.slice(a, b + 1));
}

/** "영역|단계|진단" 한 줄로 맞추기 (AI가 객체로 주거나 구분자를 다르게 써도) */
function normSkill(x) {
  let area = '', level = '', text = '';
  if (x && typeof x === 'object') { area = x.area || x.영역 || x.name || ''; level = x.level || x.단계 || ''; text = x.text || x.진단 || x.desc || x.evidence || ''; }
  else {
    const p = String(x || '').split('|');
    if (p.length >= 3) [area, level, text] = [p[0], p[1], p.slice(2).join(' ')];
    else { text = String(x || ''); const m = text.match(/^\s*([^:：]{1,8})\s*[:：]\s*(.+)$/); if (m && SKILL_AREAS.some((a) => m[1].includes(a.split('·')[0]))) { area = m[1]; text = m[2]; } }
  }
  area = String(area).trim().slice(0, 12); level = String(level).trim();
  if (!SKILL_LEVELS.includes(level)) level = SKILL_LEVELS.find((l) => level.includes(l)) || '';
  text = String(text).replace(/!+/g, '.').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) return '';
  return `${area || '종합'}|${level || '발전'}|${text}`;
}
export function cleanContent(o) {
  const out = {};
  const str = (v, max) => String(v == null ? '' : v).replace(/\s+\n/g, '\n').replace(/!+/g, '.').trim().slice(0, max);
  for (const k of SECTION_KEYS) {
    if (k === 'skills') out[k] = (Array.isArray(o[k]) ? o[k] : o[k] ? [o[k]] : []).map(normSkill).filter(Boolean).slice(0, 6);
    else if (LIST_KEYS.has(k)) out[k] = (Array.isArray(o[k]) ? o[k] : o[k] ? [o[k]] : []).map((x) => str(typeof x === 'object' ? Object.values(x).join(' ') : x, 500)).filter(Boolean).slice(0, 5);
    else out[k] = str(o[k], 1000);
  }
  return out;
}

async function runModel(env, model, messages) {
  const r = await env.AI.run(model, { messages, max_tokens: 3000, temperature: 0.4 });
  const text = typeof r === 'string' ? r : r?.response ?? r?.choices?.[0]?.message?.content ?? r?.result?.response;
  return cleanContent(parseJson(text));
}

async function aiWrite(env, settings, facts) {
  if (!env.AI) throw new Error('Workers AI가 연결되지 않았어요 (wrangler.toml의 [ai] 설정 확인)');
  const g = growthSettings(settings);
  const models = [g.model, ...FALLBACK_MODELS.filter((m) => m !== g.model)];
  const brief = briefFor(facts);
  let lastErr = null;
  for (const model of models) {
    try {
      // 1차: 초안
      let content = await runModel(env, model, [{ role: 'system', content: SYSTEM }, { role: 'user', content: `기록 요약:\n${brief}` }]);
      if (!content.overview && !content.strengths.length) throw new Error('AI 답이 비어 있어요');
      // 2차: 근거·문체 다듬기 (실패하면 초안 그대로)
      try {
        const polished = await runModel(env, model, [{ role: 'system', content: POLISH }, { role: 'user', content: `기록 요약:\n${brief}\n\n초안(JSON):\n${JSON.stringify(content)}` }]);
        if (polished.overview) content = polished;
      } catch { /* 초안 사용 */ }
      // 선생님 특별 코멘트가 있는데 AI가 비워 두면 메모 그대로라도 넣기
      const special = (facts.notes?.special || []).map((x) => x.text).filter(Boolean).join(' ');
      if (special && !content.teacher_comment) content.teacher_comment = special;
      return { content: refineContent(content, facts), model };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('AI 호출 실패');
}

const COMMENT_SYSTEM = `당신은 15년 넘게 아이들을 가르쳐 온 영어학원 원장입니다. 선생님이 짧게 적은 메모를 학부모님께 드리는 "선생님 코멘트"로 다듬습니다.
- 메모의 뜻과 사실은 그대로 살립니다. 메모와 기록 요약에 없는 사실(날짜·점수·일화)은 지어내지 않습니다.
- 3~4문장.
[말투 — 매우 중요: AI가 쓴 티가 나지 않게]
- 원장님이 어머님께 카톡으로 아이 소식을 전하듯, 친근하고 자연스러운 존댓말로 씁니다. ("~했어요", "~하고 있어요", "~해 볼게요", "~해 주시면 좋아요")
- 아이는 "학생", "해당 학생", "아동"이라고 부르지 않고 이름으로 부릅니다. 기록 요약의 "부르는 이름"(예: 민준이, 지우)을 쓰고, 매 문장마다 부르지 않습니다.
- 보고서·논문 같은 딱딱한 표현을 쓰지 않습니다. 쓰지 말 것: "~라는 뜻이에요", "~을 의미합니다", "~단계에 있습니다", "~이 자리 잡고 있다", "~이 관찰되었습니다", "~으로 보입니다", "~할 필요가 있습니다", "향상되었습니다", "기반으로", "측면에서", "역량", "도모", "함양", "~하는 모습을 보였습니다", "긍정적인", "효과적으로", "지속적으로", "체계적으로".
- 대신 일상 말로 풀어 씁니다. 예: "단어 실력이 자리 잡고 있다는 뜻이에요" → "요즘 단어는 거의 놓치지 않고 외워 와요", "구문 분석 역량이 향상되었습니다" → "긴 문장도 이제 혼자 끊어 읽어요", "지속적으로 지도하겠습니다" → "수업 시작할 때마다 5분씩 같이 연습해 볼게요".
- 문장은 짧고 쉽게. 한 문장에 한 가지 이야기. 같은 말로 시작하는 문장을 이어 쓰지 않습니다.
- 칭찬은 구체적인 장면으로("발표할 때 목소리가 커졌어요"), 부족한 점은 걱정이 아니라 함께 할 계획으로("아직 헷갈려해서 다음 주에 한 번 더 짚어 줄게요") 씁니다.
- 느낌표, 이모지, 형식적인 인사말("안녕하세요 어머님")은 쓰지 않습니다.
- 구성: 아이의 모습(관찰) → 그것이 어떤 성장인지(의미) → 학원에서의 다음 지도 → 가정에 드리는 짧은 부탁이나 격려(필요할 때만).
- 상투어("열심히 했어요", "잘했어요" 단독, "지켜봐 주세요"), 느낌표, 이모지는 쓰지 않습니다.
- 다듬은 코멘트 문장만 출력합니다. 따옴표나 설명을 붙이지 않습니다.`;

/** 선생님이 짧게 쓴 코멘트를 친절하고 전문적인 문장으로 (리포트 편집 화면의 "AI로 다듬기") */
export async function polishComment(env, settings, facts, text) {
  if (!env.AI) throw new Error('Workers AI가 연결되지 않았어요');
  const g = growthSettings(settings);
  const models = [g.model, ...FALLBACK_MODELS.filter((m) => m !== g.model)];
  const brief = facts ? briefFor(facts) : '';
  let lastErr = null;
  for (const model of models) {
    try {
      const r = await env.AI.run(model, { messages: [{ role: 'system', content: COMMENT_SYSTEM }, { role: 'user', content: `${brief ? `기록 요약:\n${brief}\n\n` : ''}선생님 메모:\n${String(text).slice(0, 1000)}` }], max_tokens: 800, temperature: 0.5 });
      let out = typeof r === 'string' ? r : r?.response ?? r?.choices?.[0]?.message?.content ?? r?.result?.response;
      out = String(out || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^["“']|["”']$/g, '').replace(/!+/g, '.').trim();
      if (out.length < 10) throw new Error('AI 답이 비어 있어요');
      return out.slice(0, 1000);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('AI 호출 실패');
}

// ───────── 원장님이 직접 적은 짧은 멘트를 자연스럽고 전문적으로 (칸 하나 / 리포트 전체) ─────────
const FIELD_GUIDE = {
  overview: '학습 성취도 총평: 5~6문장 한 단락',
  skills: '영역별 학습 진단: 한 줄에 "영역|단계|진단" (단계는 도입·발전·안정·심화 중 하나, 진단 2~3문장)',
  concepts: '이번 기간 주요 학습 개념: 2~3문장',
  strengths: '잘하고 있는 부분: 항목마다 2~3문장 (관찰→의미→다음 지도)',
  growth: '지난 기간보다 성장한 부분: 항목마다 2~3문장',
  practice: '조금 더 연습이 필요한 부분: 항목마다 2~3문장, 학원의 지도 방법·빈도 포함',
  weak_concepts: '어려워하는 학습 개념: 항목마다 2~3문장, 지도 계획 포함',
  academy_done: '학원에서 이미 지도한 내용: 항목마다 1~2문장',
  academy_plan: '앞으로 학원에서 지도할 계획: 항목마다 1~2문장 (무엇을·얼마나 자주·어떻게)',
  goals: '다음 기간 학습 목표: 항목마다 한 줄, 숫자·횟수로 확인할 수 있게',
  next_week: '다음 기간 학습 예정: 2문장',
  home_tips: '가정에서 도와주시면 좋은 부분: 항목마다 하루 5~10분 안에 할 수 있는 구체적인 행동',
  consult_points: '상담 때 함께 이야기 나눌 주제: 항목마다 1~2문장',
  teacher_comment: '선생님의 특별 코멘트: 3~4문장',
};
const MEMO_SYSTEM = `당신은 15년 넘게 아이들을 가르쳐 온 영어학원 원장입니다. 원장님이 성장 리포트의 칸에 짧게 적은 메모를, 학부모님께 드리는 자연스럽고 전문적인 문장으로 고쳐 씁니다.
- 메모의 뜻·사실·판단은 그대로 살립니다. 메모가 말한 것을 빼거나 반대로 바꾸지 않습니다.
- 기록 요약에 있는 근거(날짜·항목·점수·횟수·변화)가 메모와 맞으면 함께 넣어 구체적으로 만듭니다. 기록에도 메모에도 없는 사실은 지어내지 않습니다.
- 학원 용어는 처음 나올 때 괄호로 쉽게 풀어 줍니다.
[말투 — 매우 중요: AI가 쓴 티가 나지 않게]
- 원장님이 어머님께 카톡으로 아이 소식을 전하듯, 친근하고 자연스러운 존댓말로 씁니다. ("~했어요", "~하고 있어요", "~해 볼게요", "~해 주시면 좋아요")
- 아이는 "학생", "해당 학생", "아동"이라고 부르지 않고 이름으로 부릅니다. 기록 요약의 "부르는 이름"(예: 민준이, 지우)을 쓰고, 매 문장마다 부르지 않습니다.
- 보고서·논문 같은 딱딱한 표현을 쓰지 않습니다. 쓰지 말 것: "~라는 뜻이에요", "~을 의미합니다", "~단계에 있습니다", "~이 자리 잡고 있다", "~이 관찰되었습니다", "~으로 보입니다", "~할 필요가 있습니다", "향상되었습니다", "기반으로", "측면에서", "역량", "도모", "함양", "~하는 모습을 보였습니다", "긍정적인", "효과적으로", "지속적으로", "체계적으로".
- 대신 일상 말로 풀어 씁니다. 예: "단어 실력이 자리 잡고 있다는 뜻이에요" → "요즘 단어는 거의 놓치지 않고 외워 와요", "구문 분석 역량이 향상되었습니다" → "긴 문장도 이제 혼자 끊어 읽어요", "지속적으로 지도하겠습니다" → "수업 시작할 때마다 5분씩 같이 연습해 볼게요".
- 문장은 짧고 쉽게. 한 문장에 한 가지 이야기. 같은 말로 시작하는 문장을 이어 쓰지 않습니다.
- 칭찬은 구체적인 장면으로("발표할 때 목소리가 커졌어요"), 부족한 점은 걱정이 아니라 함께 할 계획으로("아직 헷갈려해서 다음 주에 한 번 더 짚어 줄게요") 씁니다.
- 느낌표, 이모지, 형식적인 인사말("안녕하세요 어머님")은 쓰지 않습니다.`;

function aiText(r) { return typeof r === 'string' ? r : r?.response ?? r?.choices?.[0]?.message?.content ?? r?.result?.response; }

/** 칸 하나 다듬기 → 문자열 또는 줄 목록 */
export async function polishField(env, settings, facts, field, text) {
  if (!env.AI) throw new Error('Workers AI가 연결되지 않았어요');
  if (field === 'teacher_comment') return polishComment(env, settings, facts, text);
  const g = growthSettings(settings);
  const models = [g.model, ...FALLBACK_MODELS.filter((m) => m !== g.model)];
  const isList = LIST_KEYS.has(field);
  const ask = `${facts ? `기록 요약:\n${briefFor(facts)}\n\n` : ''}고칠 칸: ${FIELD_GUIDE[field] || field}\n원장님 메모:\n${String(text).slice(0, 2000)}\n\n`
    + (isList ? '메모의 각 줄(항목)을 다듬어 JSON 문자열 배열 하나만 출력하세요. 예: ["…","…"]' : '다듬은 문장만 출력하세요. 따옴표나 설명을 붙이지 마세요.');
  let lastErr = null;
  for (const model of models) {
    try {
      const r = await env.AI.run(model, { messages: [{ role: 'system', content: MEMO_SYSTEM }, { role: 'user', content: ask }], max_tokens: 1500, temperature: 0.4 });
      let out = String(aiText(r) || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (isList) {
        const a = out.indexOf('['), b = out.lastIndexOf(']');
        let arr = a >= 0 && b > a ? JSON.parse(out.slice(a, b + 1)) : out.split('\n');
        arr = cleanContent({ [field]: arr })[field];
        if (!arr.length) throw new Error('AI 답이 비어 있어요');
        return arr;
      }
      out = out.replace(/^["“']|["”']$/g, '').replace(/!+/g, '.').trim();
      if (out.length < 5) throw new Error('AI 답이 비어 있어요');
      return out.slice(0, 1500);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('AI 호출 실패');
}

/** 원장님이 고친 리포트 전체 다듬기 — 고친 칸만, 칸마다 동시에 (기다리는 시간 = 가장 긴 칸 하나) */
export async function polishAll(env, settings, facts, content, base) {
  if (!env.AI) throw new Error('Workers AI가 연결되지 않았어요');
  const src = cleanContent(content || {});
  const orig = base ? cleanContent(base) : null;
  const same = (a, b) => JSON.stringify(a || '') === JSON.stringify(b || '');
  const empty = (v) => (Array.isArray(v) ? !v.length : !String(v || '').trim());
  // 원장님이 손댄 칸만 다듬어요 (AI가 쓴 그대로인 칸은 건드리지 않아 빨라요)
  const keys = SECTION_KEYS.filter((k) => !empty(src[k]) && (!orig || !same(src[k], orig[k])));
  const out = { ...src };
  const res = await Promise.all(keys.map((k) => polishField(env, settings, facts, k, Array.isArray(src[k]) ? src[k].join('\n') : src[k]).then((v) => [k, v]).catch(() => [k, src[k]])));
  for (const [k, v] of res) out[k] = v;
  return { content: refineContent(out, facts), changed: keys };
}

/** AI를 못 쓸 때: 기록만으로 정리 (지어내지 않고, 기록을 날짜·평가와 함께 문장으로 옮기기만) */
export function ruleWrite(f) {
  const w = f.period || 1;
  const j = (arr) => (arr || []).map((x) => `${dateShort(x.date)} ${x.text}`).filter(Boolean);
  const byCat = (marks) => (f.areas || []).filter((a) => (a.timeline || []).some((t) => marks.some((m) => t.includes(m))));
  const tl = (a, marks) => (a.timeline || []).filter((t) => marks.some((m) => t.includes(m))).join(', ');
  const att = f.attendance || {};
  const hw = f.homework || {};
  const tk = (f.test_kinds || []).map((k) => `${k.kind} 평균 ${k.avg}%${k.change != null ? `(${prevWord(w)}보다 ${k.change >= 0 ? '+' : ''}${k.change}%p)` : ''}`).join(', ');
  const overview = [
    `${f.student}는 ${unitWord(w)} 동안 ${(att.present || 0) + (att.late || 0)}번의 수업에 참여했어요${att.absent ? ` (결석 ${att.absent}회)` : ''}.`,
    f.progress?.length ? `${f.books?.length ? f.books.join(', ') + ' ' : ''}${f.progress[0].done.split(' · ')[0]}부터 ${f.progress[f.progress.length - 1].done.split(' · ')[0]}까지 학습했어요.` : '',
    tk ? `시험은 ${tk}였어요.` : '',
    hw.rate != null ? `숙제 완료율은 ${hw.rate}%${hw.prev_rate != null ? `로 ${prevWord(w)} ${hw.prev_rate}%와 비교할 수 있어요` : '예요'}.` : '',
  ].filter(Boolean).join(' ');
  return {
    overview,
    concepts: '',
    strengths: byCat(['매우 잘함', '잘함']).map((a) => `${a.name}: ${tl(a, ['매우 잘함', '잘함'])} 평가를 받았어요.`),
    growth: byCat(['향상 중']).map((a) => `${a.name}: ${tl(a, ['향상 중'])}에 이전보다 나아진 모습이 기록됐어요.`),
    practice: byCat(['반복 연습 필요']).map((a) => `${a.name}: ${tl(a, ['반복 연습 필요'])} — 수업에서 반복 연습을 이어 가고 있어요.`),
    weak_concepts: [...byCat(['개념 확인 필요']).map((a) => `${a.name}: ${tl(a, ['개념 확인 필요'])} — 개념을 다시 짚어 주고 있어요.`), ...j(f.notes?.weak)],
    academy_done: [...j(f.notes?.extra_done), ...byCat(['복습 진행']).map((a) => `${a.name}: ${tl(a, ['복습 진행'])} 복습을 진행했어요.`)],
    academy_plan: [...j(f.notes?.extra_need), ...byCat(['개별 지도 필요']).map((a) => `${a.name}: 개별 지도로 보완할 예정이에요.`), ...byCat(['진도 보류']).map((a) => `${a.name}: 충분히 익힌 뒤 다음 진도로 넘어갈 예정이에요.`)],
    next_week: f.next_plan ? `다음에는 ${f.next_plan}을(를) 학습할 예정이에요.` : '',
    home_tips: [],
    teacher_comment: (f.notes?.special || []).map((x) => x.text).join(' ') || (f.notes?.comments || []).slice(-2).map((x) => x.text).join(' '),
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
    if (MSG_KIND[r.kind]) refs.add(`${MSG_KIND[r.kind]}|${r.ref}`);
  }
  // [{ kind: 'growth' | 'growth1', ref }]
  return [...refs].map((x) => { const [kind, ref] = x.split('|'); return { kind, ref }; });
}

// ───────── 반복 문구 걸러내기 · 근거 없는 칸 비우기 ─────────
const ORDER = ['overview', 'next_week', 'concepts', 'strengths', 'growth', 'practice', 'weak_concepts', 'academy_done', 'academy_plan', 'skills', 'goals', 'home_tips', 'teacher_comment'];
const norm = (t) => String(t).replace(/[\s.,·:;'"()\[\]~\-]/g, '').toLowerCase();
const grams = (t) => { const s = norm(t); const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
const similar = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };
const sentences = (t) => String(t).split(/(?<=[다요]\.)\s+|(?<=[.?])\s+(?=[가-힣A-Za-z0-9])|\n+/).map((x) => x.trim()).filter(Boolean);

/** 앞 칸과 겹치는 문장을 지워요 (AI가 같은 말을 반복하지 않게) */
export function refineContent(c, f) {
  if (!c || !f) return c;
  const n = f.notes || {};
  const out = { ...c };
  if (f.period && f.period.unit !== 'consult') out.consult_points = [];
  // 성은 빼고 이름으로 (김예나는 → 예나는)
  const full = String(f.student || '').trim();
  if (/^[가-힣]{3,4}$/.test(full)) {
    const given = full.slice(1);
    const fix = (t) => String(t).split(full).join(given);
    for (const k of Object.keys(out)) out[k] = Array.isArray(out[k]) ? out[k].map(fix) : typeof out[k] === 'string' ? fix(out[k]) : out[k];
  }
  // 칸은 그대로 두고, 같은·비슷한 문장이 다시 나오면 지워요 (다음 진도 이야기는 "다음 학습 예정" 칸을 먼저 살려요)
  const seen = [];
  const keep = (sent) => {
    const g = grams(sent);
    if (g.size < 4) return true;
    if (seen.some((s) => similar(g, s) >= 0.5)) return false;
    seen.push(g);
    return true;
  };
  for (const k of ORDER) {
    if (k === 'skills' && Array.isArray(out[k])) {
      out[k] = out[k].map((item) => { const p = String(item).split('|'); if (p.length < 3) return item; const t = sentences(p.slice(2).join(' ')).filter((s) => keep(s)).join(' '); return t ? `${p[0]}|${p[1]}|${t}` : ''; }).filter(Boolean);
    } else if (Array.isArray(out[k])) {
      out[k] = out[k].map((item) => sentences(item).filter((s) => keep(s)).join(' ')).filter(Boolean);
    } else if (out[k]) {
      out[k] = sentences(out[k]).filter((s) => keep(s)).join(' ');
    }
  }
  // 선생님 메모가 있는데 코멘트가 비었으면 메모라도
  if (!out.teacher_comment) out.teacher_comment = (n.special || []).map((x) => x.text).join(' ') || '';
  return out;
}

export function contentOf(r) {
  try { if (r.edited) return cleanContent(JSON.parse(r.edited)); } catch { /* */ }
  try { if (r.ai) { const f = JSON.parse(r.facts || 'null'); return refineContent(cleanContent(JSON.parse(r.ai)), f); } } catch { /* */ }
  return null;
}

// ───────── 알림톡 값 ─────────
export function growthVars(settings, baseUrl, r, facts) {
  const tk = facts.test_kinds || [];
  return {
    학원: settings.academy || '', 학원연락처: settings.academy_phone || '', 학생명: facts.student, 반: facts.class_name,
    기간: facts.period?.label || '', 날짜: facts.period?.label || '', 학습기간: facts.period?.label || '',
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
  const W = facts.period || 1;
  L.push(`[${settings.academy || '학원'}] ${labelsOf(W).name}`, `${facts.student} · ${facts.period.label}`);
  sec(`${labelsOf(W).cur} 학습 진도`, [...(facts.progress || []).map((p) => `${dateShort(p.date)} ${p.done}`), c.concepts]);
  sec(`${labelsOf(W).cur} 시험 결과`, (facts.tests || []).map((t) => `${dateShort(t.date)} ${t.kind} ${t.score}${t.result ? ` (${t.result})` : ''}`));
  sec('학습 성취도', c.overview);
  sec('영역별 학습 진단', (c.skills || []).map((x) => { const p = String(x).split('|'); return p.length >= 3 ? `${p[0]} (${p[1]} 단계): ${p.slice(2).join(' ')}` : x; }));
  sec('잘하고 있는 부분', c.strengths);
  sec(`${prevWord(W)}보다 성장한 부분`, c.growth);
  sec('조금 더 연습이 필요한 부분', c.practice);
  sec('어려워하는 학습 개념', c.weak_concepts);
  sec('학원에서 지도한 내용', c.academy_done);
  sec('학원에서 추가로 지도할 부분', c.academy_plan);
  sec(`${labelsOf(W).next} 학습 목표`, c.goals);
  sec(`${labelsOf(W).next} 학습 예정`, c.next_week);
  sec('가정에서 도와주시면 좋은 부분', c.home_tips);
  sec('상담 때 함께 이야기 나눌 부분', c.consult_points);
  sec('선생님 코멘트', c.teacher_comment);
  sec('학습 결과물', (facts.works || []).map((w) => `${dateShort(w.date)} ${w.type}: ${w.comment}`));
  return L.join('\n\n');
}

// ───────── 학부모 리포트 페이지 (파스텔톤, 인쇄·PDF 가능) ─────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const MARK_COLOR = { '매우 잘함': '#cdeec0', '잘함': '#e3f5d6', '향상 중': '#d8e8ff', '반복 연습 필요': '#fff1b8', '개념 확인 필요': '#ffe3cc', '개별 지도 필요': '#ffd2b0', '복습 진행': '#e8dcff', '진도 보류': '#e6e6e6' };

// ───────── 그래프 (서버에서 SVG로 그려서 넣어요 — 학부모 휴대폰에서 바로 보이게) ─────────
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a']; // 검증된 기본 팔레트 1~3번 (밝은 화면용)

/** 시험 점수 추이: 지난 기간 + 이번 기간, 시험 종류별 선 (최대 3종류) */
export function testChart(series, weeks) {
  const pts = (series || []).filter((p) => p.pct != null && !isVoca(p.kind));
  // 이번 기간에 Weekly·Monthly 시험이 있을 때만, 누적 점수가 2개 이상일 때만 그려요
  if (pts.length < 2 || !pts.some((p) => p.period === 'cur')) return '';
  const kindsAll = [...new Set(pts.map((p) => p.kind))];
  const kinds = kindsAll.sort((a, b) => pts.filter((p) => p.kind === b).length - pts.filter((p) => p.kind === a).length).slice(0, 3);
  const dates = [...new Set(pts.filter((p) => kinds.includes(p.kind)).map((p) => p.date))].sort();
  if (dates.length < 2) return '';
  // 휴대폰 화면 폭에 맞춘 크기 (글자가 작아지지 않게)
  const W = 360, H = 200, L = 30, R = 74, T = 24, B = 26;
  const minV = Math.min(...pts.filter((p) => kinds.includes(p.kind)).map((p) => p.pct));
  const lo = Math.max(0, Math.min(50, Math.floor((minV - 10) / 10) * 10)); // 아래쪽을 잘라 변화가 잘 보이게
  const x = (d) => L + (dates.indexOf(d) / (dates.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (100 - lo)) * (H - T - B);
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const firstCur = dates.find((d) => pts.some((p) => p.date === d && p.period === 'cur'));
  const lastPrev = [...dates].reverse().find((d) => pts.some((p) => p.date === d && p.period === 'prev'));
  let shade = '';
  if (lastPrev && firstCur) {
    const mid = (x(lastPrev) + x(firstCur)) / 2;
    shade = `<rect x="${L}" y="${T}" width="${mid - L}" height="${H - T - B}" fill="#f3f2f8"/>
      <text x="${(L + mid) / 2}" y="${T - 8}" text-anchor="middle" class="ax">이전 기록</text>
      <text x="${(mid + W - R) / 2}" y="${T - 8}" text-anchor="middle" class="ax">${labelsOf(weeks).cur}</text>`;
  }
  const grid = [lo, Math.round((lo + 100) / 2), 100].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e6e4ee" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${v}</text>`).join('');
  const step = Math.ceil(dates.length / 5);
  const xlab = dates.map((d, i) => (i % step === 0 || i === dates.length - 1)
    ? `<text x="${x(d)}" y="${H - 8}" text-anchor="middle" class="ax">${md(d)}</text>` : '').join('');
  const labels = [];
  const lines = kinds.map((k, i) => {
    const col = SERIES[i];
    const ps = pts.filter((p) => p.kind === k).sort((a, b) => a.date.localeCompare(b.date));
    // 같은 날 같은 시험이 여러 번이면 평균
    const byDate = new Map();
    for (const p of ps) { if (!byDate.has(p.date)) byDate.set(p.date, []); byDate.get(p.date).push(p.pct); }
    const arr = [...byDate].map(([d, v]) => ({ d, v: Math.round(v.reduce((a, b) => a + b, 0) / v.length) }));
    const path = arr.map((p, j) => `${j ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const dots = arr.map((p) => `<circle cx="${x(p.d).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4" fill="${col}" stroke="#fff" stroke-width="2"><title>${esc(k)} ${md(p.d)} · ${p.v}%</title></circle>`).join('');
    const last = arr[arr.length - 1];
    labels.push({ y: y(last.v), text: `${k} ${last.v}%`, col });
    return `<path d="${path}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join('');
  // 끝 라벨이 겹치지 않게 아래로 밀기
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
  const endLabels = labels.map((l) => `<text x="${W - R + 8}" y="${l.y + 4}" class="lb">${esc(l.text)}</text>`).join('');
  const legend = kinds.length >= 2 ? `<div class="legend">${kinds.map((k, i) => `<span><i style="background:${SERIES[i]}"></i>${esc(k)}</span>`).join('')}</div>` : '';
  return `<div class="chart"><div class="ct">단원·최종 평가 점수 추이 <small>(최근 6개월 누적, 맞은 비율 %)</small></div>${legend}
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="시험 점수 추이 그래프">${shade}${grid}${xlab}${lines}${endLabels}</svg></div>`;
}

/** 숙제 완료율: 지난 기간 vs 이번 기간 (같은 지표라 한 색, 지난 기간은 연하게) */
export function homeworkChart(hw, weeks) {
  if (!hw || hw.rate == null) return '';
  const row = (label, v, faded) => `<div class="bar"><span class="bl">${label}</span><span class="bt"><span class="bf" style="width:${Math.max(2, v)}%;background:${SERIES[0]};opacity:${faded ? 0.4 : 1}"></span></span><span class="bv">${v}%</span></div>`;
  return `<div class="chart"><div class="ct">숙제 완료율</div>${hw.prev_rate != null ? row(labelsOf(weeks).prev, hw.prev_rate, true) : ''}${row(labelsOf(weeks).cur, hw.rate, false)}</div>`;
}

const LEVEL_COLOR = { 도입: '#ffe3cc', 발전: '#fff1b8', 안정: '#d8f0c8', 심화: '#d8e8ff' };
function skillsHtml(list) {
  if (!list || !list.length) return '';
  const rows = list.map((x) => {
    const p = String(x).split('|');
    if (p.length < 3) return `<div class="sk"><div class="skt">${esc(x)}</div></div>`;
    const lv = p[1];
    const idx = Math.max(0, ['도입', '발전', '안정', '심화'].indexOf(lv));
    const steps = ['도입', '발전', '안정', '심화'].map((s, i) => `<span class="st${i <= idx ? ' on' : ''}" style="${i <= idx ? `background:${LEVEL_COLOR[lv] || '#e9e6ff'}` : ''}">${s}</span>`).join('');
    return `<div class="sk"><div class="skh"><b>${esc(p[0])}</b><span class="steps">${steps}</span></div><div class="skt">${esc(p.slice(2).join(' '))}</div></div>`;
  }).join('');
  return `<div class="skills">${rows}</div><div class="sub" style="margin-top:6px">단계: 도입(처음 배우는 중) · 발전(도움을 받아 해내는 중) · 안정(스스로 정확히 해냄) · 심화(응용·확장)</div>`;
}
function goalsHtml(list) {
  if (!list || !list.length) return '';
  return `<ul class="goals">${list.map((g) => `<li><span class="gk">◎</span>${esc(g)}</li>`).join('')}</ul>`;
}
export function reportHtml(settings, r, facts, c, opts = {}) {
  const g = growthSettings(settings);
  const W = facts.period || 1;
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
    <div class="chips">${tk.map((k) => `<span class="chip">${esc(k.kind)} 평균 ${k.avg != null ? `${k.avg}%` : '-'}${k.change != null ? ` <b class="${k.change >= 0 ? 'up' : 'down'}">${k.change >= 0 ? '▲' : '▼'} ${Math.abs(k.change)}</b> <small>${prevWord(W)} 대비</small>` : ''}</span>`).join('')}</div>
    ${(facts.retests || []).length ? `<div class="sub">재시험: ${facts.retests.map((x) => esc(`${dateShort(x.date)} ${x.text}`)).join(' / ')}</div>` : ''}` : '';
  const areas = (facts.areas || []).length ? `<div class="areas">${facts.areas.map((a) => `<div class="area"><div class="an">${esc(a.name)}${a.trend ? ` <small class="tr ${a.trend === '상승' ? 'up' : a.trend === '하락' ? 'down' : ''}">${esc(a.trend)}</small>` : ''}</div><div>${a.marks.map((m) => { const base = m.replace(/ \d+회$/, ''); return `<span class="mk" style="background:${MARK_COLOR[base] || '#eee'}">${esc(m)}</span>`; }).join('')}</div></div>`).join('')}</div>` : '';
  const hw = facts.homework || {};
  const ach = `${p(c.overview)}${homeworkChart(facts.homework, W)}${areas}<div class="chips">${hw.rate != null ? `<span class="chip">숙제 완료율 ${hw.rate}%${hw.prev_rate != null ? ` <small>(${prevWord(W)} ${hw.prev_rate}%)</small>` : ''}</span>` : ''}${facts.progress_rate != null ? `<span class="chip">계획 진도 달성 ${facts.progress_rate}%</span>` : ''}</div>`;
  const academy = `${c.academy_done.length ? `<h3>이번 기간 학원에서 지도한 내용</h3>${ul(c.academy_done)}` : ''}${c.academy_plan.length ? `<h3>앞으로 지도할 계획</h3>${ul(c.academy_plan)}` : ''}`;
  const photos = (facts.media || []).length ? `<div class="photos">${facts.media.map((t) => `<img src="/m/${esc(t)}" loading="lazy" alt="">`).join('')}</div>` : '';
  const wsrc = opts.workSrc || ((w) => `/r/${esc(r.token)}/w/${esc(w.token)}`);
  const works = (opts.works || []).length ? `<div class="works">${opts.works.map((w) => `<figure class="work"><a href="${wsrc(w)}" target="_blank" rel="noopener"><img src="${wsrc(w)}" loading="lazy" alt="${esc(typeLabel(w.type))}"></a><figcaption><div class="wt">${esc(dateShort(w.date))} · ${esc(typeLabel(w.type))}</div>${w.comment ? `<p>${esc(w.comment)}</p>` : ''}</figcaption></figure>`).join('')}</div>` : '';
  const badge = r.source === 'rule' ? '<div class="note">이번 리포트는 AI 없이 수업 기록만으로 정리했어요.</div>' : '';
  const body = [
    sec('학생 이름 및 학습 기간', head),
    sec(`${labelsOf(W).cur} 학습 진도`, prog + p(c.concepts)),
    sec(`${labelsOf(W).cur} 시험 결과`, tests ? testChart(facts.test_series, W) + tests : ''),
    sec('학습 성취도', ach),
    sec('영역별 학습 진단', skillsHtml(c.skills), 'skills-sec'),
    sec('우리 아이가 잘하고 있는 부분', ul(c.strengths), 'mint'),
    sec(`${prevWord(W)}보다 성장한 부분`, ul(c.growth), 'sky'),
    sec('조금 더 연습이 필요한 부분', ul(c.practice), 'lemon'),
    sec('이해가 부족하거나 어려워하는 학습 개념', ul(c.weak_concepts), 'peach'),
    sec('학원에서 추가로 지도할 부분', academy, 'lilac'),
    sec(`${labelsOf(W).next} 학습 목표`, goalsHtml(c.goals), 'sky'),
    sec(`${labelsOf(W).next} 학습 예정 내용`, p(c.next_week) || p(facts.next_plan ? `다음에는 ${facts.next_plan}을(를) 학습할 예정이에요.` : '')),
    sec('가정에서 함께 도와주시면 좋은 부분', ul(c.home_tips)),
    sec('상담 때 함께 이야기 나눌 부분', ul(c.consult_points), 'lilac'),
    sec('선생님의 특별 코멘트', p(c.teacher_comment), 'note-sec'),
    sec('학습 결과물 및 활동 사진', works + photos),
  ].join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(facts.student)} ${labelsOf(W).name}</title>
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
.works{display:grid;gap:12px}.work{margin:0;display:grid;grid-template-columns:minmax(110px,38%) 1fr;gap:12px;align-items:start;border:1px solid #efecf6;border-radius:14px;padding:10px;background:#fcfbff}
.work img{width:100%;border-radius:10px;background:#eee;display:block}.work .wt{font-size:12px;font-weight:700;color:#5b6bb5;margin-bottom:2px}.work p{font-size:14px;margin:4px 0 0}
@media (max-width:480px){.work{grid-template-columns:1fr}}
.skills{display:grid;gap:8px}.sk{border:1px solid #efecf6;border-radius:12px;padding:10px 12px;background:#fff}.skh{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}.skh b{font-size:14px;min-width:64px}
.steps{display:inline-flex;gap:3px}.st{font-size:11px;padding:2px 7px;border-radius:999px;background:#f3f1fa;color:#9a9db0}.st.on{color:#2b2a33;font-weight:600}.skt{font-size:14px}
.goals{list-style:none;padding-left:0}.goals li{margin:5px 0;padding-left:22px;position:relative}.gk{position:absolute;left:0;color:#5b6bb5}
.photos{margin-top:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}.photos img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:12px;background:#eee}
.note{background:#fff8e6;border-radius:10px;padding:8px 12px;font-size:13px;color:#7a6020;margin-bottom:10px}
.tools{display:flex;gap:8px;justify-content:flex-end;margin-bottom:10px}.tools button{border:1px solid #dcd7ea;background:#fff;border-radius:999px;padding:7px 14px;font:inherit;font-size:13px;cursor:pointer}
.foot{text-align:center;color:#9a9db0;font-size:12px;margin-top:20px}
.chart{margin:6px 0 14px}.ct{font-size:13px;font-weight:700;color:#4b5068;margin-bottom:6px}.ct small{font-weight:500;color:#8a8ea0}
.chart svg{width:100%;max-width:560px;height:auto;display:block}.chart .ax{font-size:10px;fill:#8a8ea0}.chart .lb{font-size:11px;font-weight:600;fill:#2b2a33}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:#52514e;margin-bottom:4px}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.bar{display:grid;grid-template-columns:64px 1fr 44px;align-items:center;gap:8px;margin:6px 0;font-size:13px}.bl{color:#6b6f80}.bt{background:#f0eef6;border-radius:6px;height:14px;overflow:hidden}.bf{display:block;height:100%;border-radius:0 4px 4px 0}.bv{font-weight:700;text-align:right}
@media print{body{background:#fff}.tools{display:none}main{padding:0}.sec{border-color:#e6e3ee}}
</style></head><body><main>
${opts.noTools ? '' : '<div class="tools"><button onclick="window.print()">PDF 저장 · 인쇄</button></div>'}
<div class="cover"><div class="brand">${esc(g.brand || 'PAMUS ENGLISH')}</div><div class="ttl">${labelsOf(W).title}</div><div class="subt">우리 아이의 ${labelsOf(W).subt} 성장 이야기</div><div class="campus">${esc(settings.academy || '')}</div></div>
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
  const works = facts.period ? await worksForReport(env, r.student_id, facts.period.from, facts.period.to).catch(() => []) : [];
  return new Response(reportHtml(settings, r, facts, c, { works }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
/** 리포트 속 결과물 사진: 리포트 비밀번호를 통과한 경우에만 */
export async function reportWorkImage(env, request, token, wtoken) {
  const r = await first(env, 'SELECT r.id, r.token, r.student_id, r.facts, s.phone FROM reports r LEFT JOIN students s ON s.id = r.student_id WHERE r.token = ?', token);
  if (!r) return new Response('없음', { status: 404 });
  const last4 = String(r.phone || '').replace(/\D/g, '').slice(-4);
  const want = last4 ? await sha(`${token}|${last4}|${env.TOKEN_ENC_KEY || 'cm'}`) : null;
  if (want && cookieOf(request, `rv_${token.slice(0, 10)}`) !== want) return new Response('리포트 비밀번호를 먼저 입력해 주세요', { status: 403 });
  const w = await first(env, 'SELECT * FROM works WHERE token = ? AND student_id = ? AND include = 1', wtoken, r.student_id);
  const p = JSON.parse(r.facts || '{}').period;
  if (!w || (p && (w.date < p.from || w.date > p.to))) return new Response('없음', { status: 404 });
  const obj = env.MEDIA ? await env.MEDIA.get(w.r2key) : null;
  if (!obj) return new Response('없음', { status: 404 });
  return new Response(obj.body, { headers: { 'content-type': w.mime || 'image/jpeg', 'cache-control': 'private, max-age=86400', 'x-robots-tag': 'noindex' } });
}

function pinForm(settings, err) {
  return page('리포트 확인', `<div style="font-size:12px;letter-spacing:.16em;color:#5b6bb5;font-weight:700">GROWTH REPORT</div><h2 style="margin:6px 0">${esc(settings.academy || '')}</h2>
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


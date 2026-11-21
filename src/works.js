// 학습 결과물 사진 (라이팅·고친 글·교재·시험지)
// 선생님이 찍어 올리면 → AI가 사진을 보고 학부모용 코멘트 초안을 써요 → 선생님이 확인·수정 → 성장 리포트에 사진과 함께 들어가요.
// 사진은 리포트 비밀번호(학부모 휴대폰 뒷자리)를 통과한 학부모와 선생님만 볼 수 있어요.

import { all, first, run } from './db.js';
import { bad, randomToken, kstNow, addDays, dateShort } from './util.js';

export const WORK_TYPES = [
  { id: 'writing', label: '라이팅' },
  { id: 'corrected', label: '고친 글·오답노트' },
  { id: 'book', label: '교재·워크북' },
  { id: 'test', label: '시험지' },
  { id: 'etc', label: '기타 활동' },
];
const TYPE = new Map(WORK_TYPES.map((t) => [t.id, t]));
export const typeLabel = (id) => (TYPE.get(id) || TYPE.get('etc')).label;

const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_DAYS = 200; // 성장 리포트 몇 번 분량 보관 후 자동 정리

// 사진을 읽을 수 있는 무료 AI (앞에서부터 시도)
const VISION_MODELS = [
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/google/gemma-3-12b-it',
];

export async function worksList(env, studentId, from, to) {
  return all(env, `SELECT id, token, student_id, date, type, memo, comment, ai, include, status, error, model, created_at, updated_at
    FROM works WHERE student_id = ? AND date >= ? AND date <= ? ORDER BY date DESC, id DESC`, Number(studentId), from, to);
}

export async function workRow(env, id) {
  const w = await first(env, 'SELECT * FROM works WHERE id = ?', Number(id));
  if (!w) throw bad('사진을 찾을 수 없어요');
  return w;
}

export async function workUpload(env, me, url, request) {
  if (!env.MEDIA) throw bad('사진 저장소(R2)가 아직 연결되지 않았어요');
  const studentId = Number(url.searchParams.get('student_id'));
  const date = String(url.searchParams.get('date') || kstNow().date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('날짜가 올바르지 않아요');
  const type = TYPE.has(url.searchParams.get('type')) ? url.searchParams.get('type') : 'writing';
  const memo = String(url.searchParams.get('memo') || '').trim().slice(0, 300);
  const mime = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw bad('사진(JPG·PNG) 파일만 올릴 수 있어요');
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) throw bad('사진이 비어 있어요');
  if (buf.byteLength > MAX_BYTES) throw bad('사진이 너무 커요 (8MB까지)');
  const token = randomToken(24);
  const r2key = `works/${date}/${studentId}/${token}.${mime.split('/')[1].replace('jpeg', 'jpg')}`;
  await env.MEDIA.put(r2key, buf, { httpMetadata: { contentType: mime } });
  const stamp = kstNow().stamp;
  const res = await run(env, `INSERT INTO works (token, student_id, date, r2key, mime, size, type, memo, comment, ai, include, status, error, model, teacher_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', 1, 'new', '', '', ?, ?, ?)`, token, studentId, date, r2key, mime, buf.byteLength, type, memo, me.id || 0, stamp, stamp);
  return first(env, 'SELECT id, token, student_id, date, type, memo, comment, ai, include, status, error, model FROM works WHERE id = ?', res.meta.last_row_id);
}

export async function workUpdate(env, w, body) {
  const sets = [];
  const args = [];
  if (body.comment != null) { sets.push('comment = ?'); args.push(String(body.comment).trim().slice(0, 1200)); }
  if (body.memo != null) { sets.push('memo = ?'); args.push(String(body.memo).trim().slice(0, 300)); }
  if (body.include != null) { sets.push('include = ?'); args.push(body.include ? 1 : 0); }
  if (body.type != null && TYPE.has(body.type)) { sets.push('type = ?'); args.push(body.type); }
  if (!sets.length) return w;
  sets.push('updated_at = ?'); args.push(kstNow().stamp);
  await run(env, `UPDATE works SET ${sets.join(', ')} WHERE id = ?`, ...args, w.id);
  return first(env, 'SELECT id, token, student_id, date, type, memo, comment, ai, include, status, error, model FROM works WHERE id = ?', w.id);
}

export async function workDelete(env, w) {
  try { await env.MEDIA.delete(w.r2key); } catch { /* 이미 없음 */ }
  await run(env, 'DELETE FROM works WHERE id = ?', w.id);
  return { ok: true };
}

/** 사진 내려주기 (권한 확인은 부르는 쪽에서) */
export async function workImage(env, w) {
  const obj = env.MEDIA ? await env.MEDIA.get(w.r2key) : null;
  if (!obj) return new Response('사진이 없어요', { status: 404 });
  return new Response(obj.body, { headers: { 'content-type': w.mime || 'image/jpeg', 'cache-control': 'private, max-age=86400', 'x-robots-tag': 'noindex' } });
}

// ───────── AI 코멘트 ─────────
const VISION_SYSTEM = `당신은 15년 넘게 초등·중등 아이들을 가르쳐 온 영어학원 원장입니다. 학생의 학습 결과물 사진을 보고, 학부모님께 보낼 성장 리포트에 들어갈 짧은 코멘트를 씁니다.

[반드시 지킬 것]
1. 사진에 실제로 보이는 내용만 씁니다. 보이지 않는 점수·날짜·일화는 지어내지 않습니다.
2. 손글씨가 흐리거나 잘 안 읽히면 억지로 읽지 말고 readable을 false로 하고, 확실히 보이는 것만 씁니다.
3. 빨간 펜 표시는 선생님의 첨삭입니다. 아이가 고쳐야 할 부분을 선생님이 바로잡아 준 것이고, 학생은 오답노트로 정리합니다.
4. 아이를 깎아내리지 않습니다. 잘한 점을 먼저, 보완할 점은 "다음에는 ~을 연습할 예정이에요"처럼 학원의 지도 계획과 함께 씁니다.
5. 영어 문장을 인용할 때는 사진에 실제로 쓰인 짧은 표현(10단어 이하)만 그대로 씁니다.
6. 말투: 따뜻하고 차분한 존댓말("~했어요", "~하고 있어요"). 느낌표·과장("완벽해요", "최고예요") 금지.

[출력] 아래 JSON 하나만 출력합니다. 다른 글은 쓰지 않습니다.
{"readable": true 또는 false, "what": "무슨 결과물인지 한 줄 (예: 'My Weekend' 주제 영어 일기 5문장)", "good": ["잘한 점 (구체적으로, 최대 2개)"], "fix": ["보완할 점과 학원의 지도 계획 (최대 2개)"], "comment": "학부모님께 드리는 코멘트 2~3문장"}`;

function parseJsonLoose(text) {
  if (text && typeof text === 'object') return text;
  let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI 답에서 결과를 찾지 못했어요');
  return JSON.parse(t.slice(a, b + 1));
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const clean = (v, max) => String(v == null ? '' : v).replace(/!+/g, '.').replace(/\s+/g, ' ').trim().slice(0, max);

export function shapeAi(o) {
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => clean(typeof x === 'object' ? Object.values(x).join(' ') : x, 300)).filter(Boolean).slice(0, 2);
  return { readable: o.readable !== false, what: clean(o.what, 200), good: list(o.good), fix: list(o.fix), comment: clean(o.comment, 700) };
}

export async function workAnalyze(env, w, ctxInfo = {}) {
  if (!env.AI) throw bad('Workers AI가 연결되지 않았어요');
  const obj = await env.MEDIA.get(w.r2key);
  if (!obj) throw bad('사진 파일을 찾을 수 없어요');
  const dataUrl = `data:${w.mime || 'image/jpeg'};base64,${toBase64(await obj.arrayBuffer())}`;
  const info = [
    `결과물 종류: ${typeLabel(w.type)}`,
    ctxInfo.student ? `학생: ${ctxInfo.student}${ctxInfo.class_name ? ` (${ctxInfo.class_name})` : ''}` : '',
    `날짜: ${dateShort(w.date)}`,
    w.memo ? `선생님 메모 (가장 중요한 근거, 뜻을 그대로 살리기): ${w.memo}` : '',
  ].filter(Boolean).join('\n');
  await run(env, "UPDATE works SET status = 'analyzing', error = '', updated_at = ? WHERE id = ?", kstNow().stamp, w.id);
  let lastErr = null;
  for (const model of VISION_MODELS) {
    try {
      const r = await env.AI.run(model, {
        messages: [
          { role: 'system', content: VISION_SYSTEM },
          { role: 'user', content: [{ type: 'text', text: `${info}\n\n사진을 보고 JSON으로 답해 주세요.` }, { type: 'image_url', image_url: { url: dataUrl } }] },
        ],
        max_tokens: 900, temperature: 0.3,
      });
      const text = typeof r === 'string' ? r : r?.response ?? r?.choices?.[0]?.message?.content ?? r?.result?.response;
      const ai = shapeAi(parseJsonLoose(text));
      if (!ai.comment && !ai.good.length) throw new Error('AI 답이 비어 있어요');
      const comment = ai.comment || [...ai.good, ...ai.fix].join(' ');
      // 선생님이 이미 코멘트를 고쳐 둔 경우엔 덮어쓰지 않기
      const keep = w.comment && w.status === 'done' && w.comment !== (safeParse(w.ai).comment || '');
      await run(env, "UPDATE works SET ai = ?, comment = ?, status = ?, error = '', model = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(ai), keep ? w.comment : comment, 'done', model, kstNow().stamp, w.id);
      return first(env, 'SELECT id, token, student_id, date, type, memo, comment, ai, include, status, error, model FROM works WHERE id = ?', w.id);
    } catch (e) { lastErr = e; }
  }
  const msg = `AI가 사진을 읽지 못했어요: ${(lastErr && lastErr.message) || '알 수 없는 오류'}`.slice(0, 300);
  await run(env, "UPDATE works SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", msg, kstNow().stamp, w.id);
  throw bad(msg);
}

export function safeParse(s) { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } }

/** 10분마다: 올렸는데 AI가 아직 안 쓴 사진 몇 장씩 처리 (화면을 닫아도 진행) */
export async function processWorks(env, limit = 3) {
  if (!env.AI || !env.MEDIA) return;
  const rows = await all(env, `SELECT w.*, s.name AS student, c.name AS class_name FROM works w LEFT JOIN students s ON s.id = w.student_id LEFT JOIN classes c ON c.id = s.class_id
    WHERE w.status = 'new' OR (w.status = 'analyzing' AND w.updated_at < ?) ORDER BY w.id LIMIT ?`, stampMinus(15), limit);
  for (const w of rows) { try { await workAnalyze(env, w, w); } catch { /* 실패 표시는 workAnalyze가 남김 */ } }
}
function stampMinus(min) { return kstNow(Date.now() - min * 60e3).stamp; }

export async function cleanupWorks(env) {
  if (!env.MEDIA) return;
  const old = await all(env, 'SELECT id, r2key FROM works WHERE date <= ? LIMIT 200', addDays(kstNow().date, -KEEP_DAYS));
  for (const w of old) { try { await env.MEDIA.delete(w.r2key); } catch { /* */ } await run(env, 'DELETE FROM works WHERE id = ?', w.id); }
}

/** 리포트용: 기간 안의, 리포트에 넣기로 한 결과물 */
export async function worksForReport(env, studentId, from, to) {
  return all(env, "SELECT id, token, date, type, comment FROM works WHERE student_id = ? AND date >= ? AND date <= ? AND include = 1 ORDER BY date, id", Number(studentId), from, to);
}

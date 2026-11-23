// 수업 관리 앱 — 시작점
// Cloudflare Workers + D1(데이터) + R2(사진·영상) + 10분마다 예약 실행

import { ensureSchema, getSettings, all, run } from './db.js';
import { json, HttpError, kstNow, hmToMin, isLastDayOfMonth } from './util.js';
import { handleApi } from './api.js';
import { serveMedia, galleryPage, cleanupMedia } from './media.js';
import { generate, sendMessages } from './messages.js';
import { buildDay } from './context.js';
import { reportPage, reportWorkImage, processQueue, growthSettings, periodFor } from './growth.js';
import { processWorks, cleanupWorks } from './works.js';

function versionOf(env) {
  const id = env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id;
  return id ? String(id).slice(0, 8) : 'dev';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const version = versionOf(env);
    try {
      await ensureSchema(env);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, ctx, url, version);
      let m;
      if ((m = url.pathname.match(/^\/m\/([A-Za-z0-9]+)$/))) return await serveMedia(env, ctx, m[1], request);
      if ((m = url.pathname.match(/^\/g\/([A-Za-z0-9]+)$/))) return await galleryPage(env, m[1]);
      if ((m = url.pathname.match(/^\/r\/([A-Za-z0-9]+)$/))) return await reportPage(env, request, m[1]);
      if ((m = url.pathname.match(/^\/r\/([A-Za-z0-9]+)\/w\/([A-Za-z0-9]+)$/))) return await reportWorkImage(env, request, m[1], m[2]);
      if (url.pathname === '/' || url.pathname === '/index.html') {
        // 화면 파일에 버전 번호를 넣어서, 새로 배포하면 휴대폰에 옛날 화면이 남지 않게
              const res = await env.ASSETS.fetch(new URL('/', url));
        const html = (await res.text()).replaceAll('__APP_VERSION__', version);
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: '서버에서 문제가 생겼어요: ' + (e && e.message) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      await runSchedule(env);
    })().catch((e) => console.error('schedule', e)));
  },
};

async function claimJob(env, job, date) {
  const r = await run(env, 'INSERT INTO jobs (job, date, done_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', job, date, kstNow().stamp);
  return !!(r.meta && r.meta.changes);
}

/** 선생님이 저장을 안 눌렀어도, 출석한 반은 미리 채워진 진도를 오늘 기록으로 남겨서 다음 수업이 다음 차시로 넘어가게 */
async function materializeLogs(env, date) {
  const ctx = await buildDay(env, date, {});
  const stmts = [];
  const stamp = kstNow().stamp;
  const add = (target, classId, p) => {
    if (!p || p.saved || !p.lesson_id) return;
    stmts.push(env.DB.prepare(`INSERT INTO logs (date, target, class_id, curriculum_id, lesson_id, seq, today, next, homework, repeat, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(date, target) DO NOTHING`)
      .bind(date, target, classId, p.curriculum_id, p.lesson_id, p.seq, p.today, p.next, p.homework, stamp));
  };
  const came = (s) => s.day.att === 'present' || s.day.att === 'late';
  for (const c of ctx.classes) {
    if (c.type === 'individual') { for (const s of c.students) if (came(s)) add(s.target, c.id, s.progress); }
    else if (c.students.some(came)) for (const t of c.tracks || []) if (t.on && !t.free) add(t.target, c.id, t.progress);
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

async function makePreviews(env, settings, now) {
  const sch = settings.schedule;
  await materializeLogs(env, now.date);
  await generate(env, 'daily', now.date, { settings });
  if (sch.missing_on) await generate(env, 'missing', now.date, { settings });
  if (sch.hw5_on) await generate(env, 'hw5', now.date, { settings });
  if (sch.weekly_on && now.dow === Number(sch.weekly_day)) await generate(env, 'weekly', now.date, { settings });
  if (sch.monthly_on && isLastDayOfMonth(now.date)) await generate(env, 'monthly', now.date.slice(0, 7), { settings });
}

async function idsToSend(env, kind, ref) {
  const rows = await all(env, "SELECT id FROM messages WHERE kind = ? AND ref = ? AND checked = 1 AND status IN ('pending','failed')", kind, ref);
  return rows.map((r) => r.id);
}

export async function runSchedule(env, nowMs = Date.now()) {
  const settings = await getSettings(env);
  if (!settings.director_pw) return;
  const now = kstNow(nowMs);
  const sch = settings.schedule;

  // 보내는 중에 멈춘 메시지 풀어 주기
  await run(env, "UPDATE messages SET status = 'failed', error = '보내는 중 멈췄어요. 다시 보내 주세요', lock_at = NULL WHERE status = 'sending' AND lock_at < ?", nowMs - 10 * 60 * 1000);

  const mins = hmToMin(now.hm);
  if (mins >= hmToMin(sch.preview) && await claimJob(env, 'preview', now.date)) {
    await makePreviews(env, settings, now);
  }

  const diff = mins - hmToMin(sch.send);
  if (sch.auto_send && diff >= 0 && diff < 120 && await claimJob(env, 'send', now.date)) {
    if (await claimJob(env, 'preview', now.date)) await makePreviews(env, settings, now);
    await generate(env, 'daily', now.date, { settings }); // 보내기 직전 최신 기록으로
    await sendMessages(env, await idsToSend(env, 'daily', now.date), { auto: true });
    if (sch.missing_on && sch.missing_auto) {
      await generate(env, 'missing', now.date, { settings });
      await sendMessages(env, await idsToSend(env, 'missing', now.date), { auto: true });
    }
    if (sch.hw5_on && sch.hw5_auto) {
      await generate(env, 'hw5', now.date, { settings });
      await sendMessages(env, await idsToSend(env, 'hw5', now.date), { auto: true });
    }
    if (sch.weekly_on && sch.weekly_auto && now.dow === Number(sch.weekly_day)) {
      await generate(env, 'weekly', now.date, { settings });
      await sendMessages(env, await idsToSend(env, 'weekly', now.date), { auto: true });
    }
    if (sch.monthly_on && sch.monthly_auto && isLastDayOfMonth(now.date)) {
      const ref = now.date.slice(0, 7);
      await generate(env, 'monthly', ref, { settings });
      await sendMessages(env, await idsToSend(env, 'monthly', ref), { auto: true });
    }
  }

  // 주간 성장 리포트: 정한 요일·시간에 만들기 시작 → 10분마다 몇 명씩 AI로 쓰기 → 발송 시간에 "승인된" 것만 보내기
  const g = growthSettings(settings);
  // 2주마다면 기준 토요일과 짝이 맞는 날에만 (periodFor가 오늘을 기준일로 돌려줄 때)
  const isGrowthDay = g.on && now.dow === Number(g.day) && periodFor(settings, now.date).ref === now.date;
  if (isGrowthDay && mins >= hmToMin(g.gen) && await claimJob(env, 'growth-gen', now.date)) {
    await generate(env, 'growth', now.date, { settings });
  }
  // 올린 학습 결과물 사진: AI 코멘트가 아직 없는 것 몇 장씩
  try { await processWorks(env, 3); } catch (e) { console.error('works', e); }
  const refs = await processQueue(env, { settings });
  for (const ref of refs) await generate(env, 'growth', ref, { settings });
  const gdiff = mins - hmToMin(g.send);
  if (isGrowthDay && g.auto && gdiff >= 0 && gdiff < 120 && await claimJob(env, 'growth-send', now.date)) {
    await sendMessages(env, await idsToSend(env, 'growth', now.date), { auto: true });
  }

  if (await claimJob(env, 'cleanup', now.date)) {
    await cleanupMedia(env);
    await cleanupWorks(env);
    await run(env, 'DELETE FROM sessions WHERE expires < ?', nowMs);
  }
}

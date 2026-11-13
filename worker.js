// 수업 관리 앱 — 시작점
// Cloudflare Workers + D1(데이터) + R2(사진·영상) + 10분마다 예약 실행

import { ensureSchema, getSettings, all, run } from './db.js';
import { json, HttpError, kstNow, hmToMin, isLastDayOfMonth } from './util.js';
import { handleApi } from './api.js';
import { serveMedia, galleryPage, cleanupMedia } from './media.js';
import { generate, sendMessages } from './messages.js';
import { buildDay } from './context.js';

const INDEX_HTML = `<!doctype html>
<html lang="ko" data-version="__APP_VERSION__">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f5f4f0">
  <meta name="robots" content="noindex">
  <title>수업 관리</title>
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
  <link rel="stylesheet" href="/app.css?v=__APP_VERSION__">
</head>
<body>
  <div id="app"><div class="boot">불러오는 중…</div></div>
  <div id="toast" role="status" aria-live="polite"></div>
  <div id="ver" title="앱 버전">v __APP_VERSION__</div>
  <script type="module" src="/js/main.js?v=__APP_VERSION__"></script>
</body>
</html>
`;

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
      if (url.pathname === '/' || url.pathname === '/index.html') {
        // 첫 화면은 파일을 따로 읽지 않고 여기서 바로 보내기 (버전 번호를 넣어서, 새로 배포하면 휴대폰에 옛날 화면이 남지 않게)
        return new Response(INDEX_HTML.replaceAll('__APP_VERSION__', version), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
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
    else if (c.students.some(came)) add(c.target, c.id, c.progress);
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

async function makePreviews(env, settings, now) {
  const sch = settings.schedule;
  await materializeLogs(env, now.date);
  await generate(env, 'daily', now.date, { settings });
  if (sch.missing_on) await generate(env, 'missing', now.date, { settings });
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

  if (await claimJob(env, 'cleanup', now.date)) {
    await cleanupMedia(env);
    await run(env, 'DELETE FROM sessions WHERE expires < ?', nowMs);
  }
}

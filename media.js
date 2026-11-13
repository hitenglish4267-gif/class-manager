// 사진·영상: 나눠 올리기(R2), 끊김 없는 재생(Range 206), 학생별 모아 보기 페이지

import { all, first, run, getSettings } from './db.js';
import { json, bad, randomToken, kstNow, addDays, dateKo } from './util.js';

const PART = 10 * 1024 * 1024; // 10MB씩 나눠 올리기
const SINGLE_MAX = 20 * 1024 * 1024;

function mimeFor(name, mime) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.mov') || mime === 'video/quicktime') return 'video/mp4'; // 아이폰 .mov도 mp4로 내려주기
  if (n.endsWith('.mp4') || n.endsWith('.m4v')) return 'video/mp4';
  if (n.endsWith('.heic')) return 'image/heic';
  return mime || 'application/octet-stream';
}

export function r2Ready(env) { return !!env.MEDIA; }

export async function mediaStart(env, body) {
  if (!r2Ready(env)) throw bad('사진·영상 저장소(R2)가 아직 연결되지 않았어요. 관리 → 사진·영상에서 안내를 확인해 주세요.');
  const student = await first(env, 'SELECT id FROM students WHERE id = ?', Number(body.student_id));
  if (!student) throw bad('학생을 찾을 수 없어요');
  const kind = String(body.mime || '').startsWith('video') || /\.(mov|mp4|m4v)$/i.test(body.name || '') ? 'video' : 'photo';
  const mime = mimeFor(body.name, body.mime);
  const token = randomToken(20);
  const ext = (String(body.name || '').match(/\.[a-z0-9]{2,4}$/i) || [''])[0].toLowerCase();
  const date = body.date || kstNow().date;
  const r2key = `${date}/${student.id}/${token}${ext}`;
  const size = Number(body.size) || 0;
  let uploadId = null;
  let mode = 'single';
  if (size > SINGLE_MAX) {
    const mp = await env.MEDIA.createMultipartUpload(r2key, { httpMetadata: { contentType: mime } });
    uploadId = mp.uploadId; mode = 'multi';
  }
  const res = await run(env, `INSERT INTO media (token, student_id, date, r2key, kind, mime, size, name, status, upload_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`, token, student.id, date, r2key, kind, mime, size, String(body.name || '').slice(0, 120), uploadId, kstNow().stamp);
  return { id: res.meta.last_row_id, mode, partSize: PART };
}

export async function mediaPart(env, id, partNo, request) {
  const m = await first(env, 'SELECT * FROM media WHERE id = ?', id);
  if (!m || m.status !== 'uploading') throw bad('업로드 정보를 찾을 수 없어요');
  if (!m.upload_id) {
    await env.MEDIA.put(m.r2key, request.body, { httpMetadata: { contentType: m.mime } });
    return { ok: true };
  }
  const mp = env.MEDIA.resumeMultipartUpload(m.r2key, m.upload_id);
  const part = await mp.uploadPart(partNo, request.body);
  return { partNumber: part.partNumber, etag: part.etag };
}

export async function mediaComplete(env, id, body) {
  const m = await first(env, 'SELECT * FROM media WHERE id = ?', id);
  if (!m) throw bad('업로드 정보를 찾을 수 없어요');
  if (m.upload_id) {
    const mp = env.MEDIA.resumeMultipartUpload(m.r2key, m.upload_id);
    await mp.complete((body.parts || []).map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
  }
  const head = await env.MEDIA.head(m.r2key);
  const size = head ? head.size : m.size;
  let patch = null;
  if (m.kind === 'video') {
    try { patch = await findHev1(env, m.r2key, size); } catch { patch = null; }
  }
  await run(env, "UPDATE media SET status = 'ready', size = ?, patch = ?, upload_id = NULL WHERE id = ?", size, patch && patch.length ? JSON.stringify(patch) : null, id);
  return { ok: true, date: m.date, student_id: m.student_id };
}

export async function mediaDelete(env, id) {
  const m = await first(env, 'SELECT * FROM media WHERE id = ?', id);
  if (!m) return { ok: true };
  try {
    if (m.upload_id) await env.MEDIA.resumeMultipartUpload(m.r2key, m.upload_id).abort();
    else await env.MEDIA.delete(m.r2key);
  } catch { /* 이미 없음 */ }
  await run(env, 'DELETE FROM media WHERE id = ?', id);
  return { ok: true, date: m.date, student_id: m.student_id };
}

export async function mediaList(env, studentId, date) {
  return all(env, "SELECT id, token, kind, mime, size, name, date FROM media WHERE student_id = ? AND date = ? AND status = 'ready' ORDER BY id", studentId, date);
}

/**
 * 안드로이드 HEVC(hev1) 영상을 아이폰이 읽는 hvc1로 바꿀 위치 찾기.
 * 파일 맨 위 상자(box)들을 훑어 moov 상자 안에서 'hev1' 글자 위치를 기록해 두고,
 * 내려줄 때 그 4바이트만 'hvc1'로 바꿔서 보냅니다. (원본 파일은 그대로)
 */
async function findHev1(env, key, size) {
  let off = 0;
  for (let i = 0; i < 64 && off + 8 <= size; i++) {
    const obj = await env.MEDIA.get(key, { range: { offset: off, length: 16 } });
    if (!obj) break;
    const b = new Uint8Array(await obj.arrayBuffer());
    const dv = new DataView(b.buffer);
    let boxSize = dv.getUint32(0);
    const type = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (boxSize === 1) boxSize = Number(dv.getBigUint64(8));
    else if (boxSize === 0) boxSize = size - off;
    if (boxSize < 8) break;
    if (type === 'moov') {
      if (boxSize > 40 * 1024 * 1024) return [];
      const mo = await env.MEDIA.get(key, { range: { offset: off, length: boxSize } });
      const buf = new Uint8Array(await mo.arrayBuffer());
      const hits = [];
      for (let j = 4; j + 4 <= buf.length; j++) {
        if (buf[j] === 0x68 && buf[j + 1] === 0x65 && buf[j + 2] === 0x76 && buf[j + 3] === 0x31) hits.push(off + j);
      }
      return hits;
    }
    off += boxSize;
  }
  return [];
}

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); if (!n) return null; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

/** /m/:token — 사진·영상 내려주기 (정확한 Content-Length, Range 206 지원) */
export async function serveMedia(env, ctx, token, request) {
  const m = await first(env, "SELECT * FROM media WHERE token = ? AND status = 'ready'", token);
  if (!m || !env.MEDIA) return new Response('없는 파일이에요', { status: 404 });
  const size = m.size;
  const url = new URL(request.url);
  const headers = new Headers({
    'Content-Type': m.mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=86400',
  });
  if (url.searchParams.get('dl')) {
    const fname = (m.name || `media-${m.id}`).replace(/\.mov$/i, '.mp4');
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  }
  const range = parseRange(request.headers.get('Range'), size);
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = end - start + 1;
  headers.set('Content-Length', String(length));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });

  const patches = (m.patch ? JSON.parse(m.patch) : []).filter((p) => p + 4 > start && p <= end);
  if (!patches.length) {
    const obj = await env.MEDIA.get(m.r2key, { range: { offset: start, length } });
    if (!obj) return new Response('없는 파일이에요', { status: 404 });
    return new Response(obj.body, { status, headers });
  }
  // hev1 → hvc1 바꿔서 이어 붙여 보내기
  const pieces = [];
  let cur = start;
  const hvc1 = new Uint8Array([0x68, 0x76, 0x63, 0x31]);
  for (const p of patches.sort((a, b) => a - b)) {
    if (p > cur) pieces.push({ offset: cur, length: p - cur });
    const s = Math.max(p, cur), e = Math.min(p + 3, end);
    if (e >= s) pieces.push({ bytes: hvc1.slice(s - p, e - p + 1) });
    cur = e + 1;
  }
  if (cur <= end) pieces.push({ offset: cur, length: end - cur + 1 });
  const { readable, writable } = new FixedLengthStream(length);
  const pump = (async () => {
    const writer = writable.getWriter();
    try {
      for (const pc of pieces) {
        if (pc.bytes) { await writer.write(pc.bytes); continue; }
        const obj = await env.MEDIA.get(m.r2key, { range: { offset: pc.offset, length: pc.length } });
        const reader = obj.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; await writer.write(value); }
      }
      await writer.close();
    } catch (e) { try { await writer.abort(e); } catch { /* 끊김 */ } }
  })();
  ctx.waitUntil(pump);
  return new Response(readable, { status, headers });
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** /g/:code — 로그인 없이 열리는 학생별 사진·영상 모아 보기 */
export async function galleryPage(env, code) {
  const st = await first(env, 'SELECT id, name FROM students WHERE code = ?', code);
  const settings = await getSettings(env);
  const academy = esc(settings.academy || '');
  if (!st) return new Response(pageShell(academy, '<p class="empty">페이지를 찾을 수 없어요.</p>'), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const since = addDays(kstNow().date, -30);
  const rows = await all(env, "SELECT * FROM media WHERE student_id = ? AND status = 'ready' AND date > ? ORDER BY date DESC, id", st.id, since);
  let body = `<header><p class="aca">${academy}</p><h1>${esc(st.name)} 수업 사진·영상</h1><p class="sub">최근 30일 동안 올라온 사진과 영상이에요. 30일이 지나면 자동으로 지워져요.</p></header>`;
  if (!rows.length) body += '<p class="empty">아직 올라온 사진·영상이 없어요</p>';
  const byDate = new Map();
  for (const r of rows) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
  for (const [d, list] of byDate) {
    body += `<section><h2>${dateKo(d)}</h2><div class="grid">`;
    for (const r of list) {
      const src = `/m/${r.token}`;
      const media = r.kind === 'video'
        ? `<video src="${src}" controls playsinline preload="metadata" data-fallback="${src}"></video>`
        : `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" loading="lazy" alt=""></a>`;
      body += `<figure>${media}<a class="save" href="${src}?dl=1">저장</a></figure>`;
    }
    body += '</div></section>';
  }
  return new Response(pageShell(academy, body), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

function pageShell(academy, body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${academy ? academy + ' · ' : ''}수업 사진</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<style>
*{box-sizing:border-box}body{margin:0;font-family:Pretendard,-apple-system,system-ui,sans-serif;background:#f5f4f0;color:#1f2421;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:28px 18px 60px}header{margin-bottom:22px}.aca{margin:0 0 6px;font-size:13px;color:#2f6b57;font-weight:600;letter-spacing:.02em}
h1{margin:0;font-size:22px;letter-spacing:-.02em}.sub{margin:8px 0 0;color:#6b706c;font-size:14px;line-height:1.5}
h2{font-size:15px;margin:26px 0 10px;color:#3a3f3b}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
figure{margin:0;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e6e3dc;display:flex;flex-direction:column}
figure img,figure video{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:#ebe8e1}
.save{display:block;text-align:center;padding:10px;font-size:14px;color:#2f6b57;text-decoration:none;font-weight:600;border-top:1px solid #efece6}
.empty{background:#fff;border:1px dashed #d8d4cb;border-radius:12px;padding:40px 16px;text-align:center;color:#6b706c}
</style></head><body><main>${body}</main>
<script>
// 재생이 멈추면 파일을 통째로 받아 재생하는 방식으로 자동 전환
document.querySelectorAll('video[data-fallback]').forEach(function(v){
  var switched=false, timer=null;
  function fallback(){ if(switched) return; switched=true; var t=v.currentTime||0;
    fetch(v.dataset.fallback).then(function(r){return r.blob()}).then(function(b){ v.src=URL.createObjectURL(b); v.currentTime=t; v.play().catch(function(){}); }); }
  v.addEventListener('error', fallback);
  v.addEventListener('stalled', function(){ clearTimeout(timer); timer=setTimeout(function(){ if(!v.paused && v.readyState<3) fallback(); }, 4000); });
  v.addEventListener('waiting', function(){ clearTimeout(timer); timer=setTimeout(function(){ if(v.readyState<3) fallback(); }, 6000); });
  v.addEventListener('playing', function(){ clearTimeout(timer); });
});
</script></body></html>`;
}

/** 30일 지난 사진·영상 지우기 + 멈춘 업로드 정리 */
export async function cleanupMedia(env) {
  if (!env.MEDIA) return;
  const cutoff = addDays(kstNow().date, -30);
  const old = await all(env, "SELECT id, r2key, upload_id FROM media WHERE date <= ? OR (status = 'uploading' AND created_at < ?) LIMIT 200", cutoff, addDays(kstNow().date, -1));
  for (const m of old) {
    try {
      if (m.upload_id) await env.MEDIA.resumeMultipartUpload(m.r2key, m.upload_id).abort();
      else await env.MEDIA.delete(m.r2key);
    } catch { /* 무시 */ }
    await run(env, 'DELETE FROM media WHERE id = ?', m.id);
  }
}

export { json };

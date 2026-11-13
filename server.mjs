// 내 컴퓨터에서 미리 돌려 보는 용도 (배포에는 쓰이지 않아요)
// node dev/server.mjs  →  http://localhost:8787
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'dev', 'data');
fs.mkdirSync(path.join(DATA, 'r2'), { recursive: true });

globalThis.FixedLengthStream ??= class extends TransformStream { constructor() { super(); } };

// ── D1 흉내 ──
const db = new DatabaseSync(path.join(DATA, 'dev.sqlite'));
const norm = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, norm(a)); }
  async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
  async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
  async run() {
    const s = db.prepare(this.sql);
    if (/returning/i.test(this.sql)) { const rows = s.all(...this.args); return { results: rows, meta: { changes: rows.length } }; }
    const r = s.run(...this.args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}
const D1 = {
  prepare: (sql) => new Stmt(sql),
  async batch(list) { db.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  async exec(sql) { db.exec(sql); },
};

// ── R2 흉내 ──
const fp = (k) => path.join(DATA, 'r2', encodeURIComponent(k));
const mkObj = (buf, k) => ({ key: k, size: buf.length, body: new Blob([buf]).stream(), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
async function toBuf(body) { if (body instanceof ReadableStream || body?.getReader) return Buffer.from(await new Response(body).arrayBuffer()); return Buffer.from(body); }
const uploads = new Map();
const R2 = {
  async put(k, body) { fs.writeFileSync(fp(k), await toBuf(body)); },
  async get(k, o = {}) {
    if (!fs.existsSync(fp(k))) return null;
    let b = fs.readFileSync(fp(k));
    if (o.range) b = b.subarray(o.range.offset, o.range.offset + (o.range.length ?? b.length));
    return mkObj(b, k);
  },
  async head(k) { return fs.existsSync(fp(k)) ? { size: fs.statSync(fp(k)).size } : null; },
  async delete(k) { try { fs.unlinkSync(fp(k)); } catch {} },
  async createMultipartUpload(k) { const id = 'u' + Date.now(); uploads.set(id, new Map()); return { uploadId: id, key: k }; },
  resumeMultipartUpload(k, id) {
    return {
      async uploadPart(n, body) { uploads.get(id).set(n, await toBuf(body)); return { partNumber: n, etag: 'e' + n }; },
      async complete(parts) { const m = uploads.get(id); fs.writeFileSync(fp(k), Buffer.concat(parts.sort((a, b) => a.partNumber - b.partNumber).map((p) => m.get(p.partNumber)))); },
      async abort() { uploads.delete(id); },
    };
  },
};

// ── 화면 파일 ──
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const ASSETS = {
  async fetch(req) {
    const u = new URL(req.url);
    let f = path.join(ROOT, 'public', decodeURIComponent(u.pathname));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(ROOT, 'public', 'index.html');
    return new Response(fs.readFileSync(f), { headers: { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' } });
  },
};

// ── 솔라피 흉내 (실제로 보내지 않음) ──
const realFetch = globalThis.fetch;
export const sentLog = [];
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.solapi.com')) {
    if (String(url).includes('/cash/')) return new Response(JSON.stringify({ balance: 12000, point: 0 }), { status: 200 });
    const body = JSON.parse(init.body);
    sentLog.push(...body.messages);
    fs.appendFileSync(path.join(DATA, 'sent.log'), JSON.stringify(body.messages) + '\n');
    const failed = body.messages.filter((m) => m.to === '01000000000').map((m) => ({ to: m.to, statusCode: '1062', statusMessage: '수신번호 오류(테스트)', customFields: m.customFields }));
    return new Response(JSON.stringify({ failedMessageList: failed, messageList: body.messages.filter((m) => m.to !== '01000000000').map((m, i) => ({ messageId: 'M' + i, statusCode: '2000', to: m.to })) }), { status: 200 });
  }
  return realFetch(url, init);
};

const worker = (await import(path.join(ROOT, 'src', 'worker.js'))).default;
const { runSchedule } = await import(path.join(ROOT, 'src', 'worker.js'));
const env = {
  DB: D1, MEDIA: R2, ASSETS, CF_VERSION_METADATA: { id: 'dev12345local' },
  SOLAPI_API_KEY: process.env.NO_SOLAPI ? '' : 'NCSTESTKEY0000', SOLAPI_API_SECRET: process.env.NO_SOLAPI ? '' : 'x'.repeat(32), SOLAPI_SENDER: '0551234567',
};

const PORT = Number(process.env.PORT || 8787);
http.createServer(async (req, res) => {
  try {
    const url = `http://localhost:${PORT}${req.url}`;
    if (req.url.startsWith('/__cron')) {
      const at = new URL(url).searchParams.get('at'); // 예: 2026-11-13T20:00 (한국 시간)
      const ms = at ? Date.parse(at + ':00+09:00') : Date.now();
      await runSchedule(env, ms);
      res.end('ok'); return;
    }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const waits = [];
    const r = await worker.fetch(request, env, { waitUntil: (p) => waits.push(p) });
    const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(r.status, headers);
    if (r.body) { const buf = Buffer.from(await r.arrayBuffer()); res.end(buf); } else res.end();
    await Promise.allSettled(waits);
  } catch (e) { console.error(e); res.writeHead(500); res.end(String(e)); }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));

// 엑셀·CSV·PDF·붙여넣기 읽기 (프로그램 설치 없이 브라우저에서 바로)

/** 엑셀에서 복사한 내용(탭으로 구분, 칸 안 줄바꿈은 "…"로 감싸짐) 읽기 */
export function parseDelimited(text, delim) {
  text = String(text || '').replace(/\r\n?/g, '\n');
  if (!delim) {
    const firstLine = text.split('\n')[0];
    delim = firstLine.includes('\t') ? '\t' : (firstLine.split(',').length > 1 ? ',' : '\t');
  }
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** .xlsx 파일 풀기 (zip) */
async function unzip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('엑셀 파일을 읽지 못했어요');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    const lnlen = dv.getUint16(local + 26, true), lelen = dv.getUint16(local + 28, true);
    const start = local + 30 + lnlen + lelen;
    const data = u8.subarray(start, start + csize);
    files[name] = { method, data };
    p += 46 + nlen + elen + clen;
  }
  return {
    async text(name) {
      const f = files[name]; if (!f) return null;
      const raw = f.method === 8 ? await inflate(f.data) : f.data;
      return dec.decode(raw);
    },
    names: Object.keys(files),
  };
}

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return 0;
  let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function readXlsx(file) {
  const zip = await unzip(await file.arrayBuffer());
  const parser = new DOMParser();
  const ssText = await zip.text('xl/sharedStrings.xml');
  const shared = [];
  if (ssText) {
    const doc = parser.parseFromString(ssText, 'application/xml');
    for (const si of doc.getElementsByTagName('si')) {
      let s = '';
      for (const t of si.getElementsByTagName('t')) s += t.textContent;
      shared.push(s);
    }
  }
  // 첫 번째 시트 찾기
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = await zip.text('xl/workbook.xml');
  const rels = await zip.text('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const wdoc = parser.parseFromString(wb, 'application/xml');
    const first = wdoc.getElementsByTagName('sheet')[0];
    const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    const rdoc = parser.parseFromString(rels, 'application/xml');
    for (const r of rdoc.getElementsByTagName('Relationship')) {
      if (r.getAttribute('Id') === rid) { const t = r.getAttribute('Target').replace(/^\/?xl\//, '').replace(/^\//, ''); sheetPath = 'xl/' + t; }
    }
  }
  const sx = await zip.text(sheetPath) || await zip.text(zip.names.find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)));
  if (!sx) throw new Error('엑셀 시트를 찾지 못했어요');
  const doc = parser.parseFromString(sx, 'application/xml');
  const rows = [];
  for (const r of doc.getElementsByTagName('row')) {
    const row = [];
    for (const c of r.getElementsByTagName('c')) {
      const idx = colIndex(c.getAttribute('r'));
      const t = c.getAttribute('t');
      let v = '';
      if (t === 's') v = shared[Number(c.getElementsByTagName('v')[0]?.textContent)] ?? '';
      else if (t === 'inlineStr') { for (const tt of c.getElementsByTagName('t')) v += tt.textContent; }
      else v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      while (row.length < idx) row.push('');
      row[idx] = String(v).replace(/\r\n?/g, '\n').trim();
    }
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x));
}

export async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) { try { text = new TextDecoder('euc-kr').decode(buf); } catch { /* */ } }
  return text.replace(/^﻿/, '');
}

/** PDF 글자 읽기 (pdf.js를 필요할 때만 불러옴) */
export async function readPdfLines(file) {
  const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byY = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3;
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push({ x: it.transform[4], s: it.str });
    }
    [...byY.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => {
      lines.push(items.sort((a, b) => a.x - b.x).map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim());
    });
  }
  return lines;
}

/** 파일 종류에 맞게 읽어서 표(행 배열)로 */
export async function readTableFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return { rows: await readXlsx(file) };
  if (name.endsWith('.xls')) throw new Error('예전 엑셀(.xls)은 읽을 수 없어요. 엑셀에서 "다른 이름으로 저장 → .xlsx"로 저장하거나, 내용을 복사해 붙여 넣어 주세요.');
  if (name.endsWith('.pdf')) return { pdfLines: await readPdfLines(file) };
  return { rows: parseDelimited(await readTextFile(file)) };
}

// ───────── 진도표 칸 맞추기 ─────────
const CUR_HEAD = [
  ['homework', /(숙제|과제|homework|\bhw\b)/i],
  ['content', /(수업\s*내용|학습\s*내용|내용|활동|content|activity)/i],
  ['title', /(차시\s*(이름|명)|단원|unit|제목|레슨|lesson|chapter|챕터|title|주제|교재\s*범위|범위|진도)/i],
  ['seq', /^(순서|차시|회차|주차|번호|no\.?|#|session|day|week|일차|순번)$/i],
];
function numIn(s) { const m = String(s || '').match(/\d+(\.\d+)?/); return m ? Number(m[0]) : null; }

export function mapCurriculum(rows) {
  rows = rows.filter((r) => r.some((x) => String(x).trim()));
  if (!rows.length) return { lessons: [], columns: {} };
  const head = rows[0];
  const cols = {};
  head.forEach((cell, i) => {
    const c = String(cell).replace(/\s+/g, ' ').trim();
    for (const [key, re] of CUR_HEAD) {
      if (cols[key] === undefined && re.test(c)) { cols[key] = i; break; }
    }
  });
  let body = rows;
  if (Object.keys(cols).length >= 2 || (Object.keys(cols).length === 1 && rows.length > 1 && !head.some((x) => numIn(x) !== null && String(x).length < 6))) {
    body = rows.slice(1);
  } else {
    // 제목줄이 없으면: 첫 칸이 숫자면 [순서, 차시 이름, 내용, 숙제], 아니면 [차시 이름, 내용, 숙제]
    for (const k of Object.keys(cols)) delete cols[k];
    const firstNumeric = rows.filter((r) => numIn(r[0]) !== null && String(r[0]).length <= 8).length >= rows.length * 0.6;
    if (firstNumeric) Object.assign(cols, { seq: 0, title: 1, content: 2, homework: 3 });
    else Object.assign(cols, { title: 0, content: 1, homework: 2 });
  }
  let lessons = body.map((r) => {
    const get = (k) => (cols[k] !== undefined ? String(r[cols[k]] ?? '').trim() : '');
    const label = get('seq');
    return { label, seq: numIn(label), title: get('title').replace(/\s*\n\s*/g, ' '), content: get('content'), homework: get('homework') };
  }).filter((l) => l.title || l.content || l.homework);
  // 번호가 없거나 겹치면 순서대로 다시 매기기 (원래 표시는 이름에 남김)
  const seqs = lessons.map((l) => l.seq);
  const dup = seqs.some((s, i) => s === null || seqs.indexOf(s) !== i);
  lessons = lessons.map((l, i) => {
    let title = l.title;
    if (!title) title = l.label || '';
    if (dup && l.label && !title.includes(l.label)) title = `${l.label} ${title}`.trim();
    return { seq: dup ? i + 1 : l.seq, title: title || `${dup ? i + 1 : l.seq}차시`, content: l.content, homework: l.homework };
  });
  return { lessons, columns: cols };
}

// ───────── 학생 명단 칸 맞추기 ─────────
const PHONE_RE = /0\s*1\s*[016789][\s.\-]*\d{3,4}[\s.\-]*\d{4}/;
const STU_HEAD = [
  ['phone', /(번호|연락처|전화|휴대폰|핸드폰|학부모|보호자|phone|mobile|tel|hp)/i],
  ['class', /(반|클래스|class|그룹|group)/i],
  ['name', /(이름|학생|성명|원생|name)/i],
];
function looksPhone(s) { return PHONE_RE.test(String(s)) || /^1\d{9}$/.test(String(s).replace(/\D/g, '')); }
function looksName(s) { return /^[가-힣]{2,4}$/.test(String(s).trim()); }

export function mapStudents(rows) {
  rows = rows.filter((r) => r.some((x) => String(x).trim()));
  if (!rows.length) return [];
  const head = rows[0];
  const cols = {};
  head.forEach((cell, i) => {
    const c = String(cell).trim();
    if (looksPhone(c)) return;
    for (const [key, re] of STU_HEAD) if (cols[key] === undefined && re.test(c)) { cols[key] = i; break; }
  });
  let body = rows;
  if (cols.name !== undefined || Object.keys(cols).length >= 2) body = rows.slice(1);
  else {
    const width = Math.max(...rows.map((r) => r.length));
    for (let i = 0; i < width; i++) {
      const vals = rows.map((r) => r[i] || '').filter(Boolean);
      if (!vals.length) continue;
      if (cols.phone === undefined && vals.filter(looksPhone).length >= vals.length * 0.6) cols.phone = i;
      else if (cols.name === undefined && vals.filter(looksName).length >= vals.length * 0.6) cols.name = i;
      else if (cols.class === undefined) cols.class = i;
    }
  }
  return body.map((r) => ({
    name: String(r[cols.name] ?? '').trim(),
    class: cols.class !== undefined ? String(r[cols.class] ?? '').trim() : '',
    phone: cols.phone !== undefined ? String(r[cols.phone] ?? '').trim() : '',
  })).filter((s) => s.name && !/^(이름|학생|성명)/.test(s.name));
}

/** PDF 명단: 번호가 줄 사이로 끊겨 읽혀도 숫자를 이어 붙여서 찾기 */
export function studentsFromPdf(lines, classNames = []) {
  const text = lines.join('\n');
  const out = [];
  let i = 0, segStart = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  while (i < text.length) {
    if (text[i] === '0' && text[i + 1] === '1') {
      let digits = '', j = i;
      while (j < text.length && digits.length < 11) {
        const c = text[j];
        if (isDigit(c)) digits += c;
        else if (!/[\s.\-)(]/.test(c)) break;
        j++;
      }
      if (/^01[016789]\d{7,8}$/.test(digits) && (digits.length === 11 || digits.length === 10)) {
        const seg = text.slice(segStart, i);
        out.push({ seg, phone: digits });
        segStart = j; i = j; continue;
      }
    }
    i++;
  }
  const norm = (s) => s.replace(/\s+/g, '');
  const known = classNames.map((c) => ({ c, n: norm(c) })).sort((a, b) => b.n.length - a.n.length);
  const HEAD = /^(이름|학생|성명|원생|반|클래스|번호|연락처|학부모|전화|휴대폰|순번|비고)$/;
  return out.map(({ seg, phone }) => {
    let cls = '';
    let rest = seg.replace(/\n/g, ' ');
    for (const k of known) { if (norm(rest).includes(k.n)) { cls = k.c; rest = rest.replace(new RegExp(k.c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), ' '); break; } }
    const words = rest.split(/\s+/).filter((w) => w && !HEAD.test(w) && !/^\d+$/.test(w));
    const nameIdx = words.findIndex((w) => /^[가-힣]{2,4}$/.test(w));
    const name = nameIdx >= 0 ? words[nameIdx] : '';
    if (!cls) cls = words.filter((w, k) => k !== nameIdx && w.length <= 12).slice(-1)[0] || '';
    return { name, class: cls, phone };
  }).filter((s) => s.name);
}

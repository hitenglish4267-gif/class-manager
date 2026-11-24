// 데이터베이스 표 만들기 + 설정 기본값

import { DEFAULT_SMS, DEFAULT_CUSHIONS, DEFAULT_EVAL, DEFAULT_GROWTH } from './defaults.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS teachers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, pw TEXT, salt TEXT, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, role TEXT, teacher_id INTEGER, expires INTEGER);
CREATE TABLE IF NOT EXISTS courses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, sort INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS curricula (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, course_id INTEGER, cycle INTEGER DEFAULT 1, deleted INTEGER DEFAULT 0, updated_at TEXT);
CREATE TABLE IF NOT EXISTS lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, curriculum_id INTEGER, seq REAL, title TEXT, content TEXT, homework TEXT);
CREATE INDEX IF NOT EXISTS lessons_cur ON lessons(curriculum_id, seq);
CREATE TABLE IF NOT EXISTS classes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT DEFAULT 'group', days TEXT DEFAULT '1,2,3,4,5', time TEXT DEFAULT '', room TEXT DEFAULT '', teacher_id INTEGER, course_id INTEGER, curriculum_id INTEGER, start_seq REAL, deleted INTEGER DEFAULT 0, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS students (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, class_id INTEGER, phone TEXT, course_id INTEGER, curriculum_id INTEGER, start_seq REAL, code TEXT, msg_style TEXT DEFAULT '', deleted INTEGER DEFAULT 0, created_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS students_code ON students(code);
CREATE TABLE IF NOT EXISTS days (date TEXT, student_id INTEGER, class_id INTEGER, att TEXT DEFAULT '', reason TEXT DEFAULT '', att_at TEXT, hw TEXT DEFAULT '', comment TEXT DEFAULT '', updated_at TEXT, PRIMARY KEY(date, student_id));
CREATE TABLE IF NOT EXISTS tests (date TEXT, student_id INTEGER, kind TEXT, correct REAL, total REAL, result TEXT DEFAULT '', updated_at TEXT, PRIMARY KEY(date, student_id, kind));
CREATE TABLE IF NOT EXISTS logs (date TEXT, target TEXT, class_id INTEGER, curriculum_id INTEGER, lesson_id INTEGER, seq REAL, today TEXT, next TEXT, homework TEXT, repeat INTEGER DEFAULT 0, updated_at TEXT, PRIMARY KEY(date, target));
CREATE INDEX IF NOT EXISTS logs_target ON logs(target, date);
CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, student_id INTEGER, date TEXT, r2key TEXT, kind TEXT, mime TEXT, size INTEGER, name TEXT, status TEXT DEFAULT 'uploading', upload_id TEXT, patch TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS media_student ON media(student_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS media_token ON media(token);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ref TEXT, student_id INTEGER, text TEXT, vars TEXT, edited INTEGER DEFAULT 0, checked INTEGER DEFAULT 0, user_set INTEGER DEFAULT 0, locked TEXT DEFAULT '', note TEXT DEFAULT '', status TEXT DEFAULT 'pending', channel TEXT DEFAULT '', sent_at TEXT, error TEXT DEFAULT '', attempts INTEGER DEFAULT 0, lock_at INTEGER, created_at TEXT, updated_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS messages_uk ON messages(kind, ref, student_id);
CREATE TABLE IF NOT EXISTS att_alerts (date TEXT, student_id INTEGER, kind TEXT, status TEXT, sent_at TEXT, error TEXT, PRIMARY KEY(date, student_id));
CREATE TABLE IF NOT EXISTS solapi_tokens (account TEXT PRIMARY KEY, enc_refresh TEXT, refresh_fp TEXT, seed_fp TEXT, enc_access TEXT, access_exp INTEGER DEFAULT 0, scope TEXT DEFAULT '', issued_at TEXT, last_refresh_at TEXT, status TEXT DEFAULT 'ready', error TEXT DEFAULT '', lock_id TEXT, lock_until INTEGER DEFAULT 0, updated_at TEXT);
CREATE TABLE IF NOT EXISTS msg_overrides (message_id INTEGER PRIMARY KEY, comment TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS jobs (job TEXT, date TEXT, done_at TEXT, PRIMARY KEY(job, date));
CREATE TABLE IF NOT EXISTS evals (date TEXT, student_id INTEGER, item TEXT, marks TEXT, teacher_id INTEGER, updated_at TEXT, PRIMARY KEY(date, student_id, item));
CREATE INDEX IF NOT EXISTS evals_student ON evals(student_id, date);
CREATE TABLE IF NOT EXISTS eval_days (date TEXT, class_id INTEGER, items TEXT, teacher_id INTEGER, updated_at TEXT, PRIMARY KEY(date, class_id));
CREATE TABLE IF NOT EXISTS daynotes (date TEXT, student_id INTEGER, teacher_id INTEGER, done TEXT DEFAULT '', next_plan TEXT DEFAULT '', retest TEXT DEFAULT '', mistakes TEXT DEFAULT '', weak TEXT DEFAULT '', extra_done TEXT DEFAULT '', extra_need TEXT DEFAULT '', special TEXT DEFAULT '', memo TEXT DEFAULT '', updated_at TEXT, PRIMARY KEY(date, student_id));
CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ref TEXT, student_id INTEGER, token TEXT, facts TEXT, ai TEXT, edited TEXT, source TEXT DEFAULT '', model TEXT DEFAULT '', status TEXT DEFAULT 'queued', error TEXT DEFAULT '', tries INTEGER DEFAULT 0, fails INTEGER DEFAULT 0, fail_at INTEGER DEFAULT 0, viewed_at TEXT, created_at TEXT, updated_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS reports_uk ON reports(kind, ref, student_id);
CREATE UNIQUE INDEX IF NOT EXISTS reports_token ON reports(token);
CREATE TABLE IF NOT EXISTS track_days (date TEXT, class_id INTEGER, keys TEXT, updated_at TEXT, PRIMARY KEY(date, class_id));
CREATE TABLE IF NOT EXISTS works (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, student_id INTEGER, date TEXT, r2key TEXT, mime TEXT, size INTEGER, type TEXT DEFAULT 'writing', memo TEXT DEFAULT '', comment TEXT DEFAULT '', ai TEXT DEFAULT '', include INTEGER DEFAULT 1, status TEXT DEFAULT 'new', error TEXT DEFAULT '', model TEXT DEFAULT '', teacher_id INTEGER, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS works_student ON works(student_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS works_token ON works(token);
`;

// 반 하나에 진도표 여러 개 (예: 월·수·목 실버스텔라, 화·금 영어홀릭)
const MIGRATIONS = [
  "ALTER TABLE classes ADD COLUMN cur_days TEXT DEFAULT ''",
  "ALTER TABLE classes ADD COLUMN tracks TEXT DEFAULT ''",
  "ALTER TABLE students ADD COLUMN solo INTEGER DEFAULT 0",
  "ALTER TABLE students ADD COLUMN tracks TEXT DEFAULT ''",
  "ALTER TABLE students ADD COLUMN cur_days TEXT DEFAULT ''",
];

// 한 번만: "출결 즉시 알림" 칸에 들어간 지각 템플릿을 "지각 즉시 알림" 칸으로 옮기기 (2026-11-24, 원장님 요청)
const LATE_ID = 'KA01TP261112023701044FnlZwKp9zYN';
const LATE_TEXT = `[파머스 어학원]
지각 등원 안내

#{학생명} 학생 보호자님, 안녕하세요.

오늘 예정된 수업 시작 시각 이후 등원이 확인되어 출결 기록을 안내드립니다.

■ 수업일: #{수업일}
■ 수업 시작: #{수업시작시각}
■ 등원 확인: #{등원시각}
■ 지각 시간: #{지각분}분
■ 출결 상태: 지각

다음 수업에는 시작 시각에 맞춰 등원할 수 있도록 확인 부탁드립니다. 출결 기록이 실제와 다른 경우 학원으로 연락해 주세요.

본 메시지는 재원생의 출결 현황을 등록된 보호자께 안내하는 알림입니다.

문의: #{학원연락처}`;
async function fixAttLateOnce(env) {
  const done = await env.DB.prepare("SELECT v FROM settings WHERE k = 'fix_att_late_v1'").first();
  if (done) return;
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'kakao'").first();
  if (row) {
    const k = JSON.parse(row.v || '{}');
    const list = Array.isArray(k.templates) ? k.templates : [];
    const next = list.filter((t) => !(t.kind === 'att' && t.templateId === LATE_ID));
    if (!next.some((t) => t.kind === 'late' && t.templateId)) {
      const i = next.findIndex((t) => t.kind === 'late');
      const tpl = { kind: 'late', style: 'basic', templateId: LATE_ID, text: LATE_TEXT };
      if (i >= 0) next[i] = { ...next[i], ...tpl }; else next.push(tpl);
    }
    k.templates = next;
    await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('kakao', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(k)).run();
  }
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('fix_att_late_v1', '1') ON CONFLICT(k) DO NOTHING").run();
}

// 한 번만: 자동 발송을 모두 끄기 (2026-11-24 원장님 요청: 원장이 승인해서 보낼 때만 알림톡)
async function approvalOnlyOnce(env) {
  const done = await env.DB.prepare("SELECT v FROM settings WHERE k = 'approval_only_v1'").first();
  if (done) return;
  for (const [key, flags] of [['schedule', ['auto_send', 'missing_auto', 'hw5_auto', 'weekly_auto', 'monthly_auto']], ['growth', ['auto']]]) {
    const row = await env.DB.prepare('SELECT v FROM settings WHERE k = ?').bind(key).first();
    if (!row) continue;
    const v = JSON.parse(row.v || '{}');
    for (const f of flags) v[f] = false;
    await env.DB.prepare('UPDATE settings SET v = ? WHERE k = ?').bind(JSON.stringify(v), key).run();
  }
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('approval_only_v1', '1') ON CONFLICT(k) DO NOTHING").run();
}

let ready = false;
export async function ensureSchema(env) {
  if (ready) return;
  const stmts = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
  // 나중에 추가된 칸 (이미 있으면 그냥 넘어가요)
  for (const sql of MIGRATIONS) { try { await env.DB.prepare(sql).run(); } catch { /* 이미 있음 */ } }
  try { await fixAttLateOnce(env); } catch (e) { console.error('fixAttLate', e); }
  try { await approvalOnlyOnce(env); } catch (e) { console.error('approvalOnly', e); }
  ready = true;
}

export const DEFAULT_SETTINGS = {
  academy: '',
  base_url: '',
  director_phone: '',
  academy_phone: '',
  hw_buttons: ['워크북', '단어 암기', '단어 시험 준비', '리딩 녹음', '원서 읽기 + 녹음', '문법 문제', '오답 정리', '숙제 없음'],
  reasons: ['결석', '보강', '결강', '미작성'],
  schedule: {
    preview: '20:00', send: '20:30', auto_send: false,
    weekly_on: true, weekly_day: 5, weekly_auto: false, weekly_exclude_today: true,
    monthly_on: true, monthly_auto: false,
    missing_on: true, missing_auto: false, missing_target: 'missing',
    hw5_on: true, hw5_auto: false,
  },
  att_alerts: { late: false, absent: false, arrive: false },
  tests: { kinds: ['Voca', 'Weekly', 'Monthly'], pass: 80 },
  solapi_auth: { mode: 'apikey', test_ok_at: null },
  sms_templates: DEFAULT_SMS,
  cushions: DEFAULT_CUSHIONS,
  kakao: { pfId: '', style: 'basic', templates: [], only: true },
  eval: DEFAULT_EVAL,
  growth: DEFAULT_GROWTH,
  // 발송 방식: 원장 승인 후에만 보내기 + 원장님께 사본
  send_policy: { director_only: true, copy: 'sample' },
};

export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT k, v FROM settings').all();
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const r of results) {
    try {
      const v = JSON.parse(r.v);
      if (v && typeof v === 'object' && !Array.isArray(v) && s[r.k] && typeof s[r.k] === 'object' && !Array.isArray(s[r.k])) {
        s[r.k] = { ...s[r.k], ...v };
      } else s[r.k] = v;
    } catch { s[r.k] = r.v; }
  }
  return s;
}

export async function setSetting(env, k, v) {
  await env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind(k, JSON.stringify(v)).run();
}

export async function all(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results;
}
export async function first(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).first();
}
export async function run(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).run();
}

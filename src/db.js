// 데이터베이스 표 만들기 + 설정 기본값

import { DEFAULT_SMS, DEFAULT_CUSHIONS } from './defaults.js';

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
CREATE TABLE IF NOT EXISTS logs (date TEXT, target TEXT, class_id INTEGER, curriculum_id INTEGER, lesson_id INTEGER, seq REAL, today TEXT, next TEXT, homework TEXT, repeat INTEGER DEFAULT 0, updated_at TEXT, PRIMARY KEY(date, target));
CREATE INDEX IF NOT EXISTS logs_target ON logs(target, date);
CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, student_id INTEGER, date TEXT, r2key TEXT, kind TEXT, mime TEXT, size INTEGER, name TEXT, status TEXT DEFAULT 'uploading', upload_id TEXT, patch TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS media_student ON media(student_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS media_token ON media(token);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ref TEXT, student_id INTEGER, text TEXT, vars TEXT, edited INTEGER DEFAULT 0, checked INTEGER DEFAULT 0, user_set INTEGER DEFAULT 0, locked TEXT DEFAULT '', note TEXT DEFAULT '', status TEXT DEFAULT 'pending', channel TEXT DEFAULT '', sent_at TEXT, error TEXT DEFAULT '', attempts INTEGER DEFAULT 0, lock_at INTEGER, created_at TEXT, updated_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS messages_uk ON messages(kind, ref, student_id);
CREATE TABLE IF NOT EXISTS att_alerts (date TEXT, student_id INTEGER, kind TEXT, status TEXT, sent_at TEXT, error TEXT, PRIMARY KEY(date, student_id));
CREATE TABLE IF NOT EXISTS jobs (job TEXT, date TEXT, done_at TEXT, PRIMARY KEY(job, date));
`;

let ready = false;
export async function ensureSchema(env) {
  if (ready) return;
  const stmts = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
  ready = true;
}

export const DEFAULT_SETTINGS = {
  academy: '',
  base_url: '',
  director_phone: '',
  hw_buttons: ['워크북', '단어 암기', '단어 시험 준비', '리딩 녹음', '원서 읽기 + 녹음', '문법 문제', '오답 정리', '숙제 없음'],
  reasons: ['결석', '보강', '결강', '미작성'],
  schedule: {
    preview: '20:00', send: '20:30', auto_send: true,
    weekly_on: true, weekly_day: 5, weekly_auto: false, weekly_exclude_today: true,
    monthly_on: true, monthly_auto: false,
    missing_on: true, missing_auto: false, missing_target: 'missing',
  },
  att_alerts: { late: false, absent: false, arrive: false },
  sms_templates: DEFAULT_SMS,
  cushions: DEFAULT_CUSHIONS,
  kakao: { pfId: '', style: 'basic', templates: [] },
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

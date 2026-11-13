// 학부모 메시지: 미리보기 만들기 · 다시 맞추기 · 보내기

import { all, first, getSettings } from './db.js';
import { addDays, dateKo, dateShort, dowOf, hashNum, kstNow } from './util.js';
import { buildDay } from './context.js';
import { oneLine } from './progress.js';
import { renderTemplate, kakaoVariables } from './render.js';
import { sendBatch } from './solapi.js';

export const ATT_LABEL = { present: '출석', late: '지각', absent: '결석' };
export const HW_LABEL = { done: '완료', partial: '미흡', missing: '미제출' };

function pick(list, seed) {
  const arr = (list || []).map((s) => String(s).trim()).filter(Boolean);
  if (!arr.length) return '';
  return arr[hashNum(seed) % arr.length];
}

function cushion(settings, key, seed, base) {
  const raw = pick(settings.cushions[key], `${seed}|${key}`);
  return renderTemplate(raw, base);
}

export function baseUrl(settings, env) {
  return String(settings.base_url || env.APP_URL || '').replace(/\/+$/, '');
}

/** 일간·미제출·출결 알림에 쓰는 값들 */
export function dailyVars(settings, env, cls, st, date) {
  const prog = (cls.type === 'individual' ? st.progress : cls.progress) || {};
  const day = st.day || {};
  const base = { 학원: settings.academy || '', 학생명: st.name };
  const seed = `${st.id}|${date}`;
  const url = baseUrl(settings, env);
  const att = ATT_LABEL[day.att] || '';
  const hw = HW_LABEL[day.hw] || '';
  const v = {
    ...base,
    반: cls.name || '',
    날짜: dateKo(date),
    출석: att,
    오늘할일: prog.today || '',
    학습내용: oneLine(prog.content || ''),
    숙제: prog.homework || '',
    다음수업: prog.repeat ? (String(prog.today || '').split(' · ')[0]) : (prog.next || ''),
    지난숙제내용: prog.prevHomework || '',
    지난숙제결과: hw,
    선생님한마디: day.comment || '',
    학습성취: day.comment || '',
    사진링크: st.media > 0 && url ? `${url}/g/${st.code}` : '',
    사진코드: st.code || '',
    인사: cushion(settings, 'greet', seed, base),
    마무리: cushion(settings, 'end', seed, base),
    출석멘트: day.att === 'late' ? cushion(settings, 'att_late', seed, base) : day.att === 'absent' ? cushion(settings, 'att_absent', seed, base) : '',
    숙제멘트: day.hw === 'done' ? cushion(settings, 'hw_done', seed, base)
      : day.hw === 'partial' ? cushion(settings, 'hw_partial', seed, base)
        : day.hw === 'missing' ? cushion(settings, 'hw_missing', seed, base) : '',
  };
  return v;
}

/** 주간·월간 기간 계산 */
export function periodOf(kind, ref, settings) {
  if (kind === 'monthly') {
    const ym = ref.slice(0, 7);
    const from = `${ym}-01`;
    let to = from;
    while (addDays(to, 1).slice(0, 7) === ym) to = addDays(to, 1);
    return { from, to, label: `${Number(ym.slice(5, 7))}월` };
  }
  // 주간: 그 주 월요일 ~ 기준일 전날 (설정에서 기준일 포함 가능)
  const dow = dowOf(ref);
  const monday = addDays(ref, -((dow + 6) % 7));
  const to = settings.schedule.weekly_exclude_today ? addDays(ref, -1) : ref;
  return { from: monday, to: to < monday ? monday : to, label: '' };
}

async function periodVars(env, settings, kind, ref) {
  const { from, to, label } = periodOf(kind, ref, settings);
  const students = await all(env, `SELECT s.*, c.name AS class_name, c.type AS class_type FROM students s
    LEFT JOIN classes c ON c.id = s.class_id WHERE s.deleted = 0`);
  const days = await all(env, 'SELECT * FROM days WHERE date >= ? AND date <= ? ORDER BY date', from, to);
  const classes = await all(env, 'SELECT id, type FROM classes');
  const classType = new Map(classes.map((c) => [c.id, c.type]));
  const logs = await all(env, 'SELECT * FROM logs WHERE date >= ? AND date <= ? ORDER BY date', from, to);
  const logMap = new Map(logs.map((l) => [`${l.date}|${l.target}`, l]));
  const byStudent = new Map();
  for (const d of days) { if (!byStudent.has(d.student_id)) byStudent.set(d.student_id, []); byStudent.get(d.student_id).push(d); }
  const url = baseUrl(settings, env);

  const out = [];
  for (const s of students) {
    const rows = byStudent.get(s.id) || [];
    const attended = rows.filter((r) => r.att === 'present' || r.att === 'late');
    if (!rows.some((r) => r.att || r.hw)) continue;
    const cnt = { present: 0, late: 0, absent: 0, done: 0, partial: 0, missing: 0 };
    for (const r of rows) { if (r.att in cnt) cnt[r.att]++; if (r.hw in cnt) cnt[r.hw]++; }
    const total = cnt.done + cnt.partial + cnt.missing;
    const rate = total ? Math.round((cnt.done / total) * 100) : null;
    const lessonLogs = [];
    for (const r of attended) {
      const t = classType.get(r.class_id) === 'individual' ? `s${s.id}` : `c${r.class_id}`;
      const l = logMap.get(`${r.date}|${t}`);
      if (l) lessonLogs.push(l);
    }
    const titles = lessonLogs.map((l) => String(l.today || '').split(' · ')[0]).filter(Boolean);
    const uniq = [...new Set(titles)];
    let progress = '';
    if (uniq.length === 1) progress = `${uniq[0]} (수업 ${lessonLogs.length}회)`;
    else if (uniq.length > 1) progress = `${uniq[0]} → ${uniq[uniq.length - 1]} (수업 ${lessonLogs.length}회)`;
    const last = lessonLogs[lessonLogs.length - 1];
    const nextPlan = last ? (last.repeat ? String(last.today || '').split(' · ')[0] : last.next || '') : '';
    const comments = rows.map((r) => String(r.comment || '').trim()).filter(Boolean);
    const base = { 학원: settings.academy || '', 학생명: s.name };
    const seed = `${s.id}|${kind}|${ref}`;
    const weekKey = rate == null ? null : rate >= 80 ? 'week_high' : rate >= 50 ? 'week_mid' : 'week_low';
    const hwText = total ? `${rate}% (미제출 ${cnt.missing}회${cnt.partial ? `, 미흡 ${cnt.partial}회` : ''})` : '';
    const lack = [];
    if (cnt.missing) lack.push(`숙제 미제출 ${cnt.missing}회`);
    if (cnt.partial) lack.push(`숙제 미흡 ${cnt.partial}회`);
    if (cnt.absent) lack.push(`결석 ${cnt.absent}회`);
    out.push({
      student: { id: s.id, name: s.name, phone: s.phone, msg_style: s.msg_style, class_id: s.class_id },
      vars: {
        ...base,
        반: s.class_name || '',
        기간: `${dateShort(from)} ~ ${dateShort(to)}`,
        대상월: label,
        출석요약: `출석 ${cnt.present} · 지각 ${cnt.late} · 결석 ${cnt.absent}`,
        숙제완료율: hwText,
        숙제현황: hwText,
        진도: progress,
        학습내용: uniq.join(', '),
        코멘트: comments.join(' / '),
        학습성취: comments.join(' / '),
        보완사항: lack.length ? `${lack.join(', ')} — 가정에서도 함께 챙겨 주시면 감사하겠습니다.` : '특별히 보완할 점 없이 잘 해내고 있어요.',
        다음학습계획: nextPlan,
        사진코드: s.code || '',
        사진링크: '',
        인사: cushion(settings, 'greet', seed, base),
        마무리: cushion(settings, 'end', seed, base),
        주간멘트: weekKey ? cushion(settings, weekKey, seed, base) : '',
        날짜: kind === 'monthly' ? label : dateKo(ref),
      },
    });
  }
  return out;
}

/** 미리보기 만들기(또는 최신 기록으로 다시 맞추기) */
export async function generate(env, kind, ref, opts = {}) {
  const settings = opts.settings || await getSettings(env);
  const tpl = settings.sms_templates[kind] || '';
  const items = []; // { student, vars, checked, locked, note }

  if (kind === 'daily' || kind === 'missing') {
    const ctx = await buildDay(env, ref, {});
    const target = settings.schedule.missing_target === 'missing+partial' ? ['missing', 'partial'] : ['missing'];
    for (const cls of ctx.classes) {
      for (const st of cls.students) {
        const day = st.day || {};
        if (kind === 'missing' && !target.includes(day.hw)) continue;
        const vars = dailyVars(settings, env, cls, st, ref);
        let locked = '';
        if (day.reason) locked = day.reason;
        else if (kind === 'daily' && !day.att) locked = '출석 미체크';
        items.push({ student: { ...st, class_id: cls.id }, vars, locked, checked: locked ? 0 : 1 });
      }
    }
  } else {
    const list = await periodVars(env, settings, kind, ref);
    // 주간·월간은 "직접 골라서 보내기"가 기본 → 처음엔 모두 체크 해제 (자동 발송을 켠 경우만 체크)
    const auto = kind === 'weekly' ? settings.schedule.weekly_auto : settings.schedule.monthly_auto;
    for (const it of list) items.push({ ...it, locked: '', checked: auto ? 1 : 0 });
  }

  const existing = await all(env, 'SELECT * FROM messages WHERE kind = ? AND ref = ?', kind, ref);
  const exMap = new Map(existing.map((m) => [m.student_id, m]));
  const now = kstNow().stamp;
  const stmts = [];
  const seen = new Set();
  for (const it of items) {
    seen.add(it.student.id);
    const text = renderTemplate(tpl, it.vars, 'sms');
    const ex = exMap.get(it.student.id);
    const varsJson = JSON.stringify(it.vars);
    if (!ex) {
      stmts.push(env.DB.prepare(`INSERT INTO messages (kind, ref, student_id, text, vars, checked, locked, note, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(kind, ref, student_id) DO NOTHING`)
        .bind(kind, ref, it.student.id, text, varsJson, it.checked, it.locked, it.locked, now, now));
    } else if (ex.status === 'sent' || ex.status === 'sending') {
      // 이미 보낸 메시지는 그대로 (다시 보내기를 위해 값만 최신으로)
      stmts.push(env.DB.prepare('UPDATE messages SET vars = ?, locked = ?, note = ? WHERE id = ?').bind(varsJson, it.locked, it.locked, ex.id));
    } else {
      const newText = ex.edited ? ex.text : text;
      const checked = ex.user_set ? ex.checked : it.checked;
      if (newText !== ex.text || checked !== ex.checked || varsJson !== ex.vars || it.locked !== ex.locked) {
        stmts.push(env.DB.prepare('UPDATE messages SET text = ?, vars = ?, checked = ?, locked = ?, note = ?, updated_at = ? WHERE id = ?')
          .bind(newText, varsJson, checked, it.locked, it.locked, now, ex.id));
      }
    }
  }
  // 더 이상 대상이 아닌 (안 보낸) 메시지는 정리 — 예: 미제출 → 완료로 고친 경우
  for (const ex of existing) {
    if (!seen.has(ex.student_id) && ex.status !== 'sent' && ex.status !== 'sending' && !ex.edited) {
      stmts.push(env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(ex.id));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { count: items.length };
}

/** 수업 기록이 바뀌면, 이미 만들어 둔 그날 미리보기만 조용히 다시 맞추기 */
export async function refreshIfExists(env, date) {
  for (const kind of ['daily', 'missing']) {
    const ex = await first(env, "SELECT id FROM messages WHERE kind = ? AND ref = ? LIMIT 1", kind, date);
    if (ex) await generate(env, kind, date);
  }
}

function chooseKakao(settings, kind, style) {
  const k = settings.kakao || {};
  if (!k.pfId) return null;
  const list = (k.templates || []).filter((t) => t.kind === kind && t.templateId && t.text);
  const ok = (t) => t.style === 'basic' || t.approved !== false;
  let tpl = list.find((t) => t.style === style && ok(t));
  if (!tpl) tpl = list.find((t) => t.style === 'basic');
  return tpl ? { pfId: k.pfId, ...tpl } : null;
}

export function buildSendItem(settings, kind, key, to, text, vars, studentStyle) {
  const style = studentStyle || settings.kakao.style || 'basic';
  const tpl = chooseKakao(settings, kind, style);
  return {
    key, to, text,
    kakao: tpl ? { pfId: tpl.pfId, templateId: tpl.templateId, variables: kakaoVariables(tpl.text, vars) } : null,
    style: tpl ? tpl.style : 'sms',
  };
}

/**
 * 메시지 보내기 (같은 메시지가 두 번 나가지 않게 먼저 '보내는 중'으로 잡아 둠)
 * opts.resend: 이미 보낸 메시지도 다시 보내기 (화면에서 확인을 받은 경우만)
 * opts.auto: 예약 발송 (실패한 건은 한 번만 더)
 */
export async function sendMessages(env, ids, opts = {}) {
  if (!ids.length) return { sent: 0, failed: 0 };
  const settings = await getSettings(env);
  const nowMs = Date.now();
  const statusCond = opts.resend ? "status IN ('pending','failed','sent')" : opts.auto ? "(status = 'pending' OR (status = 'failed' AND attempts < 2))" : "status IN ('pending','failed')";
  const claimed = await all(env, `UPDATE messages SET status = 'sending', lock_at = ? WHERE id IN (SELECT value FROM json_each(?))
    AND checked = 1 AND ${statusCond} RETURNING *`, nowMs, JSON.stringify(ids));
  if (!claimed.length) return { sent: 0, failed: 0 };
  const students = await all(env, 'SELECT id, phone, msg_style FROM students WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(claimed.map((m) => m.student_id)));
  const sMap = new Map(students.map((s) => [s.id, s]));
  const items = claimed.map((m) => {
    const s = sMap.get(m.student_id) || {};
    let vars = {};
    try { vars = JSON.parse(m.vars || '{}'); } catch { /* 빈 값 */ }
    // 직접 고친 메시지는 알림톡 틀에 맞출 수 없으니 문자로 보내요
    if (m.edited) return { key: m.id, to: s.phone, text: m.text, kakao: null, style: 'sms' };
    return buildSendItem(settings, m.kind, m.id, s.phone, m.text, vars, s.msg_style);
  });
  let results;
  try { results = await sendBatch(env, items); }
  catch (e) { results = new Map(items.map((it) => [it.key, { ok: false, channel: '', error: e.message }])); }
  const stamp = kstNow().stamp;
  const stmts = [];
  let sent = 0, failed = 0;
  for (const it of items) {
    const r = results.get(it.key) || { ok: false, error: '결과를 받지 못했어요' };
    const ch = r.channel === 'kakao' ? `알림톡(${it.style === 'cushion' ? '쿠션형' : '기본형'})` : r.channel === 'kakao→sms' ? '알림톡 실패→문자' : '문자';
    if (r.ok) {
      sent++;
      // 보낸 뒤에는 체크를 풀어 둬서, 다시 보낼 때는 일부러 체크하고 확인을 거치게
      stmts.push(env.DB.prepare("UPDATE messages SET status = 'sent', sent_at = ?, error = '', channel = ?, attempts = attempts + 1, lock_at = NULL, checked = 0, user_set = 1 WHERE id = ?").bind(stamp, ch, it.key));
    } else {
      failed++;
      stmts.push(env.DB.prepare("UPDATE messages SET status = 'failed', error = ?, channel = ?, attempts = attempts + 1, lock_at = NULL WHERE id = ?").bind(r.error || '실패', ch, it.key));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { sent, failed };
}

/** 출결 즉시 알림 (켜 둔 학원만, 오늘 날짜만, 학생당 하루 한 번) */
export async function attendanceAlert(env, studentId, date, att) {
  const settings = await getSettings(env);
  if (date !== kstNow().date) return;
  const map = { present: 'arrive', late: 'late', absent: 'absent' };
  if (!settings.att_alerts[map[att]]) return;
  const ins = await env.DB.prepare("INSERT INTO att_alerts (date, student_id, kind, status) VALUES (?, ?, ?, 'sending') ON CONFLICT DO NOTHING")
    .bind(date, studentId, att).run();
  if (!ins.meta || !ins.meta.changes) return; // 이미 오늘 보냄
  const ctx = await buildDay(env, date, {});
  let cls = null, st = null;
  for (const c of ctx.classes) for (const s of c.students) if (s.id === studentId) { cls = c; st = s; }
  if (!st) return;
  const vars = dailyVars(settings, env, cls, st, date);
  const text = renderTemplate(settings.sms_templates.att, vars, 'sms');
  const item = buildSendItem(settings, 'att', `a${studentId}`, st.phone, text, vars, st.msg_style);
  const res = (await sendBatch(env, [item])).get(item.key) || { ok: false, error: '실패' };
  await env.DB.prepare('UPDATE att_alerts SET status = ?, sent_at = ?, error = ? WHERE date = ? AND student_id = ?')
    .bind(res.ok ? 'sent' : 'failed', kstNow().stamp, res.error || '', date, studentId).run();
}

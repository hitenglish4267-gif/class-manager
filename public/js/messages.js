// 학부모 메시지: 미리보기 확인 → 체크 → 보내기

import { h, api, icon, toast, outbox, saveLabel, kstToday, addDays, dateLabel, hmOf, confirmBox, debounce } from './core.js';
import { S, setDate, courseTabs } from './state.js';

const KINDS = [['daily', '일간'], ['missing', '미제출'], ['weekly', '주간'], ['monthly', '월간']];

export async function renderMessages(main) {
  let kind = sessionStorage.getItem('cm_msg_kind') || 'daily';
  let ref = kind === 'monthly' ? (sessionStorage.getItem('cm_msg_month') || kstToday().slice(0, 7)) : S.date;
  let data = null;
  const checks = {}; // 이번 화면에서 바꾼 체크 상태 (자동 저장)
  let sending = false;

  const seg = h('div', { class: 'seg' }, KINDS.map(([k, label]) => h('button', { 'aria-pressed': String(k === kind), onclick: async () => {
    await outbox.flushAll(); kind = k; sessionStorage.setItem('cm_msg_kind', k);
    ref = k === 'monthly' ? (sessionStorage.getItem('cm_msg_month') || S.date.slice(0, 7)) : S.date;
    renderMessages(main);
  } }, label)));
  const refInput = kind === 'monthly'
    ? h('input', { type: 'month', class: 'input', style: { width: 'auto' }, value: ref, onchange: async (e) => { await outbox.flushAll(); sessionStorage.setItem('cm_msg_month', e.target.value); renderMessages(main); } })
    : h('div', { class: 'datebar' },
      h('button', { class: 'icon-btn', 'aria-label': '전날', onclick: async () => { await outbox.flushAll(); setDate(addDays(S.date, -1)); renderMessages(main); } }, icon('left')),
      h('input', { type: 'date', value: ref, onchange: async (e) => { await outbox.flushAll(); setDate(e.target.value); renderMessages(main); } }),
      h('button', { class: 'icon-btn', 'aria-label': '다음날', onclick: async () => { await outbox.flushAll(); setDate(addDays(S.date, 1)); renderMessages(main); } }, icon('right')));

  const tabs = h('div');
  const summary = h('div', { class: 'msg-sum' });
  const bar = h('div', { class: 'msgbar' });
  const list = h('div', null, h('div', { class: 'empty' }, '불러오는 중…'));
  const info = h('div');
  main.replaceChildren(h('div', { class: 'toolbar' }, seg, refInput), info, tabs, summary, bar, list);

  const sch = S.meta.schedule;
  if (kind === 'weekly') info.append(h('div', { class: 'note small', style: { marginBottom: '10px' } },
    `주간 리포트는 기준일이 속한 주 월요일부터 ${sch.weekly_exclude_today ? '기준일 전날' : '기준일'}까지를 모아요. 처음엔 모두 체크 해제 상태예요 — 보낼 학생만 체크해서 보내 주세요.`));
  if (kind === 'monthly') info.append(h('div', { class: 'note small', style: { marginBottom: '10px' } }, '월간 리포트는 그 달 1일부터 말일까지를 모아요. 보낼 학생만 체크해서 보내 주세요.'));
  if (kind === 'missing') {
    const target = sch.missing_target || 'missing';
    info.append(h('div', { class: 'row', style: { marginBottom: '10px' } },
      h('span', { class: 'small muted' }, '보낼 대상'),
      S.me.role === 'director'
        ? h('div', { class: 'seg' }, [['missing', '미제출만'], ['missing+partial', '미제출 + 미흡']].map(([v, l]) => h('button', { 'aria-pressed': String(target === v), onclick: async () => {
          await api('/api/admin/settings', { key: 'schedule', value: { ...sch, missing_target: v } }); S.meta.schedule.missing_target = v;
          await api('/api/messages/generate', { kind, ref }); renderMessages(main);
        } }, l)))
        : h('span', { class: 'chip' }, target === 'missing' ? '미제출만' : '미제출 + 미흡'),
      h('span', { class: 'small muted' }, sch.missing_auto ? `· ${sch.send}에 자동 발송` : '· 직접 확인하고 보내기')));
  }

  async function load() {
    try { data = await api(`/api/messages?kind=${kind}&ref=${ref}`); }
    catch (e) { list.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
    for (const m of data.list) {
      const d = outbox.get(`msg:${m.id}`); if (d) m.text = d.body.text;
      if (m.id in checks) m.checked = checks[m.id];
    }
    draw();
  }

  function visible() { return data.list.filter((m) => S.course === 'all' || String(m.course_id) === S.course); }

  function draw() {
    tabs.replaceChildren(courseTabs(h, draw));
    const v = visible();
    const sent = v.filter((m) => m.status === 'sent').length;
    const failed = v.filter((m) => m.status === 'failed').length;
    summary.replaceChildren(
      h('span', null, '총 ', h('b', null, v.length), '건'), h('span', null, '전송됨 ', h('b', { style: { color: 'var(--ok)' } }, sent)),
      h('span', null, '실패 ', h('b', { style: { color: failed ? 'var(--bad)' : 'inherit' } }, failed)),
      kind !== 'monthly' ? h('span', { class: 'small muted' }, dateLabel(ref)) : null);
    drawBar();
    if (!data.generated && !data.list.length) {
      const when = kind === 'daily' || kind === 'missing' ? `매일 ${sch.preview}에 자동으로 만들어져요.` : kind === 'weekly' ? `매주 ${'일월화수목금토'[sch.weekly_day]}요일 ${sch.preview}에 자동으로 만들어져요.` : `매달 말일 ${sch.preview}에 자동으로 만들어져요.`;
      list.replaceChildren(h('div', { class: 'card empty' }, h('b', null, '아직 미리보기가 없어요'), h('div', null, when),
        h('button', { class: 'btn primary mt', onclick: async (e) => { e.target.disabled = true; await outbox.flushAll(); await api('/api/messages/generate', { kind, ref }); load(); } }, '지금 미리보기 만들기')));
      return;
    }
    if (!v.length) { list.replaceChildren(h('div', { class: 'card empty' }, h('b', null, kind === 'missing' ? '미제출 학생이 없어요' : '보낼 메시지가 없어요'))); return; }
    list.replaceChildren(...v.map(card));
    requestAnimationFrame(() => { for (const t of list.querySelectorAll('textarea')) grow(t); });
  }
  function grow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 4, 560) + 'px'; }

  function checkedList() { return visible().filter((m) => m.checked); }
  function drawBar() {
    const v = visible();
    const canCheck = v.filter((m) => !m.checked && !m.locked && m.status !== 'sent');
    const canUncheck = v.filter((m) => m.checked);
    const n = checkedList().length;
    bar.replaceChildren(
      h('button', { class: 'btn small', disabled: !canCheck.length, onclick: () => bulk(canCheck, 1) }, '모두 체크'),
      h('button', { class: 'btn small', disabled: !canUncheck.length, onclick: () => bulk(canUncheck, 0) }, '모두 해제'),
      data && (data.generated || data.list.length) ? h('button', { class: 'btn small ghost', onclick: async (e) => {
        e.target.disabled = true; await outbox.flushAll(); await api('/api/messages/generate', { kind, ref }); toast('최신 수업 기록으로 다시 만들었어요'); load();
      } }, '미리보기 다시 만들기') : null,
      h('button', { class: 'btn primary', style: { marginLeft: 'auto' }, disabled: !n || sending, onclick: sendChecked }, sending ? '보내는 중…' : `체크된 ${n}건 지금 보내기`));
  }

  function setChecked(m, val) {
    m.checked = val ? 1 : 0; checks[m.id] = m.checked;
    outbox.put(`chk:${kind}:${ref}`, '/api/messages/check', { set: { ...checks } }, 0);
  }
  function bulk(items, val) {
    for (const m of items) setChecked(m, val);
    for (const m of items) { const cb = document.getElementById(`mc-${m.id}`); if (cb) cb.checked = !!val; }
    drawBar();
    toast(`${checkedList().length}건 선택됨`);
  }

  function card(m) {
    const cb = h('input', { type: 'checkbox', id: `mc-${m.id}`, checked: !!m.checked, onchange: () => {
      setChecked(m, cb.checked); drawBar(); toast(`${checkedList().length}건 선택됨`);
    } });
    const ta = h('textarea', { class: 'input', value: m.text, oninput: () => {
      m.text = ta.value; m.edited = 1; grow(ta);
      outbox.put(`msg:${m.id}`, '/api/messages/edit', { id: m.id, text: ta.value }, 1000);
    } });
    const saveSt = h('span', { 'data-save': `msg:${m.id}` });
    const st = m.status === 'sent' ? h('span', { class: 'chip ok' }, `✓ 전송됨 ${hmOf(m.sent_at)}${m.channel ? ' · ' + m.channel : ''}`)
      : m.status === 'failed' ? h('span', { class: 'chip bad' }, '✕ 실패')
        : m.status === 'sending' ? h('span', { class: 'chip warn' }, '보내는 중') : null;
    const kakaoBox = m.kakaoPreview ? h('pre', { class: 'note small hidden', style: { whiteSpace: 'pre-wrap', margin: '8px 0 0', fontFamily: 'inherit' } }, m.kakaoPreview) : null;
    const el = h('section', { class: 'card msg' + (m.status === 'sent' ? ' sent' : '') + (m.locked ? ' locked' : '') },
      h('div', { class: 'msg-head' },
        h('label', { class: 'check' }, cb, h('b', null, m.student_name)),
        h('span', { class: 'small muted' }, m.class_name || ''),
        h('span', { class: 'chip line' }, m.edited && m.via !== '문자' ? '문자 (직접 고침)' : m.via),
        m.locked ? h('span', { class: 'chip warn', title: '"모두 체크"에서 빠져요' }, m.locked) : null,
        st),
      ta,
      m.status === 'failed' && m.error ? h('div', { class: 'note bad small mt-s' }, '실패 이유: ', m.error, ' — 발송 시간에 한 번 더 자동으로 보내요.') : null,
      kakaoBox,
      h('div', { class: 'msg-foot' }, saveSt,
        m.edited ? h('button', { class: 'btn small ghost', onclick: async () => { await outbox.flush(`msg:${m.id}`); await api('/api/messages/restore', { id: m.id }); toast('자동 문구로 되돌렸어요'); load(); } }, '자동 문구로 되돌리기') : null,
        kakaoBox ? h('button', { class: 'btn small ghost', onclick: () => kakaoBox.classList.toggle('hidden') }, '알림톡으로 나가는 모습') : null,
        m.edited && m.via !== '문자' ? h('span', { class: 'tiny' }, '알림톡은 승인된 문구만 보낼 수 있어서, 직접 고친 메시지는 문자로 나가요.') : null));
    const paint = () => { const s = saveLabel(`msg:${m.id}`); saveSt.className = 'savest ' + s.cls; saveSt.textContent = outbox.get(`msg:${m.id}`) || s.cls ? (s.cls ? s.text : '') : ''; };
    paint();
    return el;
  }

  async function sendChecked() {
    if (sending) return;
    await outbox.flushAll();
    const items = checkedList();
    if (!items.length) return;
    const again = items.filter((m) => m.status === 'sent');
    if (again.length) {
      const ok = await confirmBox('이미 보낸 메시지를 다시 보냅니다', `${again.map((m) => m.student_name).join(', ')} 학부모님께는 이미 보냈어요.\n그래도 한 번 더 보낼까요?`, '다시 보내기', true);
      if (!ok) return;
    } else {
      const ok = await confirmBox('지금 보낼까요?', `체크된 ${items.length}건을 학부모님께 보냅니다.`, '보내기');
      if (!ok) return;
    }
    sending = true; drawBar();
    try {
      const r = await api('/api/messages/send', { ids: items.map((m) => m.id), resend: again.length > 0 });
      for (const m of items) delete checks[m.id];
      toast(r.failed ? `${r.sent}건 보냄 · ${r.failed}건 실패` : `${r.sent}건 보냈어요`, !!r.failed);
    } catch (e) { toast(e.message, true); }
    sending = false;
    load();
  }

  const off = outbox.on((key) => {
    const el = document.querySelector(`[data-save="${CSS.escape(key)}"]`);
    if (el) { const s = saveLabel(key); el.className = 'savest ' + s.cls; el.textContent = s.text; }
  });
  S.stopPoll = () => off();
  await load();
}

// 학부모 메시지: 미리보기 확인 → 체크 → 보내기

import { h, api, icon, toast, outbox, saveLabel, kstToday, addDays, dateLabel, hmOf, confirmBox, debounce, sheet, copyText, dowOf } from './core.js';
import { S, setDate, courseTabs } from './state.js';

const KINDS = [['daily', '일간'], ['missing', '미제출'], ['hw5', '숙제 5회'], ['growth', '성장 리포트'], ['growth1', '성장 1주'], ['growth_m', '성장 월간'], ['growth_q', '성장 분기'], ['consult', '상담용'], ['weekly', '주간'], ['monthly', '월간'], ['sent', '보낸 내역']];
const GK = ['growth', 'growth1', 'growth_m', 'growth_q'];
const MONTHLY = ['monthly', 'growth_m', 'growth_q'];
const manual = () => !S.meta.send_policy || S.meta.send_policy.director_only !== false;
const canSend = () => !manual() || S.me.role === 'director';
const saturdayOf = (d) => { const w = dowOf(d); return w === 0 ? addDays(d, -1) : addDays(d, 6 - w); };
/** 성장 리포트 기준 토요일 (2주마다면 기준일과 짝이 맞는 토요일로) — 서버 periodFor와 같은 계산 */
function growthRef(d) {
  const g = S.meta.growth || {};
  let sat = saturdayOf(d);
  if (Number(g.weeks) !== 1) {
    const anchor = saturdayOf(/^\d{4}-\d{2}-\d{2}$/.test(String(g.anchor)) ? g.anchor : sat);
    const diff = Math.round((Date.parse(sat) - Date.parse(anchor)) / (7 * 864e5));
    if (((diff % 2) + 2) % 2 === 1) sat = addDays(sat, 7);
  }
  return sat;
}

export async function renderMessages(main) {
  let kind = sessionStorage.getItem('cm_msg_kind') || 'daily';
  let ref = MONTHLY.includes(kind) ? (sessionStorage.getItem('cm_msg_month') || kstToday().slice(0, 7)) : kind === 'growth' ? growthRef(S.date) : kind === 'growth1' ? saturdayOf(S.date) : S.date;
  let data = null;
  const checks = {}; // 이번 화면에서 바꾼 체크 상태 (자동 저장)
  let sending = false;

  const seg = h('div', { class: 'seg' }, KINDS.map(([k, label]) => h('button', { 'aria-pressed': String(k === kind), onclick: async () => {
    await outbox.flushAll(); kind = k; sessionStorage.setItem('cm_msg_kind', k);
    ref = MONTHLY.includes(k) ? (sessionStorage.getItem('cm_msg_month') || S.date.slice(0, 7)) : S.date;
    renderMessages(main);
  } }, label)));
  if (kind === 'sent') return renderSent(main, seg);
  if (kind === 'consult') return renderConsult(main, seg);
  const refInput = MONTHLY.includes(kind)
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
  if (manual()) info.append(h('div', { class: 'note small', style: { marginBottom: '10px' } }, S.me.role === 'director'
    ? '자동 발송은 꺼져 있어요. 내용을 확인하고 체크한 뒤 "지금 보내기"를 눌러야 학부모님께 알림톡이 가요.'
    : '알림톡은 원장님이 확인하고 보내요. 선생님은 내용을 확인하고 체크만 해 두시면 돼요.'));

  const sch = S.meta.schedule;
  if (kind === 'weekly') info.append(h('div', { class: 'note small', style: { marginBottom: '10px' } },
    `주간 리포트는 기준일이 속한 주 월요일부터 ${sch.weekly_exclude_today ? '기준일 전날' : '기준일'}까지를 모아요. 처음엔 모두 체크 해제 상태예요 — 보낼 학생만 체크해서 보내 주세요.`));
  if (kind === 'monthly') info.append(h('div', { class: 'note small', style: { marginBottom: '10px' } }, '월간 리포트는 그 달 1일부터 말일까지를 모아요. 보낼 학생만 체크해서 보내 주세요.'));
  if (kind === 'growth_m' || kind === 'growth_q') info.append(h('div', { class: 'note small', style: { marginBottom: '10px' } },
    kind === 'growth_m' ? `${ref.slice(0, 4)}년 ${Number(ref.slice(5, 7))}월 한 달 기록을 모은 성장 리포트예요. 지난달과 비교해요. ` : `${ref.slice(0, 4)}년 ${Math.floor((Number(ref.slice(5, 7)) - 1) / 3) + 1}분기(3개월) 기록을 모은 성장 리포트예요. 지난 분기와 비교해요. `,
    '자동으로 만들지 않고, 필요할 때 "지금 리포트 만들기"로 만들어요. 내용을 확인하고 "승인"을 체크한 뒤 원장님이 "지금 보내기"를 누르면 보내져요.'));
  if (kind === 'growth' || kind === 'growth1') {
    const g = S.meta.growth || {};
    const two = kind === 'growth' && Number(g.weeks) !== 1;
    info.append(h('div', { class: 'note small', style: { marginBottom: '10px' } },
      `${addDays(ref, two ? -12 : -5).slice(5).replace('-', '/')}(월) ~ ${addDays(ref, -1).slice(5).replace('-', '/')}(금) ${two ? '2주' : '한 주'} 기록으로 만든 리포트예요. `,
      kind === 'growth1' ? '1주 리포트는 자동으로 만들지 않고, 필요할 때 "지금 리포트 만들기"(또는 "AI로 지금 쓰기")로 만들어요. 2주 리포트와 따로 보관돼요. 내용을 확인하고 "승인"을 체크하면 '
        : `${two ? '2주마다' : '매주'} ${'일월화수목금토'[g.day ?? 6]}요일 ${g.gen || '07:00'}부터 AI가 몇 명씩 써요. 내용을 확인하고 "승인"을 체크하면 `,
      !manual() && g.auto ? `${g.send || '12:00'}에 승인된 리포트만 자동으로 보내요.` : '원장님이 확인하고 "지금 보내기"를 누르면 보내져요.'));
  }
  if (kind === 'hw5') info.append(h('div', { class: 'note small', style: { marginBottom: '10px' } },
    `숙제 미제출·미흡이 (지난 알림을 보낸 뒤로) 5회가 된 학생이 그날 자동으로 들어와요. ${!manual() && sch.hw5_auto ? `${sch.send}에 자동 발송돼요.` : '원장님이 확인하고 보내요.'} 보내고 나면 횟수는 처음부터 다시 세요.`));
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
      h('span', { class: 'small muted' }, !manual() && sch.missing_auto ? `· ${sch.send}에 자동 발송` : '· 원장님이 확인하고 보내기')));
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
      const when = kind === 'growth_m' || kind === 'growth_q' ? '월간·분기 리포트는 자동으로 만들지 않아요. 아래 버튼을 누르면 이 기간 기록으로 만들어요.' : kind === 'growth1' ? '1주 성장 리포트는 자동으로 만들지 않아요. 아래 버튼을 누르면 이번 주 기록으로 만들어요.' : kind === 'growth' ? `${Number((S.meta.growth || {}).weeks) !== 1 ? '2주마다' : '매주'} ${'일월화수목금토'[(S.meta.growth || {}).day ?? 6]}요일 ${(S.meta.growth || {}).gen || '07:00'}에 자동으로 만들어져요.` : kind === 'daily' || kind === 'missing' || kind === 'hw5' ? `매일 ${sch.preview}에 자동으로 만들어져요.` : kind === 'weekly' ? `매주 ${'일월화수목금토'[sch.weekly_day]}요일 ${sch.preview}에 자동으로 만들어져요.` : `매달 말일 ${sch.preview}에 자동으로 만들어져요.`;
      list.replaceChildren(h('div', { class: 'card empty' }, h('b', null, '아직 미리보기가 없어요'), h('div', null, when),
        h('button', { class: 'btn primary mt', onclick: async (e) => { e.target.disabled = true; await outbox.flushAll(); await api('/api/messages/generate', { kind, ref }); if (GK.includes(kind)) return runAi(e.target); load(); } }, GK.includes(kind) ? '지금 리포트 만들기' : '지금 미리보기 만들기')));
      return;
    }
    if (!v.length) { list.replaceChildren(h('div', { class: 'card empty' }, h('b', null, kind === 'missing' ? '미제출 학생이 없어요' : kind === 'hw5' ? '오늘 숙제 5회 누적 학생이 없어요' : '보낼 메시지가 없어요'))); return; }
    const missingTpl = data.kakaoOnly && v.some((m) => m.noTemplate);
    list.replaceChildren(
      missingTpl ? h('div', { class: 'note bad', style: { marginBottom: '12px' } }, h('b', null, '알림톡 템플릿이 없는 메시지가 있어요. '), '알림톡 전용이라 문자로 대신 보내지 않아요. 관리 → 발송 방식에서 이 종류의 템플릿을 등록해 주세요.') : null,
      ...v.map(card));
    requestAnimationFrame(() => { for (const t of list.querySelectorAll('textarea')) grow(t); });
  }
  function grow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 4, 560) + 'px'; }

  function checkedList() { return visible().filter((m) => m.checked); }
  function drawBar() {
    const v = visible();
    const canCheck = v.filter((m) => !m.checked && !m.locked && m.status !== 'sent');
    const canUncheck = v.filter((m) => m.checked);
    const n = checkedList().length;
    const G = GK.includes(kind);
    const queued = G ? v.filter((m) => m.report_status === 'queued').length : 0;
    bar.replaceChildren(
      h('button', { class: 'btn small', disabled: !canCheck.length, onclick: () => bulk(canCheck, 1) }, G ? '모두 승인' : '모두 체크'),
      h('button', { class: 'btn small', disabled: !canUncheck.length, onclick: () => bulk(canUncheck, 0) }, G ? '승인 모두 해제' : '모두 해제'),
      G ? h('button', { class: 'btn small', onclick: () => openPlans(kind, ref, load) }, '📋 반별 다음 계획') : null,
      G && queued ? h('button', { class: 'btn small primary', 'data-ai-btn': '1', onclick: (e) => runAi(e.target) }, `AI로 지금 쓰기 (${queued}명 남음)`) : null,
      data && (data.generated || data.list.length) ? h('button', { class: 'btn small ghost', onclick: async (e) => {
        e.target.disabled = true; await outbox.flushAll(); await api('/api/messages/generate', { kind, ref }); toast('최신 수업 기록으로 다시 만들었어요'); load();
      } }, '미리보기 다시 만들기') : null,
      canSend()
        ? h('button', { class: 'btn primary', style: { marginLeft: 'auto' }, disabled: !n || sending, onclick: sendChecked }, sending ? '보내는 중…' : GK.includes(kind) ? `승인된 ${n}건 지금 보내기` : `체크된 ${n}건 지금 보내기`)
        : h('span', { class: 'small muted', style: { marginLeft: 'auto' } }, `체크 ${n}건 · 원장님이 확인 후 보내요`));
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

  // 알림톡 전용: 승인된 문구 그대로 나가니, 메시지마다 "선생님 한마디"만 고칠 수 있어요
  function kakaoCard(m, cb, st) {
    const pre = h('pre', { class: 'kakao-preview', id: `kp-${m.id}` }, m.kakaoPreview || '');
    const isPeriod = kind === 'weekly' || kind === 'monthly';
    const inp = h('textarea', { class: 'input', rows: 2, value: m.comment || '', placeholder: isPeriod ? '선생님 코멘트 (이 메시지에만)' : '선생님 한마디 (이 메시지에만)', oninput: () => {
      m.comment = inp.value;
      outbox.put(`ovr:${m.id}`, '/api/messages/override', { id: m.id, comment: inp.value }, 1000);
    } });
    const saveSt = h('span', { 'data-save': `ovr:${m.id}` });
    return h('section', { class: 'card msg' + (m.status === 'sent' ? ' sent' : '') + (m.locked ? ' locked' : '') },
      h('div', { class: 'msg-head' },
        h('label', { class: 'check' }, cb, h('b', null, m.student_name)),
        h('span', { class: 'small muted' }, m.class_name || ''),
        m.noTemplate ? h('span', { class: 'chip bad' }, '알림톡 템플릿 없음') : h('span', { class: 'chip line' }, m.via),
        m.locked ? h('span', { class: 'chip warn', title: '"모두 체크"에서 빠져요' }, m.locked) : null,
        st),
      m.noTemplate
        ? h('div', { class: 'note bad small' }, '이 종류의 알림톡 템플릿이 아직 없어서 보낼 수 없어요. 관리 → 발송 방식에서 카카오 승인을 받은 템플릿을 등록해 주세요.')
        : pre,
      kind === 'daily' && m.has_photo ? h('div', { class: 'row mt-s photo-row' },
        h('span', { class: 'chip ' + (m.photo_off ? '' : 'ok') }, m.photo_off ? '📷 사진·영상 빼고 보냄' : m.photo_tpl ? '📷 사진·영상 버튼 포함' : '📷 사진·영상 있음'),
        !m.photo_off && !m.photo_tpl ? h('span', { class: 'tiny muted' }, '사진 버튼 템플릿이 승인되면 버튼이 함께 가요') : null,
        m.status !== 'sent' ? h('button', { class: 'btn small ghost', onclick: async () => {
          await api('/api/messages/photo', { id: m.id, off: !m.photo_off }); toast(m.photo_off ? '사진·영상을 넣었어요' : '사진·영상을 뺐어요'); load();
        } }, m.photo_off ? '사진 넣기' : '사진 빼기') : null) : null,
      h('label', { class: 'field mt-s' }, h('span', { class: 'lbl' }, isPeriod ? '선생님 코멘트' : '선생님 한마디', h('span', { class: 'tiny muted', style: { fontWeight: 500 } }, ' — 알림톡 문구 안의 이 칸만 고칠 수 있어요')), inp),
      m.status === 'failed' && m.error ? h('div', { class: 'note bad small mt-s' }, '실패 이유: ', m.error, ' — 발송 시간에 한 번 더 자동으로 보내요.') : null,
      h('div', { class: 'msg-foot' }, saveSt,
        m.overridden ? h('button', { class: 'btn small ghost', onclick: async () => { await outbox.flush(`ovr:${m.id}`); await api('/api/messages/override', { id: m.id, reset: true }); toast('수업 기록의 한마디로 되돌렸어요'); load(); } }, '수업 기록 한마디로 되돌리기') : null));
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
    if (GK.includes(kind)) return growthCard(m, cb, st);
    if (data.kakaoOnly) return kakaoCard(m, cb, st);
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

  // ── 주간 성장 리포트 ──
  async function runAi(btn) {
    if (btn) btn.disabled = true;
    let left = 1, guard = 0;
    while (left > 0 && guard++ < 60) {
      try { const r = await api('/api/report/process', { ref, kind }); left = r.left; if (btn) btn.textContent = left ? `AI가 쓰는 중… (${left}명 남음)` : '다 썼어요'; }
      catch (e) { toast(e.message, true); break; }
      // 다 쓰기 전에도 학생 목록을 바로 보여 주고, 몇 명씩 끝날 때마다 새로 고침
      if (guard === 1 || guard % 3 === 0) { toast(left ? `AI가 리포트를 쓰는 중이에요 (${left}명 남음). 화면을 닫아도 계속 써요.` : '리포트를 다 썼어요'); await load(); btn = document.querySelector('[data-ai-btn]') || btn; }
    }
    load();
  }
  function growthCard(m, cb, st) {
    const ready = m.report_status === 'ready';
    if (!ready && !m.checked) cb.disabled = true;
    const src = !ready ? h('span', { class: 'chip warn' }, 'AI 작성 중') : m.report_source === 'rule' ? h('span', { class: 'chip warn', title: m.report_error || '' }, '기록만으로 정리 (AI 미사용)') : h('span', { class: 'chip info' }, m.report_edited ? 'AI 작성 · 직접 수정함' : 'AI 작성');
    return h('section', { class: 'card msg' + (m.status === 'sent' ? ' sent' : '') + (m.locked ? ' locked' : '') },
      h('div', { class: 'msg-head' },
        h('label', { class: 'check' }, cb, h('b', null, m.student_name), h('span', { class: 'tiny muted', style: { marginLeft: '4px' } }, '승인')),
        h('span', { class: 'small muted' }, m.class_name || ''), src,
        m.noTemplate ? h('span', { class: 'chip bad' }, '알림톡 템플릿 없음') : h('span', { class: 'chip line' }, m.via),
        m.report_viewed ? h('span', { class: 'chip ok' }, `학부모 열람 ${hmOf(m.report_viewed)}`) : null, st),
      m.noTemplate ? h('div', { class: 'note bad small' }, '"주간 성장 리포트" 알림톡 템플릿이 아직 없어요. 관리 → 발송 방식에서 카카오 승인을 받은 템플릿을 등록해 주세요.')
        : h('pre', { class: 'kakao-preview' }, m.kakaoPreview || m.text || ''),
      m.status === 'failed' && m.error ? h('div', { class: 'note bad small mt-s' }, '실패 이유: ', m.error) : null,
      h('div', { class: 'msg-foot' },
        h('button', { class: 'btn small', disabled: !m.report_id, onclick: () => openReport(m) }, '리포트 보기 · 수정'),
        ready && !m.noTemplate ? h('button', { class: 'btn small ghost', onclick: async () => {
          if (!canSend()) return toast('알림톡은 원장님이 확인하고 보내요', true);
          if (!(await confirmBox('이 학생만 보낼까요?', `${m.student_name} 학부모님께 주간 성장 리포트를 보냅니다.`, '보내기'))) return;
          try { const r = await api('/api/messages/send', { ids: [m.id], resend: m.status === 'sent' }); toast(r.failed ? '보내지 못했어요' : '보냈어요', !!r.failed); } catch (e) { toast(e.message, true); }
          load();
        } }, '이 학생만 보내기') : null));
  }
  async function openReport(m) {
    let R;
    try { R = await api(`/api/report?id=${m.report_id}`); } catch (e) { toast(e.message, true); return; }
    const FIELDS = [['overview', '학습 성취도 (총평)'], ['skills', '영역별 학습 진단 (한 줄에 "영역|단계|진단", 단계: 도입·발전·안정·심화)'], ['concepts', '이번 주 주요 학습 개념'], ['strengths', '잘하고 있는 부분'], ['growth', '지난주보다 성장한 부분'],
      ['practice', '조금 더 연습이 필요한 부분'], ['weak_concepts', '어려워하는 학습 개념'], ['academy_done', '이번 주 학원에서 지도한 내용'], ['academy_plan', '앞으로 학원에서 지도할 계획'],
      ['goals', '다음 기간 학습 목표'], ['next_week', '다음 주 학습 예정'], ['home_tips', '가정에서 도와주시면 좋은 부분'], ['teacher_comment', '선생님의 특별 코멘트']];
    const LIST = new Set(['skills', 'strengths', 'growth', 'practice', 'weak_concepts', 'academy_done', 'academy_plan', 'goals', 'home_tips']);
    sheet(`${R.student} 주간 성장 리포트`, (close) => {
      const frame = h('iframe', { class: 'rep-frame', title: '리포트 미리보기' });
      frame.srcdoc = R.html;
      const c = { ...R.content };
      const tas = FIELDS.map(([k, label]) => {
        const ta = h('textarea', { class: 'input', rows: k === 'teacher_comment' ? 4 : 2, value: LIST.has(k) ? (c[k] || []).join('\n') : (c[k] || ''), oninput: () => { c[k] = LIST.has(k) ? ta.value.split('\n').map((x) => x.trim()).filter(Boolean) : ta.value; } });
        // 어느 칸이든 짧게 적고 "AI로 다듬기"를 누르면 그 뜻을 살려 자연스럽고 전문적인 문장으로
        const polish = h('button', { class: 'btn small mt-s', type: 'button', onclick: async (e) => {
          if (!ta.value.trim()) { toast('짧게라도 먼저 적어 주세요', true); return; }
          e.target.disabled = true; e.target.textContent = 'AI가 다듬는 중…';
          try { const r = await api('/api/report/polish', { id: R.id, field: k, text: ta.value }); ta.value = r.text; c[k] = r.list || r.text; grow(ta); toast('다듬었어요. 확인하고 "고친 내용 저장"을 눌러 주세요'); }
          catch (err) { toast(err.message, true); }
          e.target.disabled = false; e.target.textContent = 'AI로 다듬기';
        } }, 'AI로 다듬기');
        ta._key = k;
        return h('label', { class: 'field mt-s' }, h('span', { class: 'lbl' }, label,
          LIST.has(k) ? h('span', { class: 'tiny muted', style: { fontWeight: 500 } }, ' — 한 줄에 하나씩') : null), ta, polish);
      });
      const polishAllBtn = h('button', { class: 'btn', type: 'button', onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = 'AI가 고친 칸을 다듬는 중…';
        try {
          const r = await api('/api/report/polish-all', { id: R.id, content: c, base: R.content });
          if (!r.changed.length) { toast('고친 칸이 없어요. 칸에 메모를 적은 뒤 눌러 주세요', true); e.target.disabled = false; e.target.textContent = '고친 칸 모두 AI로 다듬기'; return; }
          for (const ta of tas.map((l) => l.querySelector('textarea'))) {
            const k = ta._key; c[k] = r.content[k];
            ta.value = LIST.has(k) ? (r.content[k] || []).join('\n') : (r.content[k] || ''); grow(ta);
          }
          toast(`고친 ${r.changed.length}칸을 다듬었어요. 확인하고 "고친 내용 저장"을 눌러 주세요`);
        } catch (err) { toast(err.message, true); }
        e.target.disabled = false; e.target.textContent = '고친 칸 모두 AI로 다듬기';
      } }, '고친 칸 모두 AI로 다듬기');
      const edit = h('div', { class: 'rep-edit hidden' },
        h('div', { class: 'note small' }, '칸마다 짧게 메모처럼 적어도 돼요. 칸 아래 "AI로 다듬기"는 그 칸만, 맨 아래 "고친 칸 모두 AI로 다듬기"는 원장님이 고친 칸들을 한 번에(동시에) 자연스럽고 전문적인 문장으로 바꿔요. 적은 뜻은 그대로 살리고, 기록에 없는 내용은 지어내지 않아요.'),
        ...tas,
        h('div', { class: 'row mt' },
          polishAllBtn,
          h('button', { class: 'btn primary', onclick: async () => { try { await api('/api/report/edit', { id: R.id, content: c }); toast('고친 내용을 저장했어요'); close(); openReport(m); load(); } catch (e) { toast(e.message, true); } } }, '고친 내용 저장'),
          R.edited ? h('button', { class: 'btn ghost', onclick: async () => { await api('/api/report/edit', { id: R.id, reset: true }); toast('AI가 쓴 문장으로 되돌렸어요'); close(); openReport(m); } }, 'AI 문장으로 되돌리기') : null));
      return h('div', null,
        R.source === 'rule' ? h('div', { class: 'note warn small' }, 'AI를 쓰지 못해서 수업 기록만으로 정리했어요', R.error ? ` (${R.error})` : '', '. "AI 다시 쓰기"를 눌러 볼 수 있어요.') : null,
        h('div', { class: 'row', style: { marginBottom: '8px' } },
          h('button', { class: 'btn small', onclick: () => edit.classList.toggle('hidden') }, '직접 수정'),
          h('button', { class: 'btn small', onclick: async (e) => {
            if (R.edited && !(await confirmBox('AI로 다시 쓸까요?', '직접 고친 내용은 사라지고 AI가 새로 써요.', '다시 쓰기', true))) return;
            e.target.disabled = true; e.target.textContent = 'AI가 쓰는 중…';
            try { await api('/api/report/regenerate', { id: R.id }); toast('새로 썼어요'); close(); openReport(m); load(); } catch (err) { toast(err.message, true); e.target.disabled = false; }
          } }, 'AI 다시 쓰기'),
          h('button', { class: 'btn small', onclick: () => copyText(R.text) }, '카카오톡용 텍스트 복사'),
          h('button', { class: 'btn small', onclick: () => frame.contentWindow && frame.contentWindow.print() }, 'PDF 저장 · 인쇄'),
          h('button', { class: 'btn small ghost', onclick: () => copyText(R.link) }, '학부모 링크 복사')),
        frame, edit,
        h('div', { class: 'tiny muted mt-s' }, '학부모님은 링크를 열 때 휴대폰 번호 뒷자리 4자리를 입력해야 볼 수 있어요.', R.model ? ` · AI: ${R.model.replace('@cf/', '')}` : ''));
    });
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

  const refreshPreview = debounce(async () => {
    try {
      const fresh = await api(`/api/messages?kind=${kind}&ref=${ref}`);
      for (const f of fresh.list) { const pre = document.getElementById(`kp-${f.id}`); if (pre && f.kakaoPreview) pre.textContent = f.kakaoPreview; }
    } catch { /* 다음에 */ }
  }, 400);
  const off = outbox.on((key) => {
    const el = document.querySelector(`[data-save="${CSS.escape(key)}"]`);
    if (el) { const s = saveLabel(key); el.className = 'savest ' + s.cls; el.textContent = s.text; }
    if (key.startsWith('ovr:') && saveLabel(key).cls === 'ok') refreshPreview();
  });
  S.stopPoll = () => off();
  await load();
}

// ───────── 보낸 내역 ─────────
async function renderSent(main, seg) {
  let to = sessionStorage.getItem('cm_sent_to') || kstToday();
  let from = sessionStorage.getItem('cm_sent_from') || addDays(to, -6);
  let q = '';
  let data = null;
  const fromIn = h('input', { type: 'date', class: 'input', style: { width: 'auto' }, value: from, onchange: () => { from = fromIn.value; sessionStorage.setItem('cm_sent_from', from); load(); } });
  const toIn = h('input', { type: 'date', class: 'input', style: { width: 'auto' }, value: to, onchange: () => { to = toIn.value; sessionStorage.setItem('cm_sent_to', to); load(); } });
  const search = h('input', { class: 'input', placeholder: '학생·반 이름 찾기', style: { maxWidth: '200px' }, oninput: () => { q = search.value.trim(); draw(); } });
  const summary = h('div', { class: 'msg-sum' });
  const list = h('div', null, h('div', { class: 'empty' }, '불러오는 중…'));
  main.replaceChildren(h('div', { class: 'toolbar' }, seg), h('div', { class: 'row', style: { margin: '6px 0 10px' } }, fromIn, h('span', null, '~'), toIn, search), summary, list);
  async function load() {
    list.replaceChildren(h('div', { class: 'empty' }, '불러오는 중…'));
    try { data = await api(`/api/messages/sent?from=${from}&to=${to}`); } catch (e) { list.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
    draw();
  }
  function draw() {
    const v = data.list.filter((m) => !q || `${m.student} ${m.class_name}`.includes(q));
    const ok = v.filter((m) => m.status === 'sent').length;
    const byKind = {};
    for (const m of v) if (m.status === 'sent') byKind[m.kind_label] = (byKind[m.kind_label] || 0) + 1;
    summary.replaceChildren(h('span', null, '보냄 ', h('b', { style: { color: 'var(--ok)' } }, ok), '건'),
      h('span', null, '실패 ', h('b', { style: { color: v.length - ok ? 'var(--bad)' : 'inherit' } }, v.length - ok), '건'),
      ...Object.entries(byKind).map(([k, n]) => h('span', { class: 'small muted' }, `${k} ${n}`)));
    if (!v.length) { list.replaceChildren(h('div', { class: 'card empty' }, '이 기간에 보낸 알림톡이 없어요.')); return; }
    let day = '';
    const out = [];
    for (const m of v) {
      const d = String(m.sent_at).slice(0, 10);
      if (d !== day) { day = d; out.push(h('div', { class: 'small', style: { fontWeight: 700, margin: '14px 0 6px' } }, dateLabel(d))); }
      const body = h('pre', { class: 'sent-text hidden' }, m.text || '');
      out.push(h('div', { class: 'card card-pad sent-row' },
        h('div', { class: 'row', style: { cursor: 'pointer' }, onclick: () => body.classList.toggle('hidden') },
          h('b', null, m.student || '-'), h('span', { class: 'small muted' }, m.class_name),
          h('span', { class: 'chip' }, m.kind_label),
          h('span', { class: 'grow' }),
          m.status === 'sent' ? h('span', { class: 'chip ok' }, `보냄 ${hmOf(m.sent_at)}`) : h('span', { class: 'chip bad', title: m.error }, '실패'),
          h('span', { class: 'tiny muted' }, '문구 보기 ▾')),
        m.status !== 'sent' && m.error ? h('div', { class: 'tiny', style: { color: 'var(--bad)', marginTop: '4px' } }, m.error) : null,
        body));
    }
    list.replaceChildren(...out);
  }
  load();
}

// ───────── 상담용 리포트 (학생 한 명, 최근 3개월) ─────────
async function renderConsult(main, seg) {
  const list = h('div', null, h('div', { class: 'empty' }, '불러오는 중…'));
  const madeBox = h('div');
  let today;
  try { today = await api(`/api/today?date=${kstToday()}&all=1`); } catch (e) { main.replaceChildren(h('div', { class: 'toolbar' }, seg), h('div', { class: 'note bad' }, e.message)); return; }
  const classes = today.classes || [];
  let cid = Number(sessionStorage.getItem('cm_consult_class') || (classes[0] && classes[0].id) || 0);
  const sel = h('select', { class: 'input', style: { width: 'auto' }, onchange: () => { cid = Number(sel.value); sessionStorage.setItem('cm_consult_class', cid); draw(); } },
    classes.map((c) => h('option', { value: c.id, selected: c.id === cid }, c.name)));
  main.replaceChildren(h('div', { class: 'toolbar' }, seg),
    h('div', { class: 'note small', style: { marginBottom: '10px' } }, '학부모 상담 때 함께 보며 이야기 나눌 리포트예요. 학생을 고르면 최근 3개월 기록으로 AI가 써요 (30초쯤). 학부모님께 알림톡으로 보내지 않고, 화면으로 보여 주거나 PDF로 인쇄해서 쓰세요.'),
    h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', { class: 'small' }, '반'), sel), list, madeBox);
  function draw() {
    const c = classes.find((x) => x.id === cid);
    if (!c) { list.replaceChildren(h('div', { class: 'card empty' }, '반이 없어요.')); return; }
    list.replaceChildren(h('div', { class: 'card' }, ...c.students.map((st) => h('div', { class: 'list-item' },
      h('b', { class: 'grow' }, st.name),
      h('button', { class: 'btn small primary', onclick: (e) => make(st, e.target) }, '상담 리포트 만들기')))));
  }
  async function make(st, btn, rewrite) {
    btn.disabled = true; const t = btn.textContent; btn.textContent = 'AI가 쓰는 중… (30초쯤)';
    try { const r = await api('/api/report/consult', { student_id: st.id, date: kstToday(), rewrite: !!rewrite }); await viewConsult(r.id, st); loadMade(); }
    catch (e) { toast(e.message, true); }
    btn.disabled = false; btn.textContent = t;
  }
  async function viewConsult(id, st) {
    let R; try { R = await api(`/api/report?id=${id}`); } catch (e) { toast(e.message, true); return; }
    sheet(`${R.student} 상담용 리포트`, (close) => {
      const frame = h('iframe', { class: 'rep-frame', title: '상담용 리포트' }); frame.srcdoc = R.html;
      return h('div', null,
        h('div', { class: 'row', style: { marginBottom: '8px' } },
          h('button', { class: 'btn small primary', onclick: () => frame.contentWindow && frame.contentWindow.print() }, 'PDF 저장 · 인쇄'),
          h('button', { class: 'btn small', onclick: () => copyText(R.text) }, '텍스트 복사'),
          h('button', { class: 'btn small', onclick: async (e) => { close(); await make(st || { id: R.student_id }, e.target, true); } }, 'AI 다시 쓰기')),
        frame);
    });
  }
  async function loadMade() {
    try {
      const { list: rows } = await api('/api/report/consults');
      madeBox.replaceChildren(rows.length ? h('div', { class: 'mt' }, h('div', { class: 'small', style: { fontWeight: 700, margin: '10px 0 6px' } }, '만들어 둔 상담 리포트'),
        h('div', { class: 'card' }, ...rows.map((r) => h('div', { class: 'list-item', onclick: () => viewConsult(r.id, { id: r.student_id, name: r.student }) },
          h('b', null, r.student), h('span', { class: 'small muted grow' }, ` ${r.class_name || ''} · ${r.ref}`), h('span', { class: 'chip' }, r.status === 'ready' ? '보기' : '작성 중'))))) : null);
    } catch { /* */ }
  }
  draw(); loadMade();
}

// ───────── 반별 다음 기간 계획 (Weekly Plan): 성장 리포트 "다음 학습 예정"에 그대로 들어가요 ─────────
async function openPlans(kind, ref, onDone) {
  let D;
  try { D = await api(`/api/plans?kind=${kind}&ref=${ref}`); } catch (e) { toast(e.message, true); return; }
  sheet('반별 다음 계획 (Weekly Plan)', () => {
    const wrap = h('div', { class: 'stack' },
      h('div', { class: 'note small' }, '반마다 다음 기간 수업 계획을 적어 두면, 그 반 학생들의 성장 리포트 "다음 학습 예정" 칸에 표처럼 들어가요. 빈칸은 리포트에 나오지 않아요. 입력하면 자동 저장돼요. 이미 AI가 쓴 리포트에도 바로 보여요.'));
    if (!D.classes.length) wrap.append(h('div', { class: 'card empty' }, '그룹 반이 없어요.'));
    for (const c of D.classes) {
      const f = { ...c.fields };
      const st = h('span', { class: 'tiny muted' }, c.saved ? '저장됨' : '');
      const save = debounce(async () => {
        st.textContent = '저장 중…';
        try { await api('/api/plans', { class_id: c.id, kind, ref, fields: f }); st.textContent = '저장됨'; } catch (e) { st.textContent = '저장 실패'; toast(e.message, true); }
      }, 900);
      const body = h('div', { class: 'stack mt-s' + (c.saved ? '' : ' hidden') }, ...D.fields.map(([k, label]) => {
        const multi = k === 'cc4' || k === 'writing' || k === 'etc' || k === 'grammar';
        const inp = h(multi ? 'textarea' : 'input', { class: 'input', rows: multi ? 2 : undefined, value: f[k] || '', placeholder: label, oninput: () => { f[k] = inp.value; save(); } });
        return h('label', { class: 'field' }, h('span', { class: 'lbl' }, `■ ${label}`), inp);
      }));
      wrap.append(h('div', { class: 'card card-pad' },
        h('div', { class: 'row', style: { cursor: 'pointer' }, onclick: () => body.classList.toggle('hidden') }, h('b', null, c.name), st, h('span', { class: 'grow' }), h('span', { class: 'tiny muted' }, c.saved ? '열기 ▾' : '계획 적기 ▾')),
        body));
    }
    return wrap;
  }, { onClose: () => onDone && onDone() });
}

// 학습 결과물 사진: 찍어 올리면 AI가 코멘트 초안을 쓰고, 선생님이 확인해서 성장 리포트에 넣어요.

import { h, api, sheet, toast, icon, confirmBox, debounce } from './core.js';

const TYPES = [
  { id: 'writing', label: '라이팅' },
  { id: 'corrected', label: '고친 글·오답노트' },
  { id: 'book', label: '교재·워크북' },
  { id: 'test', label: '시험지' },
  { id: 'etc', label: '기타 활동' },
];

/** 사진을 AI가 읽기 좋은 크기의 JPG로 (글씨가 보이게 긴 변 1800px) */
async function toJpeg(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
    if (blob) return blob;
  } catch { /* 아래로 */ }
  if (/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  throw new Error('이 사진 형식은 열 수 없어요. 카메라 설정에서 "높은 호환성(JPG)"으로 찍어 주세요.');
}

async function uploadWork(file, studentId, date, type, memo) {
  const blob = await toJpeg(file);
  const q = new URLSearchParams({ student_id: studentId, date, type, memo });
  const res = await fetch(`/api/works/upload?${q}`, { method: 'POST', body: blob, headers: { 'content-type': blob.type || 'image/jpeg' }, credentials: 'same-origin' });
  let d = null; try { d = await res.json(); } catch { /* */ }
  if (!res.ok) throw new Error((d && d.error) || `올리기 실패 (${res.status})`);
  return d.work;
}

const parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };

export function openWorks(st, date) {
  sheet(`${st.name} · 학습 결과물 사진`, () => {
    let type = 'writing';
    const typeChips = h('div', { class: 'chips' });
    const paintTypes = () => typeChips.replaceChildren(...TYPES.map((t) => h('button', { class: 'chip-btn' + (t.id === type ? ' on' : ''), onclick: () => { type = t.id; paintTypes(); } }, t.label)));
    paintTypes();
    const memo = h('input', { class: 'input', placeholder: '(선택) 짧은 메모 — 예: 과거형 처음 써 봄, 관사 실수 줄어듦' });
    const input = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden', onchange: () => upload([...input.files]) });
    const list = h('div', { class: 'stack' });
    const info = h('div', { class: 'tiny muted' });

    async function load() {
      const d = await api(`/api/works?student_id=${st.id}&date=${date}`);
      info.textContent = `이번 리포트 기간 (${d.period.from.slice(5).replace('-', '/')} ~ ${d.period.to.slice(5).replace('-', '/')}) 에 올린 사진 ${d.list.length}장`;
      list.replaceChildren(...(d.list.length ? d.list.map(card) : [h('div', { class: 'muted small' }, '아직 올린 결과물 사진이 없어요.')]));
      // AI가 아직 안 쓴 사진은 이어서 쓰기
      for (const w of d.list) if (w.status === 'new') analyze(w.id);
    }

    async function analyze(id) {
      const el = list.querySelector(`[data-work="${id}"]`);
      if (el) el.replaceWith(card({ ...(el._w || { id }), status: 'analyzing' }));
      try { const { work } = await api('/api/works/analyze', { id }); replace(work); }
      catch (e) { toast(e.message, true); load().catch(() => {}); }
    }
    function replace(w) { const el = list.querySelector(`[data-work="${w.id}"]`); if (el) el.replaceWith(card(w)); }

    async function upload(files) {
      input.value = '';
      if (!files.length) return;
      const m = memo.value.trim();
      for (const f of files) {
        const row = h('div', { class: 'note' }, `${f.name || '사진'} 올리는 중…`);
        list.prepend(row);
        try {
          const w = await uploadWork(f, st.id, date, type, m);
          row.replaceWith(card({ ...w, status: 'analyzing' }));
          analyze(w.id);
        } catch (e) { row.className = 'note bad'; row.textContent = `올리기 실패: ${e.message}`; }
      }
      memo.value = '';
    }

    function card(w) {
      const ai = parse(w.ai);
      const busy = w.status === 'analyzing' || w.status === 'new';
      const save = debounce(async (patch) => {
        try { await api('/api/works/update', { id: w.id, ...patch }); st_.textContent = '저장됨'; }
        catch (e) { st_.textContent = '저장 실패'; toast(e.message, true); }
      }, 700);
      const st_ = h('span', { class: 'tiny muted' });
      const ta = h('textarea', { class: 'input', rows: 4, value: w.comment || '', placeholder: busy ? 'AI가 사진을 보고 코멘트를 쓰는 중이에요…' : '학부모님께 보일 코멘트', disabled: busy,
        oninput: () => { st_.textContent = '저장 중…'; save({ comment: ta.value }); } });
      const inc = h('input', { type: 'checkbox', checked: !!w.include, onchange: () => save({ include: inc.checked }) });
      const typeSel = h('select', { class: 'input', style: { width: 'auto' }, onchange: () => save({ type: typeSel.value }) },
        TYPES.map((t) => h('option', { value: t.id, selected: t.id === w.type }, t.label)));
      const el = h('div', { class: 'card card-pad work-card', 'data-work': w.id },
        h('div', { class: 'work-grid' },
          h('a', { href: `/api/works/${w.id}/img`, target: '_blank', rel: 'noopener' }, h('img', { src: `/api/works/${w.id}/img`, loading: 'lazy', alt: '결과물 사진', class: 'work-img' })),
          h('div', { class: 'stack', style: { gap: '6px' } },
            h('div', { class: 'row' }, h('b', { class: 'small' }, `${Number(w.date.slice(5, 7))}/${Number(w.date.slice(8, 10))}`), typeSel, h('span', { class: 'grow' }), st_),
            w.memo ? h('div', { class: 'tiny muted' }, `메모: ${w.memo}`) : null,
            busy ? h('div', { class: 'note' }, 'AI가 사진을 읽고 있어요… (10~30초)') : null,
            w.status === 'failed' ? h('div', { class: 'note bad' }, w.error || 'AI가 사진을 읽지 못했어요. 직접 쓰시거나 다시 시도해 주세요.') : null,
            !busy && ai.readable === false ? h('div', { class: 'note' }, '글씨가 잘 안 보여서 확실한 부분만 썼어요. 내용을 꼭 확인해 주세요.') : null,
            ai.what ? h('div', { class: 'tiny muted' }, `AI가 본 내용: ${ai.what}`) : null,
            ta,
            h('div', { class: 'row' },
              h('label', { class: 'row small', style: { gap: '6px', cursor: 'pointer' } }, inc, '성장 리포트에 넣기'),
              h('span', { class: 'grow' }),
              h('button', { class: 'btn small ghost', disabled: busy, onclick: () => analyze(w.id) }, 'AI 다시 쓰기'),
              h('button', { class: 'btn small ghost', onclick: async () => {
                if (!(await confirmBox('사진을 지울까요?', '지우면 성장 리포트에서도 빠져요.', '지우기', true))) return;
                await api('/api/works/delete', { id: w.id }); load();
              } }, '지우기')))));
      el._w = w;
      return el;
    }

    load().catch((e) => list.replaceChildren(h('div', { class: 'note bad' }, e.message)));
    return h('div', { class: 'stack' },
      h('div', { class: 'small', style: { fontWeight: 650 } }, '1. 어떤 결과물인가요?'), typeChips,
      h('div', { class: 'small', style: { fontWeight: 650 } }, '2. 메모 (안 써도 돼요)'), memo,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => input.click() }, icon('cam'), '3. 사진 찍기 · 고르기'), input),
      h('p', { class: 'tiny muted', style: { margin: 0 } }, 'AI가 사진을 보고 코멘트 초안을 써요. 꼭 읽어 보고 고쳐 주세요. 메모를 적으면 그 내용을 살려서 써요. 리포트를 비밀번호로 연 학부모님만 사진을 볼 수 있어요.'),
      info, list);
  });
}

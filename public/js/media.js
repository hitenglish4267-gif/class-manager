// 사진·영상 올리기 (큰 파일은 10MB씩 나눠 올리고 진행률 표시)

import { h, api, sheet, toast, icon, copyText, confirmBox } from './core.js';

function xhrPut(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.withCredentials = true;
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    x.onload = () => {
      let d = null; try { d = JSON.parse(x.responseText); } catch { /* */ }
      if (x.status >= 200 && x.status < 300) resolve(d); else reject(new Error((d && d.error) || `올리기 실패 (${x.status})`));
    };
    x.onerror = () => reject(new Error('인터넷 연결이 끊겼어요'));
    x.send(blob);
  });
}

/** 큰 사진은 휴대폰에서 미리 줄여서 올리기 (화질은 충분히 유지) */
async function shrinkPhoto(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 2.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

export async function uploadOne(file, studentId, date, onProgress) {
  const f = file.type.startsWith('image/') ? await shrinkPhoto(file) : file;
  const start = await api('/api/media/start', { student_id: studentId, date, name: f.name, mime: f.type, size: f.size });
  const parts = [];
  if (start.mode === 'single') {
    await xhrPut(`/api/media/${start.id}/part?n=1`, f, (n) => onProgress(n / f.size));
  } else {
    const size = start.partSize;
    const total = Math.ceil(f.size / size);
    for (let i = 0; i < total; i++) {
      const blob = f.slice(i * size, Math.min(f.size, (i + 1) * size));
      let tries = 0;
      for (;;) {
        try {
          const r = await xhrPut(`/api/media/${start.id}/part?n=${i + 1}`, blob, (n) => onProgress((i * size + n) / f.size));
          parts.push({ partNumber: r.partNumber, etag: r.etag });
          break;
        } catch (e) {
          if (++tries >= 3) throw e;
          await new Promise((r) => setTimeout(r, 1500 * tries));
        }
      }
    }
  }
  onProgress(1);
  return api(`/api/media/${start.id}/complete`, { parts });
}

/** 학생 사진·영상 창 */
export function openMedia(st, date, galleryUrl, onChange) {
  let count = st.media || 0;
  sheet(`${st.name} · 수업 사진·영상`, (close) => {
    const grid = h('div', { class: 'thumbs' });
    const queue = h('div', { class: 'stack' });
    const input = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, class: 'hidden', onchange: () => upload([...input.files]) });
    const linkBtn = h('button', { class: 'btn small', onclick: () => copyText(galleryUrl) }, icon('link'), '모아 보기 링크 복사');
    async function load() {
      const { list } = await api(`/api/media?student_id=${st.id}&date=${date}`);
      count = list.length;
      onChange(count);
      grid.replaceChildren(...(list.length ? list.map((m) => h('div', { class: 'thumb' },
        m.kind === 'video' ? h('video', { src: `/m/${m.token}#t=0.5`, preload: 'metadata', muted: true, playsinline: true }) : h('img', { src: `/m/${m.token}`, loading: 'lazy', alt: '' }),
        m.kind === 'video' ? h('span', { class: 'vid' }, '영상') : null,
        h('button', { class: 'del', 'aria-label': '지우기', onclick: async () => {
          if (!(await confirmBox('지울까요?', '이 사진·영상을 지우면 학부모님 모아 보기에서도 사라져요.', '지우기', true))) return;
          await api(`/api/media/${m.id}`, undefined, { method: 'DELETE' }); load();
        } }, '×'))) : [h('div', { class: 'muted small', style: { gridColumn: '1/-1' } }, '아직 올린 사진·영상이 없어요.')]));
    }
    async function upload(files) {
      input.value = '';
      for (const f of files) {
        const bar = h('i');
        const label = h('span', { class: 'small' }, `${f.name} · 0%`);
        const row = h('div', null, label, h('div', { class: 'progress mt-s' }, bar));
        queue.append(row);
        try {
          await uploadOne(f, st.id, date, (p) => { const pc = Math.min(100, Math.round(p * 100)); bar.style.width = pc + '%'; label.textContent = `${f.name} · ${pc}%`; });
          row.remove();
          await load();
        } catch (e) {
          label.textContent = `${f.name} · 실패: ${e.message}`; label.style.color = 'var(--bad)';
          toast(e.message, true);
        }
      }
      toast('올렸어요. 학부모 메시지에 사진 링크가 붙어요.');
    }
    load().catch((e) => grid.replaceChildren(h('div', { class: 'note bad' }, e.message)));
    return h('div', { class: 'stack' },
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => input.click() }, icon('cam'), '사진·영상 올리기'), linkBtn, input),
      h('p', { class: 'muted small', style: { margin: 0 } }, '긴 영상도 올릴 수 있어요. 올린 사진·영상은 30일 뒤 자동으로 지워져요.'),
      queue, grid);
  });
}

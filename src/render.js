// 문구 틀 채우기: {학생명} 같은 칸을 실제 값으로 바꾸고, 내용이 빈 줄은 빼기

import { aliasOf } from './defaults.js';

function lookup(vars, name) {
  const key = String(name).replace(/\s+/g, '');
  if (key in vars) return { known: true, value: vars[key] };
  const a = aliasOf(key);
  if (a && a in vars) return { known: true, value: vars[a] };
  if (a) return { known: true, value: '' };
  return { known: false, value: null };
}

/**
 * mode 'sms' → {이름}, mode 'kakao' → #{이름}
 */
export function renderTemplate(tpl, vars, mode = 'sms') {
  const re = mode === 'kakao' ? /#\{([^{}]+)\}/g : /(?<!#)\{([^{}]+)\}/g;
  const out = [];
  for (const line of String(tpl || '').split('\n')) {
    let had = 0, filled = 0;
    const replaced = line.replace(re, (m, name) => {
      const r = lookup(vars, name);
      if (!r.known) return m; // 모르는 칸은 그대로 둬서 오타가 보이게
      had++;
      const v = r.value == null ? '' : String(r.value);
      if (v.trim()) filled++;
      return v;
    });
    if (had > 0 && filled === 0) continue; // 내용이 빈 줄은 빼기
    out.push(replaced.replace(/\s*\(\s*\)/g, '').replace(/[ \t]+$/g, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 알림톡 문구에서 #{칸} 목록 뽑기 */
export function kakaoFields(text) {
  const names = [];
  for (const m of String(text || '').matchAll(/#\{([^{}]+)\}/g)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

/** 알림톡 변수 객체 만들기 (빈 값은 '-') */
export function kakaoVariables(text, vars) {
  const out = {};
  for (const name of kakaoFields(text)) {
    const r = lookup(vars, name);
    let v = r.known && r.value != null ? String(r.value).trim() : '';
    out[`#{${name}}`] = v || '-';
  }
  return out;
}

export function checkKakaoFields(text) {
  return kakaoFields(text).map((name) => ({ name, ok: !!(aliasOf(name) || KNOWN_DIRECT.has(name.replace(/\s+/g, ''))) }));
}
const KNOWN_DIRECT = new Set(['진도', '코멘트']);

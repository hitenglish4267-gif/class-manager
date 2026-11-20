// 문구 틀 채우기: {학생명} 같은 칸을 실제 값으로 바꾸고, 내용이 빈 줄은 빼기

import { aliasOf, KAKAO_FIELD_NAMES } from './defaults.js';

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

/** 알림톡 본문 + 버튼 링크 주소를 합친 글 (버튼 주소에 들어간 #{칸}도 값을 넘기려고) */
export function kakaoFieldText(t) {
  return [t && t.text, t && t.buttonUrl].filter(Boolean).join('\n');
}

/** 알림톡 변수 객체 만들기 (빈 값은 '-') */
export function kakaoVariables(text, vars) {
  const out = {};
  // 앱에 붙여 넣은 문구가 실제 승인 문구와 조금 달라도 칸이 비지 않게, 앱이 아는 칸 이름은 모두 함께 보내요
  // (템플릿에 없는 칸은 솔라피가 무시해요)
  for (const name of KAKAO_FIELD_NAMES) {
    const r = lookup(vars, name);
    const v = r.known && r.value != null ? String(r.value).trim() : '';
    if (v) out[`#{${name}}`] = v;
  }
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

// 솔라피(SOLAPI) 문자·알림톡 보내기
// 열쇠는 코드에 넣지 않고 Cloudflare Secrets 에서 읽어요.
//   공통: SOLAPI_SENDER (발신번호)
//   API Key 방식: SOLAPI_API_KEY, SOLAPI_API_SECRET
//   OAuth2 방식:  SOLAPI_REFRESH_TOKEN, TOKEN_ENC_KEY  (solapi-oauth.js)
// 어느 방식을 쓸지는 관리 화면의 "솔라피 인증 방식"(설정 solapi_auth.mode)이 정해요. 기본은 API Key.

import { randomToken, normPhone, validPhone } from './util.js';
import { first } from './db.js';
import { getAccessToken, OAuthError } from './solapi-oauth.js';

/** 알림톡 전용인지 (기본: 켜짐). 켜져 있으면 문자는 보내지 않고, 알림톡이 실패해도 문자로 대신 보내지 않아요 */
export async function kakaoOnly(env) {
  try {
    const r = await first(env, "SELECT v FROM settings WHERE k = 'kakao'");
    const v = r ? JSON.parse(r.v) : null;
    return !(v && v.only === false);
  } catch { return true; }
}

/** 지금 쓰는 인증 방식: 'apikey' | 'oauth2' */
export async function authMode(env) {
  try {
    const r = await first(env, "SELECT v FROM settings WHERE k = 'solapi_auth'");
    const v = r ? JSON.parse(r.v) : null;
    return v && v.mode === 'oauth2' ? 'oauth2' : 'apikey';
  } catch { return 'apikey'; }
}

const API = 'https://api.solapi.com';

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function solapiReady(env, mode = 'apikey') {
  if (!env.SOLAPI_SENDER) return false;
  if (mode === 'oauth2') return !!env.TOKEN_ENC_KEY;
  return !!(env.SOLAPI_API_KEY && env.SOLAPI_API_SECRET);
}

export function solapiStatus(env) {
  const k = String(env.SOLAPI_API_KEY || '');
  const s = String(env.SOLAPI_API_SECRET || '');
  const f = normPhone(env.SOLAPI_SENDER || '');
  return {
    ready: solapiReady(env),
    keyPrefix: k ? k.slice(0, 4) + '…' : '',
    keyLength: k.length,
    secretLength: s.length,
    sender: f ? f.slice(0, 3) + '-' + '*'.repeat(Math.max(0, f.length - 7)) + '-' + f.slice(-4) : '',
  };
}

async function apiKeyHeader(env) {
  const date = new Date().toISOString();
  const salt = randomToken(32);
  const signature = await hmacHex(env.SOLAPI_API_SECRET, date + salt);
  return `HMAC-SHA256 apiKey=${env.SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

async function call(env, method, path, body, mode = 'apikey') {
  const send = async (auth) => fetch(API + path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res;
  if (mode === 'oauth2') {
    res = await send(`Bearer ${await getAccessToken(env)}`);
    // 401 = Access Token 만료 → 한 번만 새로 받아서 다시
    if (res.status === 401) res = await send(`Bearer ${await getAccessToken(env, { force: true })}`);
  } else {
    res = await send(await apiKeyHeader(env));
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const msg = (data && (data.errorMessage || data.message || data.errorCode)) || `HTTP ${res.status}`;
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return data;
}

export async function solapiBalance(env, opts = {}) {
  return call(env, 'GET', '/cash/v1/balance', null, opts.mode || await authMode(env));
}

/**
 * items: [{ key, to, text, kakao: { pfId, templateId, variables } | null }]
 * 반환: Map(key → { ok, channel, error })
 */
export async function sendBatch(env, items, opts = {}) {
  const results = new Map();
  if (!items.length) return results;
  const mode = opts.mode || await authMode(env);
  if (!solapiReady(env, mode)) {
    for (const it of items) results.set(it.key, { ok: false, channel: '', error: '솔라피 연결 전이에요 (관리 → 발송 방식에서 확인)' });
    return results;
  }
  const from = normPhone(env.SOLAPI_SENDER);
  const only = opts.kakaoOnly ?? await kakaoOnly(env);
  const valid = [];
  for (const it of items) {
    const to = normPhone(it.to);
    if (!validPhone(to)) { results.set(it.key, { ok: false, channel: '', error: '학부모 번호가 올바르지 않아요' }); continue; }
    if (only && !it.kakao) { results.set(it.key, { ok: false, channel: '', error: '알림톡 템플릿이 없어서 보내지 못했어요 (관리 → 발송 방식에서 이 종류의 템플릿을 등록해 주세요)' }); continue; }
    valid.push({ ...it, to });
  }

  const toPayload = (it, asSms) => {
    const m = { to: it.to, from, customFields: { k: String(it.key) } };
    if (!asSms && it.kakao) {
      m.kakaoOptions = { pfId: it.kakao.pfId, templateId: it.kakao.templateId, variables: it.kakao.variables, disableSms: only };
    } else {
      m.text = it.text;
    }
    return m;
  };

  async function run(list, asSms) {
    const failedKakao = [];
    // 하루 발송 한도를 넘으면 솔라피는 그 묶음 전체를 거절해요.
    // 그래서 20건씩 나눠 보내고, 한도에 걸린 묶음은 1건씩 다시 보내 한도까지는 최대한 나가게 해요.
    const queue = [];
    for (let i = 0; i < list.length; i += 20) queue.push(list.slice(i, i + 20));
    let limitHit = '';
    while (queue.length) {
      const chunk = queue.shift();
      if (limitHit) { for (const it of chunk) results.set(it.key, { ok: false, channel: asSms || !it.kakao ? 'sms' : 'kakao', error: limitHit }); continue; }
      let data;
      try {
        data = await call(env, 'POST', '/messages/v4/send-many/detail', {
          messages: chunk.map((it) => toPayload(it, asSms)), allowDuplicates: true,
        }, mode);
      } catch (e) {
        if (e instanceof OAuthError) {
          // 토큰 문제는 문자로 바꿔 보내도 똑같이 실패하니 바로 실패 처리
          for (const it of chunk) results.set(it.key, { ok: false, channel: '', error: `OAuth2 토큰 문제: ${e.message}` });
          continue;
        }
        if (/발송량|발송 한도|한도|limit/i.test(String(e.message))) {
          if (chunk.length > 1) { queue.unshift(...chunk.map((it) => [it])); continue; }
          limitHit = `오늘 솔라피 하루 발송 한도를 다 써서 보내지 못했어요 (${e.message}). 내일 다시 보내 주세요.`;
          for (const it of chunk) results.set(it.key, { ok: false, channel: asSms || !it.kakao ? 'sms' : 'kakao', error: limitHit });
          continue;
        }
        for (const it of chunk) {
          if (!asSms && it.kakao && it.text && !only) failedKakao.push(it);
          else results.set(it.key, { ok: false, channel: asSms || !it.kakao ? 'sms' : 'kakao', error: e.message });
        }
        continue;
      }
      const failed = data.failedMessageList || [];
      const failedKeys = new Map();
      const pendingByTo = new Map();
      for (const it of chunk) { if (!pendingByTo.has(it.to)) pendingByTo.set(it.to, []); pendingByTo.get(it.to).push(it); }
      for (const f of failed) {
        let key = f.customFields && f.customFields.k;
        if (!key) { const arr = pendingByTo.get(normPhone(f.to)); if (arr && arr.length) key = String(arr.shift().key); }
        if (key) failedKeys.set(String(key), f.statusMessage || f.statusCode || '접수 실패');
      }
      for (const it of chunk) {
        const err = failedKeys.get(String(it.key));
        const channel = asSms || !it.kakao ? 'sms' : 'kakao';
        if (err) {
          if (channel === 'kakao' && it.text && !only) failedKakao.push({ ...it, kakaoError: err });
          else results.set(it.key, { ok: false, channel, error: err });
        } else results.set(it.key, { ok: true, channel: asSms && it.kakao ? 'kakao→sms' : channel, error: '' });
      }
    }
    return failedKakao;
  }

  const retry = await run(valid, false);
  // 알림톡이 실패하면 같은 내용을 문자로 대신 보내기 (알림톡 전용이면 보내지 않음)
  if (retry.length && !only) await run(retry, true);
  return results;
}

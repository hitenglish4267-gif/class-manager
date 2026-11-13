// 솔라피(SOLAPI) 문자·알림톡 보내기
// API Key / Secret / 발신번호는 코드에 넣지 않고 Cloudflare Secrets 에서 읽어요:
//   SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER

import { randomToken, normPhone, validPhone } from './util.js';

const API = 'https://api.solapi.com';

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function solapiReady(env) {
  return !!(env.SOLAPI_API_KEY && env.SOLAPI_API_SECRET && env.SOLAPI_SENDER);
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

async function call(env, method, path, body) {
  const date = new Date().toISOString();
  const salt = randomToken(32);
  const signature = await hmacHex(env.SOLAPI_API_SECRET, date + salt);
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `HMAC-SHA256 apiKey=${env.SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const msg = (data && (data.errorMessage || data.message || data.errorCode)) || `HTTP ${res.status}`;
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return data;
}

export async function solapiBalance(env) {
  return call(env, 'GET', '/cash/v1/balance');
}

/**
 * items: [{ key, to, text, kakao: { pfId, templateId, variables } | null }]
 * 반환: Map(key → { ok, channel, error })
 */
export async function sendBatch(env, items) {
  const results = new Map();
  if (!items.length) return results;
  if (!solapiReady(env)) {
    for (const it of items) results.set(it.key, { ok: false, channel: '', error: '솔라피 연결 전이에요 (관리 → 발송 방식에서 확인)' });
    return results;
  }
  const from = normPhone(env.SOLAPI_SENDER);
  const valid = [];
  for (const it of items) {
    const to = normPhone(it.to);
    if (!validPhone(to)) { results.set(it.key, { ok: false, channel: '', error: '학부모 번호가 올바르지 않아요' }); continue; }
    valid.push({ ...it, to });
  }

  const toPayload = (it, asSms) => {
    const m = { to: it.to, from, customFields: { k: String(it.key) } };
    if (!asSms && it.kakao) {
      m.kakaoOptions = { pfId: it.kakao.pfId, templateId: it.kakao.templateId, variables: it.kakao.variables, disableSms: false };
    } else {
      m.text = it.text;
    }
    return m;
  };

  async function run(list, asSms) {
    const failedKakao = [];
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      let data;
      try {
        data = await call(env, 'POST', '/messages/v4/send-many/detail', {
          messages: chunk.map((it) => toPayload(it, asSms)), allowDuplicates: true,
        });
      } catch (e) {
        for (const it of chunk) {
          if (!asSms && it.kakao && it.text) failedKakao.push(it);
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
          if (channel === 'kakao' && it.text) failedKakao.push({ ...it, kakaoError: err });
          else results.set(it.key, { ok: false, channel, error: err });
        } else results.set(it.key, { ok: true, channel: asSms && it.kakao ? 'kakao→sms' : channel, error: '' });
      }
    }
    return failedKakao;
  }

  const retry = await run(valid, false);
  // 알림톡이 실패하면 같은 내용을 문자로 대신 보내기
  if (retry.length) await run(retry, true);
  return results;
}

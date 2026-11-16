// 솔라피 OAuth2 (콘솔 발급) 토큰 관리
//
// - 원장님이 솔라피 콘솔에서 받은 Refresh Token을 Cloudflare Secret `SOLAPI_REFRESH_TOKEN`에 넣으면,
//   앱이 처음 한 번 읽어서 D1(solapi_tokens 표)에 암호화해 옮깁니다.
// - Refresh Token은 쓸 때마다 새 값으로 바뀌므로(회전) 새 값을 받는 즉시 D1에 저장합니다.
// - 옛 값을 다시 쓰면 솔라피가 도난으로 보고 토큰을 취소하므로, D1 잠금으로 한 번에 한 요청만 갱신합니다.
// - Access Token(1시간)은 만료 5분 전까지 재사용합니다.
// - 암호화 열쇠는 Cloudflare Secret `TOKEN_ENC_KEY`에만 있습니다. (D1이 새어 나가도 토큰은 읽을 수 없어요)

import { run, first, getSettings } from './db.js';
import { kstNow, randomToken } from './util.js';

const TOKEN_URL = 'https://api.solapi.com/oauth2/v1/access_token';
const LOCK_MS = 30_000;          // 갱신 잠금 시간
const FETCH_TIMEOUT_MS = 15_000; // 갱신 요청 제한 시간 (잠금 시간보다 짧게)
const EARLY_MS = 5 * 60_000;     // 만료 5분 전부터 새로 받기
export const REAUTH_DAYS = 90;   // 솔라피: 90일 지난 권한은 재승인 필요

/** 학원(계정) 구분값. 학원마다 앱·D1·Secrets가 따로라 기본은 'default' */
export function accountKey(env) {
  return String(env.SOLAPI_ACCOUNT_KEY || 'default').slice(0, 40);
}

// ───────── 암호화 (AES-GCM) ─────────
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(env) {
  if (!env.TOKEN_ENC_KEY || String(env.TOKEN_ENC_KEY).length < 16) throw new OAuthError('no_enc_key', 'Cloudflare에 TOKEN_ENC_KEY(16자 이상)가 아직 없어요');
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(String(env.TOKEN_ENC_KEY)));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(text)));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return b64(out);
}
async function decrypt(env, data) {
  const u8 = unb64(data);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.slice(0, 12) }, await aesKey(env), u8.slice(12));
    return dec.decode(pt);
  } catch {
    throw new OAuthError('bad_enc_key', 'TOKEN_ENC_KEY가 바뀌어서 저장된 토큰을 읽을 수 없어요. 솔라피에서 재발급해 다시 넣어 주세요');
  }
}
/** 값의 지문 (원래 값은 알 수 없고, 같은 값인지만 비교) */
async function fingerprint(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(text))));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class OAuthError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const ERR_KO = {
  PersonalTokenReused: '이미 쓴 Refresh Token을 다시 써서 솔라피가 토큰을 취소했어요. 솔라피 콘솔에서 재발급해 주세요',
  PersonalReauthorizationRequired: '발급한 지 90일이 지나 다시 승인이 필요해요. 솔라피 콘솔에서 재발급해 주세요',
  PersonalIntegrationLimit: '솔라피 계정의 토큰 개수(20개)를 넘었어요. 안 쓰는 토큰을 지워 주세요',
  ScopeNotAllowed: '이 계정 권한으로는 고를 수 없는 범위예요',
};

// ───────── 토큰 표 ─────────
async function getRow(env) {
  return first(env, 'SELECT * FROM solapi_tokens WHERE account = ?', accountKey(env));
}

/** Secret에 새 Refresh Token이 들어왔으면 D1로 옮기기 (같은 값이면 무시) */
async function syncSeed(env) {
  const seed = String(env.SOLAPI_REFRESH_TOKEN || '').trim();
  const row = await getRow(env);
  if (!seed) return row;
  const fp = await fingerprint(seed);
  if (row && row.seed_fp === fp) return row;
  const encSeed = await encrypt(env, seed);
  const now = kstNow().stamp;
  await run(env, `INSERT INTO solapi_tokens (account, enc_refresh, refresh_fp, seed_fp, enc_access, access_exp, issued_at, status, error, updated_at)
    VALUES (?, ?, ?, ?, NULL, 0, ?, 'ready', '', ?)
    ON CONFLICT(account) DO UPDATE SET enc_refresh = excluded.enc_refresh, refresh_fp = excluded.refresh_fp, seed_fp = excluded.seed_fp,
      enc_access = NULL, access_exp = 0, issued_at = excluded.issued_at, status = 'ready', error = '', lock_id = NULL, lock_until = 0, updated_at = excluded.updated_at`,
  accountKey(env), encSeed, fp, fp, now, now);
  return getRow(env);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function release(env, lockId) {
  await run(env, 'UPDATE solapi_tokens SET lock_id = NULL, lock_until = 0 WHERE account = ? AND lock_id = ?', accountKey(env), lockId);
}

/**
 * Access Token 받기 (저장된 것이 유효하면 그대로, 아니면 한 요청만 갱신)
 * opts.force: 저장된 Access Token을 쓰지 않고 새로 받기 (401을 받았을 때)
 */
export async function getAccessToken(env, opts = {}) {
  let row = await syncSeed(env);
  if (!row) throw new OAuthError('no_token', 'Cloudflare에 SOLAPI_REFRESH_TOKEN이 아직 없어요');
  const staleAccess = opts.force ? row.enc_access : null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const now = Date.now();
    if (row.status === 'reissue') throw new OAuthError('reissue', row.error || '솔라피 콘솔에서 토큰을 재발급해 주세요');
    const fresh = row.enc_access && row.access_exp - EARLY_MS > now && row.enc_access !== staleAccess;
    if (fresh) return decrypt(env, row.enc_access);

    // 갱신 잠금 차지하기 (D1에서 한 요청만 성공)
    const lockId = randomToken(16);
    const got = await run(env, 'UPDATE solapi_tokens SET lock_id = ?, lock_until = ? WHERE account = ? AND (lock_until IS NULL OR lock_until < ?)',
      lockId, now + LOCK_MS, accountKey(env), now);
    if (!got.meta || !got.meta.changes) {
      await sleep(500); // 다른 요청이 갱신 중 → 잠깐 기다렸다가 새 토큰 쓰기
      row = await getRow(env);
      continue;
    }
    // 잠금을 잡는 사이 누가 이미 갱신했으면 그걸 쓰기
    row = await getRow(env);
    if (row.enc_access && row.access_exp - EARLY_MS > Date.now() && row.enc_access !== staleAccess) {
      await release(env, lockId);
      return decrypt(env, row.enc_access);
    }
    return refreshNow(env, row, lockId);
  }
  throw new OAuthError('busy', '토큰 갱신이 오래 걸리고 있어요. 잠시 뒤 다시 시도해 주세요');
}

async function refreshNow(env, row, lockId) {
  const refreshToken = await decrypt(env, row.enc_refresh);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res, data = null;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
      signal: ctrl.signal,
    });
    try { data = await res.json(); } catch { data = null; }
  } catch (e) {
    clearTimeout(timer);
    await run(env, "UPDATE solapi_tokens SET error = ?, lock_id = NULL, lock_until = 0 WHERE account = ? AND lock_id = ?",
      '토큰 갱신 중 연결이 끊겼어요 (다음 발송 때 다시 시도해요)', accountKey(env), lockId);
    throw new OAuthError('network', '솔라피 토큰 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요');
  }
  clearTimeout(timer);

  if (!res.ok || !data || !data.access_token || !data.refresh_token) {
    const code = (data && (data.errorCode || data.error)) || `HTTP ${res.status}`;
    const msg = ERR_KO[code] || (data && (data.errorMessage || data.error_description || data.message)) || `토큰 발급 실패 (${code})`;
    // 토큰 자체가 죽은 경우(재사용·만료·재승인 필요·권한 없음)는 재발급 안내, 그 밖(서버 오류)은 다음에 다시 시도
    const dead = res.status === 400 || res.status === 401 || res.status === 403 || /Reused|Reauthorization|invalid_grant|Expired|Revoked/i.test(code);
    await run(env, 'UPDATE solapi_tokens SET status = ?, error = ?, lock_id = NULL, lock_until = 0 WHERE account = ? AND lock_id = ?',
      dead ? 'reissue' : 'ready', `${msg} [${code}]`, accountKey(env), lockId);
    throw new OAuthError(dead ? 'reissue' : 'server', msg);
  }

  // 새 Refresh Token을 받자마자 저장 (회전된 옛 값은 다시 쓰지 않음)
  const expMs = Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000;
  const saved = await run(env, `UPDATE solapi_tokens SET enc_refresh = ?, refresh_fp = ?, enc_access = ?, access_exp = ?, scope = ?,
      last_refresh_at = ?, status = 'ok', error = '', lock_id = NULL, lock_until = 0, updated_at = ? WHERE account = ? AND lock_id = ?`,
  await encrypt(env, data.refresh_token), await fingerprint(data.refresh_token), await encrypt(env, data.access_token), expMs,
  String(data.scope || ''), kstNow().stamp, kstNow().stamp, accountKey(env), lockId);
  if (!saved.meta || !saved.meta.changes) {
    // 잠금 시간이 지나 버린 아주 드문 경우: 새 값을 잃지 않게 그래도 저장
    await run(env, `UPDATE solapi_tokens SET enc_refresh = ?, refresh_fp = ?, enc_access = ?, access_exp = ?, scope = ?, last_refresh_at = ?,
      status = 'ok', error = '' WHERE account = ?`, await encrypt(env, data.refresh_token), await fingerprint(data.refresh_token),
    await encrypt(env, data.access_token), expMs, String(data.scope || ''), kstNow().stamp, accountKey(env));
  }
  return data.access_token;
}

/** 관리 화면에 보여 줄 상태 (토큰 값은 절대 내보내지 않음) */
export async function oauthStatus(env) {
  let row = null, err = '';
  try { row = await syncSeed(env); } catch (e) { err = e.message; }
  const settings = await getSettings(env);
  const auth = settings.solapi_auth || {};
  const issued = row && row.issued_at ? row.issued_at : null;
  let daysLeft = null;
  if (issued) {
    const issuedMs = Date.parse(issued.replace(' ', 'T') + '+09:00');
    daysLeft = Math.ceil((issuedMs + REAUTH_DAYS * 864e5 - Date.now()) / 864e5);
  }
  return {
    mode: auth.mode === 'oauth2' ? 'oauth2' : 'apikey',
    testOkAt: auth.test_ok_at || null,
    hasSeed: !!env.SOLAPI_REFRESH_TOKEN,
    hasEncKey: !!(env.TOKEN_ENC_KEY && String(env.TOKEN_ENC_KEY).length >= 16),
    hasSender: !!env.SOLAPI_SENDER,
    hasApiKey: !!(env.SOLAPI_API_KEY && env.SOLAPI_API_SECRET),
    account: accountKey(env),
    stored: !!row,
    status: row ? row.status : null,
    error: err || (row ? row.error : ''),
    scope: row ? row.scope : '',
    issuedAt: issued,
    lastRefreshAt: row ? row.last_refresh_at : null,
    accessValid: !!(row && row.enc_access && row.access_exp > Date.now()),
    daysLeft,
  };
}

// lib/tabbit.mjs — Tabbit 认证 + 指纹 + SSE 解析（探测用，含 Pro 标记位）

import { randomUUID, createHash, createHmac } from 'node:crypto';

export const DEFAULT_SIGN_KEY = 'f8d0e6a73f8d4b1a9c3d2e1f9a4b7c6d';
export const BASE = 'https://web.tabbit.ai';

function firstProxyEnv() {
  return process.env.TABBIT_HTTP_PROXY
    || process.env.TABBIT_HTTPS_PROXY
    || process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.https_proxy
    || process.env.http_proxy
    || '';
}

function normalizeProxyUrl(value) {
  const raw = value.trim();
  if (!raw) return '';
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported proxy protocol: ${url.protocol}`);
  }
  return url.href;
}

export const PROXY_URL = normalizeProxyUrl(firstProxyEnv());

if (PROXY_URL) {
  const { ProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
}

// ─── 基础哈希 ───────────────────────────────────────────────
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
export function hmacSha256Hex(key, text) {
  return createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

// ─── HMAC 签名（逆向自 60442 模块 y()）─────────────────────
// 返回 { x-timestamp, x-nonce, x-signature }
// 注意命名反直觉：x-signature=UUID, x-nonce=HMAC
export function signHeaders(body, key) {
  const ts = String(Date.now());
  const sig = randomUUID();                                   // → x-signature
  const msg = `${ts}.${sig}.${sha256Hex(body ?? '')}`;        // ts.uuid.sha256(body)
  const nonce = hmacSha256Hex(key, msg);                      // → x-nonce
  return { 'x-timestamp': ts, 'x-nonce': nonce, 'x-signature': sig };
}

// ─── Pro 会员自证 UUID（逆向自 1711 模块）──────────────────
// unique-uuid 的 index 5 是“已设默认浏览器”标记位：
//   '1' = 已设（Pro 解锁，premium 模型可用）
//   其它 = 未设（Default 模型可用，premium 模型报 492）
// 实测：真实浏览器发的 unique-uuid index 5 恒为 '1'。
// premium 模型（Claude-Opus-4.8 等）严格校验此标记位。
export function makeProUuid(isDefault = true) {
  const hex = '0123456789abcdef';
  const markerPos = 5;
  const defaultBrowserMarker = '1';
  const tsPositions = [2, 7, 11, 14, 18, 21, 25, 28];
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0').slice(-8);
  const tsMap = new Map(tsPositions.map((p, i) => [p, ts[i]]));
  const others = hex.replace(defaultBrowserMarker, '');      // 去掉 '1' 的字符集

  let out = '';
  for (let i = 0; i < 32; i++) {
    if (i === markerPos) {
      out += isDefault ? defaultBrowserMarker : others[Math.floor(Math.random() * others.length)];
    } else if (tsMap.has(i)) {
      out += tsMap.get(i);
    } else {
      out += hex[Math.floor(Math.random() * 16)];
    }
  }
  return [out.slice(0, 8), out.slice(8, 12), out.slice(12, 16), out.slice(16, 20), out.slice(20, 32)].join('-');
}

// ─── 指纹头（逆向自 38363 模块 m()/HH）─────────────────────
// x-req-ctx = base64(tabbitVersion)
// unique-uuid = 带标记位的 UUID
export function fingerprintHeaders(version, isDefault = true) {
  return {
    'x-req-ctx': Buffer.from(version, 'utf8').toString('base64'),
    'unique-uuid': makeProUuid(isDefault),
  };
}

// ─── 通用请求头 ────────────────────────────────────────────
export function baseHeaders(cookie, version, isDefault = true) {
  return {
    Cookie: cookie,
    'trace-id': randomUUID(),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    Origin: 'https://web.tabbit.ai',
    Referer: 'https://web.tabbit.ai/',
    ...fingerprintHeaders(version, isDefault),
  };
}

// ─── SSE 解析（逆向自 7978 模块 x()）────────────────────────
// 输入 Response.body (web ReadableStream)，输出异步迭代 {event, data, id}
export async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', event = '', data = '', id = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (t === '') {
        if (data) yield { event: event || 'message_chunk', data, id };
        event = ''; data = ''; id = '';
        continue;
      }
      if (t.startsWith('event: ')) event = t.slice(7).trim();
      else if (t.startsWith('data: ')) data = data ? data + '\n' + t.slice(6) : t.slice(6);
      else if (t.startsWith('id: ')) id = t.slice(4).trim();
    }
  }
  if (data) yield { event: event || 'message_chunk', data, id };
}

// ─── 会话列表获取（逆向自 newtab Server Action）─────────────
// 调用 Next.js Server Action 拉取账号历史会话列表，返回 session_id 数组
// 真实浏览器在 /newtab 页面发 POST /newtab，带 next-action 头
// 后端要求 chat_session_id 必须是已登记的会话，随机 UUID 会被拒
export async function fetchSessionList(cookie) {
  const body = '["$undefined",{"page":1,"size":20}]';
  const res = await fetch(`${BASE}/newtab`, {
    method: 'POST',
    headers: {
      'accept': 'text/x-component',
      'content-type': 'text/plain;charset=UTF-8',
      'next-action': '607f3555ebab54eceed6d8c97b0ef64a9badccbb3b',
      'next-router-state-tree': '%5B%22%22%2C%7B%22children%22%3A%5B%22newtab%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
      'origin': BASE,
      'referer': `${BASE}/newtab`,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      Cookie: cookie,
    },
    body,
  });
  if (!res.ok) throw new Error(`fetchSessionList HTTP ${res.status}`);
  const text = await res.text();
  // 从 React Server Component 响应里提取 UUID（会话 ID）
  const uuids = [...new Set(
    [...text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map(m => m[0])
  )];
  return uuids;
}

// ─── 错误类型 ──────────────────────────────────────────────
export class TabbitError extends Error {
  constructor(status, body, code, action) {
    super(`Tabbit API error ${status}${code ? ` (code=${code})` : ''}: ${(body || '').slice(0, 200)}`);
    this.name = 'TabbitError';
    this.status = status;
    this.body = body;
    this.code = code;
    this.action = action;
  }
}

// ─── 签名 key 获取（GET /chat/sign-key）────────────────────
export async function fetchSignKey(cookie, version) {
  const res = await fetch(`${BASE}/chat/sign-key`, { headers: baseHeaders(cookie, version, true) });
  const text = await res.text();
  if (!res.ok) throw new TabbitError(res.status, text);
  return text.trim() || DEFAULT_SIGN_KEY;
}

// ─── 模型列表（GET /proxy/v1/model_config/models）─────────
export async function getModels(cookie, version, signKey) {
  const body = '';
  const headers = { ...baseHeaders(cookie, version, true), ...signHeaders(body, signKey) };
  const res = await fetch(`${BASE}/proxy/v1/model_config/models?a=0&scene=chat`, { headers });
  const text = await res.text();
  if (!res.ok) throw new TabbitError(res.status, text);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new TabbitError(res.status, text); }
  const candidates = parsed?.data?.models || parsed?.data?.list || parsed?.models || parsed?.data || [];
  return Array.isArray(candidates) ? candidates : [];
}

// ─── 聊天补全（POST /api/v1/chat/completion，SSE）─────────
// yield { event, data(已 parse), raw } 事件
// content 为发给 Tabbit 的文本；model 为 selected_model（display_name）
export async function* chat({ cookie, version, signKey, sessionId, model = 'Default', content, signal }) {
  const bodyStr = JSON.stringify({
    chat_session_id: sessionId,
    message_id: null,
    content,
    selected_model: model,
    parallel_group_id: null,
    task_name: 'chat',
    agent_mode: false,
    metadatas: { html_content: `<p>${content}</p>` },
    references: [],
    entity: { key: 'd41d8cd98f00b204e9800998ecf8427e', extras: { type: 'tab', url: '' } },
  });
  const headers = {
    ...baseHeaders(cookie, version, true),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
    ...signHeaders(bodyStr, signKey),
  };
  const res = await fetch(`${BASE}/api/v1/chat/completion`, {
    method: 'POST', headers, body: bodyStr, signal,
  });
  if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) {
    const text = await res.text().catch(() => '');
    throw new TabbitError(res.status, text);
  }
  for await (const ev of parseSSE(res.body)) {
    let data = ev.data;
    try { data = JSON.parse(ev.data); } catch {}
    yield { event: ev.event, data, raw: ev.data };
  }
}

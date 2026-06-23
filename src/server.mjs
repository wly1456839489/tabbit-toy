// src/server.mjs — OpenAI 兼容代理服务（原生 http，零依赖）
//
// 端点：
//   GET  /v1/models            模型列表（OpenAI 格式）
//   POST /v1/chat/completions  聊天补全（支持 stream / 非 stream）
//   POST /v1/responses         OpenAI Responses API（支持 stream / 非 stream）
//   POST /v1/messages          Anthropic Messages API（支持 stream / 非 stream）
//   GET  /healthz              健康检查
//
// 用法：
//   node src/server.mjs
//   curl http://localhost:8787/v1/chat/completions -d '{"model":"Default","messages":[{"role":"user","content":"你好"}],"stream":true}'

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import {
  anthropicInputToMessages,
  buildAnthropicMessage,
  buildOpenAiResponse,
  contentToText,
  resolveAnthropicModel,
  responsesInputToMessages,
} from './protocols.mjs';
import {
  DEFAULT_SIGN_KEY, PROXY_URL, fetchSignKey, getModels, fetchSessionList, chat, TabbitError,
} from '../scripts/lib/tabbit.mjs';

// ─── 状态缓存 ─────────────────────────────────────────────
let signKey = config.signKey || DEFAULT_SIGN_KEY;
let signKeyFetchedAt = 0;
let sessionCache = null;
let sessionCacheAt = 0;

const SIGN_KEY_TTL = 10 * 60 * 1000;  // 10 分钟刷新一次签名 key
const SESSION_TTL = 5 * 60 * 1000;    // 5 分钟刷新一次会话列表

async function ensureSignKey() {
  if (config.signKey) return config.signKey;
  if (!signKey || Date.now() - signKeyFetchedAt > SIGN_KEY_TTL) {
    signKey = await fetchSignKey(config.cookie, config.version);
    signKeyFetchedAt = Date.now();
    log(`signKey 刷新: ${signKey.slice(0, 8)}…`);
  }
  return signKey;
}

async function getSessionId() {
  if (sessionCache && Date.now() - sessionCacheAt < SESSION_TTL) return sessionCache;
  const sessions = await fetchSessionList(config.cookie);
  if (sessions.length === 0) {
    throw new Error('账号下无可用会话，请先在 Tabbit 浏览器里创建一个对话');
  }
  sessionCache = sessions[0];
  sessionCacheAt = Date.now();
  log(`会话缓存: ${sessionCache.slice(0, 8)}… (共 ${sessions.length} 个)`);
  return sessionCache;
}

function invalidateSession() {
  sessionCache = null;
}

// ─── 工具函数 ─────────────────────────────────────────────
function log(...a) { console.log('[server]', ...a); }

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!config.apiKey) return true;
  const auth = headerValue(req.headers['authorization']);
  const apiKey = headerValue(req.headers['x-api-key']);
  return auth === `Bearer ${config.apiKey}` || apiKey === config.apiKey;
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

// OpenAI messages 数组 → Tabbit content 字符串
// 策略：把完整对话历史拼成带角色标注的文本，作为单条 content 发给 Tabbit
// （Tabbit 是会话制，但无状态代理不维护跨请求上下文，故自带历史进 content）
function messagesToContent(messages) {
  const valid = messages.filter(m => m && m.content != null);
  if (valid.length === 0) throw new Error('messages 为空');
  if (valid.length === 1) return contentToText(valid[0].content);
  const roleLabel = { assistant: 'Assistant', developer: 'Developer', system: 'System', user: 'User' };
  return valid.map(m => `[${roleLabel[m.role] || 'User'}]\n${contentToText(m.content)}`).join('\n\n');
}

async function collectTabbitText({ model, key, sessionId, content }) {
  let full = '';
  for await (const ev of chat({ cookie: config.cookie, version: config.version, signKey: key, sessionId, model, content })) {
    if (ev.event === 'message_chunk' && ev.data?.content) {
      full += ev.data.content;
    } else if (ev.event === 'error') {
      invalidateSession();
      throw new Error(ev.data?.message || 'Tabbit error');
    }
  }
  return full;
}

function writeSse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── 路由处理 ─────────────────────────────────────────────

// GET /v1/models
async function handleModels(res) {
  const key = await ensureSignKey();
  const models = await getModels(config.cookie, config.version, key);
  sendJson(res, 200, {
    object: 'list',
    data: models.map(m => ({
      id: m.display_name,
      object: 'model',
      owned_by: 'tabbit',
    })),
  });
}

// GET /healthz
async function handleHealth(res) {
  try {
    const key = await ensureSignKey();
    const sessions = await fetchSessionList(config.cookie);
    sendJson(res, 200, {
      ok: true,
      version: config.version,
      signKey: key.slice(0, 8) + '…',
      sessions: sessions.length,
    });
  } catch (e) {
    sendJson(res, 503, { ok: false, error: e.message });
  }
}

// POST /v1/chat/completions
async function handleChat(req, res, rawBody) {
  let body;
  try { body = JSON.parse(rawBody); }
  catch { return sendJson(res, 400, { error: { message: 'invalid JSON body' } }); }

  const { model = 'Default', messages, stream = false } = body;
  if (!Array.isArray(messages) || !messages.length) {
    return sendJson(res, 400, { error: { message: 'messages is required and must be non-empty array' } });
  }

  let key, sessionId, content;
  try {
    [key, sessionId] = await Promise.all([ensureSignKey(), getSessionId()]);
    content = messagesToContent(messages);
  } catch (e) {
    return sendJson(res, 502, { error: { message: 'prepare failed: ' + e.message } });
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // ─── 非流式：聚合所有 chunk ───
  if (!stream) {
    let full = '';
    try {
      for await (const ev of chat({ cookie: config.cookie, version: config.version, signKey: key, sessionId, model, content })) {
        if (ev.event === 'message_chunk' && ev.data?.content) {
          full += ev.data.content;
        } else if (ev.event === 'error') {
          invalidateSession();
          return sendJson(res, 502, { error: { message: ev.data?.message || 'Tabbit error', code: ev.data?.code } });
        }
      }
    } catch (e) {
      if (e instanceof TabbitError) invalidateSession();
      return sendJson(res, 502, { error: { message: e.message } });
    }
    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: full },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // ─── 流式：SSE 转 OpenAI chunk ───
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // 客户端断开时中止上游请求
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const sendChunk = (delta, finishReason = null) =>
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);

  // 首块：role
  sendChunk({ role: 'assistant' });

  try {
    for await (const ev of chat({ cookie: config.cookie, version: config.version, signKey: key, sessionId, model, content, signal: ac.signal })) {
      if (ev.event === 'message_chunk' && ev.data?.content) {
        sendChunk({ content: ev.data.content });
      } else if (ev.event === 'error') {
        invalidateSession();
        res.write(`data: ${JSON.stringify({ error: { message: ev.data?.message || 'Tabbit error', code: ev.data?.code } })}\n\n`);
        break;
      } else if (ev.event === 'message_finish' || ev.event === 'finish') {
        sendChunk({}, 'stop');
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      if (e instanceof TabbitError) invalidateSession();
      res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// POST /v1/responses
async function handleResponses(req, res, rawBody) {
  let body;
  try { body = JSON.parse(rawBody); }
  catch { return sendJson(res, 400, { error: { message: 'invalid JSON body' } }); }

  const { model = 'Default', stream = false } = body;
  let messages;
  try {
    messages = responsesInputToMessages(body);
  } catch (e) {
    return sendJson(res, 400, { error: { message: e.message } });
  }

  let key, sessionId, content;
  try {
    [key, sessionId] = await Promise.all([ensureSignKey(), getSessionId()]);
    content = messagesToContent(messages);
  } catch (e) {
    return sendJson(res, 502, { error: { message: 'prepare failed: ' + e.message } });
  }

  const id = `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const outputId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    try {
      const full = await collectTabbitText({ model, key, sessionId, content });
      return sendJson(res, 200, buildOpenAiResponse({ id, outputId, created, model, text: full }));
    } catch (e) {
      if (e instanceof TabbitError) invalidateSession();
      return sendJson(res, 502, { error: { message: e.message } });
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const started = buildOpenAiResponse({ id, outputId, created, model, text: '' });
  started.status = 'in_progress';
  started.output = [];
  writeSse(res, 'response.created', { type: 'response.created', response: started });
  writeSse(res, 'response.in_progress', { type: 'response.in_progress', response: started });
  writeSse(res, 'response.output_item.added', {
    type: 'response.output_item.added',
    response_id: id,
    output_index: 0,
    item: { id: outputId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
  });
  writeSse(res, 'response.content_part.added', {
    type: 'response.content_part.added',
    response_id: id,
    item_id: outputId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });

  let full = '';
  let failed = false;
  try {
    for await (const ev of chat({ cookie: config.cookie, version: config.version, signKey: key, sessionId, model, content, signal: ac.signal })) {
      if (ev.event === 'message_chunk' && ev.data?.content) {
        full += ev.data.content;
        writeSse(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          response_id: id,
          item_id: outputId,
          output_index: 0,
          content_index: 0,
          delta: ev.data.content,
        });
      } else if (ev.event === 'error') {
        failed = true;
        invalidateSession();
        writeSse(res, 'response.failed', {
          type: 'response.failed',
          response: { ...started, status: 'failed', error: { message: ev.data?.message || 'Tabbit error', code: ev.data?.code } },
        });
        break;
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      failed = true;
      if (e instanceof TabbitError) invalidateSession();
      writeSse(res, 'response.failed', {
        type: 'response.failed',
        response: { ...started, status: 'failed', error: { message: e.message } },
      });
    }
  }

  if (!failed && !ac.signal.aborted) {
    writeSse(res, 'response.output_text.done', {
      type: 'response.output_text.done',
      response_id: id,
      item_id: outputId,
      output_index: 0,
      content_index: 0,
      text: full,
    });
    writeSse(res, 'response.content_part.done', {
      type: 'response.content_part.done',
      response_id: id,
      item_id: outputId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: full, annotations: [] },
    });
    writeSse(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      response_id: id,
      output_index: 0,
      item: { id: outputId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: full, annotations: [] }] },
    });
    writeSse(res, 'response.completed', {
      type: 'response.completed',
      response: buildOpenAiResponse({ id, outputId, created, model, text: full }),
    });
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

// POST /v1/messages (Anthropic Messages API)
async function handleAnthropicMessages(req, res, rawBody) {
  let body;
  try { body = JSON.parse(rawBody); }
  catch { return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } }); }

  const requestedModel = body.model || 'Claude-Sonnet-4.6';
  const model = resolveAnthropicModel(requestedModel);
  let messages;
  try {
    messages = anthropicInputToMessages(body);
  } catch (e) {
    return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: e.message } });
  }

  let key, sessionId, content;
  try {
    [key, sessionId] = await Promise.all([ensureSignKey(), getSessionId()]);
    content = messagesToContent(messages);
  } catch (e) {
    return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'prepare failed: ' + e.message } });
  }

  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  if (!body.stream) {
    try {
      const full = await collectTabbitText({ model, key, sessionId, content });
      return sendJson(res, 200, buildAnthropicMessage({ id, model: requestedModel, text: full }));
    } catch (e) {
      if (e instanceof TabbitError) invalidateSession();
      return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: e.message } });
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  writeSse(res, 'message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model: requestedModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
  writeSse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });

  let failed = false;
  try {
    for await (const ev of chat({ cookie: config.cookie, version: config.version, signKey: key, sessionId, model, content, signal: ac.signal })) {
      if (ev.event === 'message_chunk' && ev.data?.content) {
        writeSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ev.data.content },
        });
      } else if (ev.event === 'error') {
        failed = true;
        invalidateSession();
        writeSse(res, 'error', {
          type: 'error',
          error: { type: 'api_error', message: ev.data?.message || 'Tabbit error' },
        });
        break;
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      failed = true;
      if (e instanceof TabbitError) invalidateSession();
      writeSse(res, 'error', { type: 'error', error: { type: 'api_error', message: e.message } });
    }
  }

  if (!failed && !ac.signal.aborted) {
    writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeSse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    writeSse(res, 'message_stop', { type: 'message_stop' });
  }
  res.end();
}

// ─── HTTP 服务 ────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta',
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (!checkAuth(req)) {
    return sendJson(res, 401, { error: { message: 'invalid API key', type: 'invalid_request_error' } });
  }

  try {
    if (path === '/v1/models' && req.method === 'GET') return await handleModels(res);
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      const raw = await readBody(req);
      return await handleChat(req, res, raw);
    }
    if (path === '/v1/responses' && req.method === 'POST') {
      const raw = await readBody(req);
      return await handleResponses(req, res, raw);
    }
    if (path === '/v1/messages' && req.method === 'POST') {
      const raw = await readBody(req);
      return await handleAnthropicMessages(req, res, raw);
    }
    if (path === '/healthz' && req.method === 'GET') return await handleHealth(res);
    sendJson(res, 404, { error: { message: `not found: ${req.method} ${path}` } });
  } catch (e) {
    log('error:', e);
    if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
    else res.end();
  }
});

server.listen(config.port, () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Tabbit2API · OpenAI 兼容代理');
  console.log(`  端口: ${config.port}`);
  console.log(`  鉴权: ${config.apiKey ? '已开启 (Bearer ' + config.apiKey.slice(0, 4) + '…)' : '未开启'}`);
  console.log(`  版本: ${config.version}`);
  console.log(`  HTTP proxy: ${PROXY_URL ? 'enabled' : 'disabled'}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log('  GET  /v1/models             模型列表');
  console.log('  POST /v1/chat/completions   聊天补全 (stream / 非 stream)');
  console.log('  POST /v1/responses          OpenAI Responses (stream / 非 stream)');
  console.log('  POST /v1/messages           Anthropic Messages (stream / 非 stream)');
  console.log('  GET  /healthz               健康检查');
  console.log('═══════════════════════════════════════════════════════════\n');
});

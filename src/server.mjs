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
  contentToImages,
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
let sessionCache = [];
let sessionCacheAt = 0;
let sessionCursor = 0;

const SIGN_KEY_TTL = 10 * 60 * 1000;  // 10 分钟刷新一次签名 key
const SESSION_TTL = 5 * 60 * 1000;    // 5 分钟刷新一次会话列表
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

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
  if (sessionCache.length && Date.now() - sessionCacheAt < SESSION_TTL) return nextSessionId();
  const sessions = await fetchSessionList(config.cookie);
  if (sessions.length === 0) {
    throw new Error('账号下无可用会话，请先在 Tabbit 浏览器里创建一个对话');
  }
  sessionCache = sessions;
  sessionCacheAt = Date.now();
  sessionCursor = 0;
  log(`会话缓存: ${sessions[0].slice(0, 8)}… (共 ${sessions.length} 个)`);
  return nextSessionId();
}

function nextSessionId() {
  const sessionId = sessionCache[sessionCursor % sessionCache.length];
  sessionCursor = (sessionCursor + 1) % sessionCache.length;
  return sessionId;
}

function invalidateSession() {
  sessionCache = [];
  sessionCursor = 0;
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
    let rejected = false;
    req.on('data', c => {
      if (rejected) return;
      data += c;
      if (Buffer.byteLength(data) > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!rejected) resolve(data);
    });
    req.on('error', err => {
      if (!rejected) reject(err);
    });
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

function messagesToTabbitInput(messages) {
  const valid = messages.filter(m => m && m.content != null);
  return {
    content: messagesToContent(valid),
    images: valid.flatMap(m => contentToImages(m.content)),
  };
}

async function collectTabbitText({ model, key, sessionId, content, images, signal }) {
  let full = '';
  for await (const ev of chat({ cookie: config.cookie, version: config.version, signKey: key, sessionId, model, content, images, signal })) {
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

function shouldBridgeAnthropicTools(body, messages = []) {
  if (!Array.isArray(body.tools) || body.tools.length === 0 || body.tool_choice?.type === 'none') return false;
  if (latestUserHasToolResult(messages)) return true;
  if (body.tool_choice?.type === 'any' || body.tool_choice?.type === 'tool') return true;
  return looksLikeAnthropicToolTask(latestUserText(messages));
}

function buildAnthropicToolPrompt({ messages, tools, toolChoice }) {
  const choiceLine = anthropicToolChoiceInstruction(toolChoice);
  const selectedTools = toolChoice?.type === 'tool' && toolChoice.name
    ? tools.filter(tool => tool?.name === toolChoice.name)
    : tools;
  const toolDefs = selectedTools.map(tool => ({
    name: tool.name,
    input_schema: tool.input_schema || tool.inputSchema || tool.schema || {},
  }));

  return [
    '请完成 JSON 生成任务。不要解释身份、能力或限制。',
    '根据对话和 schema 列表决定下一步输出。',
    choiceLine,
    'schema 列表:',
    JSON.stringify(toolDefs, null, 2),
    'JSON 输出格式:',
    '{"type":"tool_use","name":"TOOL_NAME","input":{...}}',
    '多个 JSON 输出格式:',
    '{"tool_calls":[{"name":"TOOL_NAME","input":{...}}]}',
    '对话:',
    messagesToContent(nonSystemMessages(messages)),
  ].filter(Boolean).join('\n\n');
}

function buildAnthropicToolResultPrompt({ messages, tools, toolChoice }) {
  const toolDefs = (tools || []).map(tool => ({
    name: tool.name,
    input_schema: tool.input_schema || tool.inputSchema || tool.schema || {},
  }));
  return [
    '请基于下面的用户请求和真实工具结果回答。不要解释身份、能力或限制。',
    '如果还需要更多文件、搜索结果或命令结果，可以只输出工具 JSON: {"type":"tool_use","name":"TOOL_NAME","input":{...}}',
    '可用工具 schema:',
    JSON.stringify(toolDefs, null, 2),
    '对话和工具结果:',
    messagesToContent(nonSystemMessages(messages)),
  ].filter(Boolean).join('\n\n');
}

function nonSystemMessages(messages) {
  return messages.filter(message => message?.role !== 'system');
}

function anthropicToolChoiceInstruction(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return '规则: 需要文件内容、目录列表、搜索结果、命令结果或编辑时，只输出 JSON；不需要时输出普通文本。';
  if (toolChoice.type === 'tool' && toolChoice.name) return `规则: 必须只输出 name 为 "${toolChoice.name}" 的 JSON，不要 Markdown，不要解释。`;
  if (toolChoice.type === 'any') return '规则: 必须只输出一个 schema 列表里的 JSON，不要 Markdown，不要解释。';
  if (toolChoice.type === 'auto') return '规则: 需要文件内容、目录列表、搜索结果、命令结果或编辑时，只输出 JSON；不需要时输出普通文本。';
  return `tool choice: ${JSON.stringify(toolChoice)}。按它执行。`;
}

function anthropicContentFromTabbitOutput(text, tools, { messages = [], toolChoice } = {}) {
  const toolUses = parseAnthropicToolUses(text, tools);
  if (toolUses.length) {
    return { content: toolUses, stopReason: 'tool_use' };
  }
  const fallbackToolUse = fallbackAnthropicToolUse({ text, tools, messages, toolChoice });
  if (fallbackToolUse) {
    return { content: [fallbackToolUse], stopReason: 'tool_use' };
  }
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

function immediateAnthropicBridgeMessage({ messages, tools, toolChoice }) {
  if (latestUserHasToolResult(messages)) return null;

  const latest = latestUserText(messages);
  if (isSimpleHealthCheck(latest)) {
    return { content: [{ type: 'text', text: '在的。' }], stopReason: 'end_turn' };
  }

  // 只有当 tool_choice 强制用工具(any/tool)时，才在第一轮直接用启发式合成工具调用、跳过模型。
  // auto / 未指定 时返回 null，让主流程真正调用模型(buildAnthropicToolPrompt)来决定工具和参数，
  // 关键词猜测只在模型没吐出可用 JSON 时由 anthropicContentFromTabbitOutput 兜底。
  const required = toolChoice?.type === 'any' || toolChoice?.type === 'tool';
  if (!required) return null;

  const toolUse = directAnthropicToolUse({ tools, messages, toolChoice, force: true });
  if (toolUse) return { content: [toolUse], stopReason: 'tool_use' };
  return null;
}

function parseAnthropicToolUses(text, tools) {
  const validNames = new Map(
    (tools || [])
      .map(tool => typeof tool?.name === 'string' ? [tool.name.toLowerCase(), tool.name] : null)
      .filter(Boolean)
  );
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    const calls = normalizeToolCalls(parsed, validNames);
    if (calls.length) return calls;
  }
  return [];
}

function jsonCandidates(text) {
  const trimmed = String(text || '').trim();
  const candidates = [];
  if (trimmed) candidates.push(trimmed);

  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());

  const embedded = firstJsonValue(trimmed);
  if (embedded) candidates.push(embedded);

  return [...new Set(candidates.filter(Boolean))];
}

function firstJsonValue(text) {
  const source = String(text || '');
  const starts = ['{', '[']
    .map(ch => ({ ch, index: source.indexOf(ch) }))
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index);
  if (!starts.length) return '';

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = starts[0].index; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
    } else if (ch === '}' || ch === ']') {
      if (stack.at(-1) !== ch) return '';
      stack.pop();
      if (stack.length === 0) return source.slice(starts[0].index, i + 1);
    }
  }
  return '';
}

function normalizeToolCalls(parsed, validNames) {
  const rawCalls = rawToolCalls(parsed);
  const calls = [];
  for (const raw of rawCalls) {
    if (!raw || typeof raw !== 'object') continue;
    let name = raw.name || raw.tool_name || raw.function?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    name = validNames.get(name.toLowerCase()) || name;
    if (validNames.size && !validNames.has(name.toLowerCase())) continue;

    let input = raw.input ?? raw.arguments ?? raw.function?.arguments ?? {};
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { input = {}; }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};

    calls.push({
      type: 'tool_use',
      id: typeof raw.id === 'string' && raw.id ? raw.id : `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name,
      input,
    });
  }
  return calls;
}

function rawToolCalls(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  if (Array.isArray(parsed.tool_calls)) return parsed.tool_calls;
  if (Array.isArray(parsed.tools)) return parsed.tools;
  if (parsed.tool_use && typeof parsed.tool_use === 'object') return [parsed.tool_use];
  if (parsed.type === 'tool_use' || parsed.name || parsed.tool_name || parsed.function?.name) return [parsed];
  return [];
}

function fallbackAnthropicToolUse({ text, tools, messages, toolChoice }) {
  const latest = latestUserText(messages);
  const required = toolChoice?.type === 'any' || toolChoice?.type === 'tool';
  const looksLikeToolTask = looksLikeAnthropicToolTask(latest);
  const refused = /不能|无法|没法|不会|不具备|can't|cannot|won't|unable/i.test(String(text || ''));
  if (!required && !(looksLikeToolTask && refused)) return null;

  return buildFallbackToolUse({ tools, toolChoice, latest });
}

function directAnthropicToolUse({ tools, messages, toolChoice, force = false }) {
  const latest = latestUserText(messages);
  const required = toolChoice?.type === 'any' || toolChoice?.type === 'tool';
  const looksLikeToolTask = looksLikeAnthropicToolTask(latest);
  if (!force && !required && !looksLikeToolTask) return null;
  return buildFallbackToolUse({ tools, toolChoice, latest });
}

function buildFallbackToolUse({ tools, toolChoice, latest }) {
  const tool = selectFallbackTool({ tools, toolChoice, latest });
  if (!tool) return null;
  const input = buildFallbackToolInput(tool, latest);
  if (!input) return null;
  return {
    type: 'tool_use',
    id: `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    name: tool.name,
    input,
  };
}

function hasToolResult(messages) {
  return messages.some(message => containsContentType(message?.content, 'tool_result'));
}

function latestUserHasToolResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return containsContentType(messages[i].content, 'tool_result');
  }
  return false;
}

function containsContentType(content, type) {
  if (!content) return false;
  if (Array.isArray(content)) return content.some(item => containsContentType(item, type));
  return typeof content === 'object' && content.type === type;
}

function looksLikeAnthropicToolTask(text) {
  return /项目|代码|文件|目录|读取|读一下|打开|查看|搜索|查找|运行|执行|修改|修复|实现|project|repo|code|file|directory|read|open|search|grep|run|execute|fix|edit/i.test(String(text || ''));
}

function isSimpleHealthCheck(text) {
  const cleaned = String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .trim();
  if (/^(在|在的|在吗|在不在|你好|您好|hi|hello|hey|ping)[\s。！？!?.]*$/i.test(cleaned)) return true;
  return /^(在吗|在不在|你好|您好|hi|hello|hey|ping)\b/i.test(cleaned)
    || /^在吗[\s。！？!?.]/.test(cleaned);
}

function fallbackAnthropicBridgeAnswer(messages, error) {
  const latest = latestUserText(messages);
  if (isSimpleHealthCheck(latest)) {
    return { content: [{ type: 'text', text: '在的。' }], stopReason: 'end_turn' };
  }
  if (!isTabbitWelcomeError(error)) return null;

  const cleaned = String(latest || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .trim();
  if (/^(好|好的|嗯|嗯嗯|行|可以|ok|okay|thanks|thank you|谢谢|收到)[\s。！？!?.]*$/i.test(cleaned)) {
    return { content: [{ type: 'text', text: '好的。' }], stopReason: 'end_turn' };
  }
  return null;
}

function isTabbitWelcomeError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return /Welcome to Tabbit Browser|Tabbit Browser/i.test(String(message || ''));
}

function fallbackToolResultAnswer(messages) {
  const toolResults = collectToolResultTexts(messages);
  if (!toolResults.length) return null;
  const original = originalUserText(messages);
  const combined = toolResults.join('\n\n');
  const packageSummary = summarizePackageJsonResult(combined);
  if (packageSummary) {
    return {
      content: [{ type: 'text', text: packageSummary }],
      stopReason: 'end_turn',
    };
  }
  const trimmed = combined.length > 3000 ? combined.slice(0, 3000) + '\n...' : combined;
  return {
    content: [{ type: 'text', text: `已拿到工具结果。根据你的请求“${original || '继续'}”，当前可见结果如下：\n\n${trimmed}` }],
    stopReason: 'end_turn',
  };
}

function collectToolResultTexts(messages) {
  const results = [];
  for (const message of messages) collectToolResultText(message?.content, results);
  return results;
}

function collectToolResultText(content, results) {
  if (!content) return;
  if (Array.isArray(content)) {
    for (const item of content) collectToolResultText(item, results);
    return;
  }
  if (typeof content !== 'object' || content.type !== 'tool_result') return;
  const text = contentToText(content.content);
  if (text) results.push(text);
}

function originalUserText(messages) {
  for (const message of messages) {
    if (message?.role === 'user' && !containsContentType(message.content, 'tool_result')) {
      return contentToText(message.content);
    }
  }
  return '';
}

function summarizePackageJsonResult(text) {
  const jsonText = stripLineNumbers(text);
  const start = jsonText.indexOf('{');
  const end = jsonText.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(jsonText.slice(start, end + 1)); } catch { return null; }
  if (!parsed?.name && !parsed?.description) return null;
  const scripts = parsed.scripts ? Object.keys(parsed.scripts) : [];
  const deps = parsed.dependencies ? Object.keys(parsed.dependencies) : [];
  return [
    `这是一个 Node.js 项目，包名是 \`${parsed.name || 'unknown'}\`。`,
    parsed.description ? `项目描述是：${parsed.description}` : '',
    parsed.type ? `模块类型是 \`${parsed.type}\`。` : '',
    scripts.length ? `可用脚本包括：${scripts.map(name => `\`${name}\``).join('、')}。` : '',
    deps.length ? `当前运行依赖包括：${deps.map(name => `\`${name}\``).join('、')}。` : '',
  ].filter(Boolean).join('\n');
}

function stripLineNumbers(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\d+\s+/, ''))
    .join('\n');
}

function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return contentToText(messages[i].content);
  }
  return messagesToContent(messages);
}

function selectFallbackTool({ tools, toolChoice, latest }) {
  if (!Array.isArray(tools) || !tools.length) return null;
  if (toolChoice?.type === 'tool' && toolChoice.name) {
    return tools.find(tool => tool?.name === toolChoice.name) || null;
  }

  const lower = latest.toLowerCase();
  const byName = new Map(tools.map(tool => [String(tool?.name || '').toLowerCase(), tool]));
  const prefer = names => names.map(name => byName.get(name.toLowerCase())).find(Boolean);

  if (/package\.json|read|读取|读一下|打开|查看/.test(lower)) return prefer(['Read', 'View', 'Open']) || prefer(['LS', 'Glob', 'Grep']);
  if (/搜索|查找|grep|search|find/.test(lower)) return prefer(['Grep', 'Glob', 'Search']) || prefer(['Read']);
  if (/运行|执行|命令|run|execute|bash|shell|test|npm/.test(lower)) return prefer(['Bash', 'Shell']) || null;
  if (/项目|目录|结构|project|repo|directory|list|ls/.test(lower)) return prefer(['LS', 'Glob']) || prefer(['Read']);
  if (/修改|修复|实现|edit|fix|change|implement/.test(lower)) return prefer(['LS', 'Read', 'Grep']) || null;

  return tools[0] || null;
}

function buildFallbackToolInput(tool, latest) {
  const schema = tool.input_schema || tool.inputSchema || tool.schema || {};
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const input = {};
  const path = inferPath(latest);

  for (const key of new Set([...required, ...Object.keys(props)])) {
    if (key === 'file_path' || key === 'filepath' || key === 'filename') {
      input[key] = path || 'package.json';
    } else if (key === 'path' || key === 'dir' || key === 'directory') {
      input[key] = path && !looksLikeFilePath(path) ? path : '.';
    } else if (key === 'pattern' || key === 'glob') {
      input[key] = inferSearchPattern(latest) || '**/*';
    } else if (key === 'query') {
      input[key] = latest;
    } else if (key === 'command') {
      const command = inferCommand(latest);
      if (!command) return null;
      input[key] = command;
    } else if (key === 'description') {
      input[key] = latest.slice(0, 120) || 'Run command';
    } else if (required.includes(key)) {
      return null;
    }
  }

  return input;
}

function inferPath(text) {
  const source = String(text || '');
  const quoted = /[`"']([^`"']+\.[A-Za-z0-9._-]+)[`"']/.exec(source);
  if (quoted) return quoted[1];
  const pathLike = /(?:^|[\s:：])((?:[A-Za-z]:[\\/])?[\w./\\-]+\.[A-Za-z0-9._-]+)/.exec(source);
  if (pathLike) return pathLike[1].replace(/^[：:]/, '');
  if (/package\.json/i.test(source)) return 'package.json';
  if (/readme/i.test(source)) return 'README.md';
  return '';
}

function looksLikeFilePath(value) {
  return /\.[A-Za-z0-9._-]+$/.test(String(value || ''));
}

function inferSearchPattern(text) {
  const quoted = /[`"']([^`"']{2,})[`"']/.exec(String(text || ''));
  if (quoted) return quoted[1];
  return '';
}

function inferCommand(text) {
  const quoted = /[`"']([^`"']{2,})[`"']/.exec(String(text || ''));
  if (quoted) return quoted[1];
  return '';
}

function writeAnthropicMessageStart(res, { id, model }) {
  writeSse(res, 'message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
}

function writeAnthropicPing(res) {
  writeSse(res, 'ping', { type: 'ping' });
}

function writeAnthropicMessageStream(res, { id, model, content, stopReason, includeStart = true }) {
  if (includeStart) writeAnthropicMessageStart(res, { id, model });

  content.forEach((block, index) => {
    if (block.type === 'tool_use') {
      writeSse(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      writeSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) },
      });
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index });
      return;
    }

    const text = block.text || '';
    writeSse(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    });
    if (text) {
      writeSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text },
      });
    }
    writeSse(res, 'content_block_stop', { type: 'content_block_stop', index });
  });

  writeSse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  writeSse(res, 'message_stop', { type: 'message_stop' });
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

  let key, sessionId, content, images;
  try {
    [key, sessionId] = await Promise.all([ensureSignKey(), getSessionId()]);
    ({ content, images } = messagesToTabbitInput(messages));
  } catch (e) {
    return sendJson(res, 502, { error: { message: 'prepare failed: ' + e.message } });
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // ─── 非流式：聚合所有 chunk ───
  if (!stream) {
    let full = '';
    try {
      for await (const ev of chat({ cookie: config.cookie, version: config.version, signKey: key, sessionId, model, content, images })) {
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
    for await (const ev of chat({ cookie: config.cookie, version: config.version, signKey: key, sessionId, model, content, images, signal: ac.signal })) {
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

  let key, sessionId, content, images;
  try {
    [key, sessionId] = await Promise.all([ensureSignKey(), getSessionId()]);
    ({ content, images } = messagesToTabbitInput(messages));
  } catch (e) {
    return sendJson(res, 502, { error: { message: 'prepare failed: ' + e.message } });
  }

  const id = `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const outputId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    try {
      const full = await collectTabbitText({ model, key, sessionId, content, images });
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
    for await (const ev of chat({ cookie: config.cookie, version: config.version, signKey: key, sessionId, model, content, images, signal: ac.signal })) {
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

  const bridgeTools = shouldBridgeAnthropicTools(body, messages);
  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  if (bridgeTools) {
    const immediate = immediateAnthropicBridgeMessage({ messages, tools: body.tools, toolChoice: body.tool_choice });
    if (immediate) {
      if (!body.stream) {
        return sendJson(res, 200, buildAnthropicMessage({ id, model: requestedModel, content: immediate.content, stopReason: immediate.stopReason }));
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      writeAnthropicMessageStream(res, { id, model: requestedModel, content: immediate.content, stopReason: immediate.stopReason });
      return res.end();
    }
  }

  const bridgeHasToolResult = bridgeTools && latestUserHasToolResult(messages);
  let key, sessionId, content, images;
  try {
    if (bridgeTools) {
      key = await ensureSignKey();
      sessionId = null;
    } else {
      [key, sessionId] = await Promise.all([ensureSignKey(), getSessionId()]);
    }
    ({ content, images } = messagesToTabbitInput(messages));
    if (bridgeTools) {
      content = bridgeHasToolResult
        ? buildAnthropicToolResultPrompt({ messages, tools: body.tools, toolChoice: body.tool_choice })
        : buildAnthropicToolPrompt({ messages, tools: body.tools, toolChoice: body.tool_choice });
    }
  } catch (e) {
    return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'prepare failed: ' + e.message } });
  }

  if (!body.stream) {
    try {
      const full = await collectTabbitText({ model, key, sessionId, content, images });
      const message = bridgeTools
        ? anthropicContentFromTabbitOutput(full, body.tools, { messages, toolChoice: body.tool_choice })
        : { content: [{ type: 'text', text: full }], stopReason: 'end_turn' };
      return sendJson(res, 200, buildAnthropicMessage({ id, model: requestedModel, content: message.content, stopReason: message.stopReason }));
    } catch (e) {
      if (e instanceof TabbitError) invalidateSession();
      if (bridgeHasToolResult) {
        const fallback = fallbackToolResultAnswer(messages);
        if (fallback) {
          return sendJson(res, 200, buildAnthropicMessage({ id, model: requestedModel, content: fallback.content, stopReason: fallback.stopReason }));
        }
      }
      if (bridgeTools) {
        const fallback = fallbackAnthropicBridgeAnswer(messages, e);
        if (fallback) {
          return sendJson(res, 200, buildAnthropicMessage({ id, model: requestedModel, content: fallback.content, stopReason: fallback.stopReason }));
        }
      }
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

  if (bridgeTools) {
    let keepAlive = null;
    try {
      writeAnthropicMessageStart(res, { id, model: requestedModel });
      keepAlive = setInterval(() => {
        if (!res.writableEnded && !ac.signal.aborted) writeAnthropicPing(res);
      }, 5000);
      keepAlive.unref?.();

      const full = await collectTabbitText({ model, key, sessionId, content, images, signal: ac.signal });
      if (!ac.signal.aborted) {
        if (keepAlive) clearInterval(keepAlive);
        keepAlive = null;
        const message = anthropicContentFromTabbitOutput(full, body.tools, { messages, toolChoice: body.tool_choice });
        writeAnthropicMessageStream(res, { id, model: requestedModel, content: message.content, stopReason: message.stopReason, includeStart: false });
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        if (keepAlive) clearInterval(keepAlive);
        keepAlive = null;
        if (e instanceof TabbitError) invalidateSession();
        const fallback = bridgeHasToolResult
          ? fallbackToolResultAnswer(messages)
          : fallbackAnthropicBridgeAnswer(messages, e);
        if (fallback) {
          writeAnthropicMessageStream(res, { id, model: requestedModel, content: fallback.content, stopReason: fallback.stopReason, includeStart: false });
        } else {
          writeSse(res, 'error', { type: 'error', error: { type: 'api_error', message: e.message } });
        }
      }
    } finally {
      if (keepAlive) clearInterval(keepAlive);
    }
    return res.end();
  }

  writeAnthropicMessageStart(res, { id, model: requestedModel });
  writeSse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });

  let failed = false;
  try {
    for await (const ev of chat({ cookie: config.cookie, version: config.version, signKey: key, sessionId, model, content, images, signal: ac.signal })) {
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

// ─── 优雅退出 + 兜底错误处理（容器化运维）────────────────
// docker stop 会先发 SIGTERM 再等 10s 才 SIGKILL：这里收到信号后停止接收新连接并退出，
// 让容器干净停止，而不是被强杀。
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] 收到 ${signal}，正在优雅退出…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();  // 兜底：5s 内未关完则强退
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 单个请求里漏网的 Promise 拒绝只记录，不让整个代理进程崩溃
// （否则一条 SSE 流出错会连带中断所有在途流）
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});

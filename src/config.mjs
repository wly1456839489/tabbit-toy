// src/config.mjs — 配置加载（.env + 环境变量）

import { readFileSync, existsSync } from 'node:fs';

function loadEnvFile() {
  const env = {};
  if (existsSync('.env')) {
    for (const rawLine of readFileSync('.env', 'utf8').split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      if (/^[A-Z_][A-Z0-9_]*$/.test(key)) env[key] = line.slice(idx + 1);
    }
  }
  return env;
}

const ENV = loadEnvFile();

export const config = {
  // Tabbit 登录态 Cookie（web.tabbit.ai 域下，含 HttpOnly token）
  cookie: ENV.TABBIT_COOKIE || process.env.TABBIT_COOKIE,
  // Tabbit 版本号，用于 x-req-ctx 头（来自 getDeviceInfo().tabbitVersion）
  version: ENV.TABBIT_VERSION || process.env.TABBIT_VERSION || '1.1.39(10101039)',
  // 签名 key（留空则自动从 /chat/sign-key 拉取并定期刷新）
  signKey: ENV.TABBIT_SIGN_KEY || process.env.TABBIT_SIGN_KEY || '',
  // HTTP 服务端口
  port: Number(ENV.PORT || process.env.PORT || 8787),
  // 可选：保护代理端点的 API Key（客户端用 Authorization: Bearer <KEY>）
  apiKey: ENV.API_KEY || process.env.API_KEY || '',
};

if (!config.cookie) {
  console.error('✗ 缺少 TABBIT_COOKIE，请在 .env 中填入 web.tabbit.ai 的 Cookie');
  process.exit(1);
}

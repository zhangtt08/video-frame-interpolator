#!/usr/bin/env node
// Agent API server — personal-agent-hub 标准模板的本地副本。
// 契约见 personal-agent-hub/docs/AGENT_API_STANDARD.md
//
// 本轮按「本地服务守卫标准」补了守卫（只监听 127.0.0.1 不是边界：恶意页面的简单 POST 就能打到本机端口）。
// 守卫的实现**不在这个文件里第二遍**：复用 dist-electron/local-guard.js（TypeScript 单一来源），
// 应用内 REST(8393) 与这里的 Agent API(8791) 走的是同一份判据。
// 守卫模块没编译出来时按 fail-closed 处理：只读端点照常，任何写请求一律拒绝并说清原因。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START = Date.now();

/** 载入共享守卫；返回 null 表示核心还没编译（npm run build:electron） */
export function loadGuard() {
  try {
    return require(path.resolve(__dirname, '..', 'dist-electron', 'local-guard.js'));
  } catch {
    return null;
  }
}

export class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function loadTools() {
  const p = path.join(__dirname, 'tools.mjs');
  if (!existsSync(p)) throw new Error(`missing ${p}: 项目必须实现 agent/tools.mjs`);
  return import(`file:///${p.replace(/\\/g, '/')}`);
}

function json(res, status, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  // 状态变更路由上永不发 Access-Control-Allow-Origin: *（模板里原本每条响应都带，等于欢迎任意网页来 POST）
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new AgentError('too_large', '请求体超过 8MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new AgentError('bad_json', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// 只校验 required 与未知键；类型宽松处理，交给业务 handler 自己收窄。
function validate(schema, input) {
  if (!schema || schema.type !== 'object') return;
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const missing = (schema.required || []).filter((k) => data[k] === undefined || data[k] === null || data[k] === '');
  if (missing.length) throw new AgentError('bad_input', `缺少必填参数：${missing.join(', ')}`);
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(data).filter((k) => !(k in (schema.properties || {})));
    if (unknown.length) throw new AgentError('bad_input', `未知参数：${unknown.join(', ')}；可用：${Object.keys(schema.properties || {}).join(', ') || '无'}`);
  }
}

export async function start({ port: wantPort, host = '127.0.0.1', label = 'agent' } = {}) {
  const mod = await loadTools();
  const meta = mod.project || { name: label, version: '0.0.0' };
  const tools = mod.tools || [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const descriptor = (t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, risk: t.risk || 'read' });

  const guard = loadGuard();
  if (!guard) {
    console.error('[agent] 未找到 dist-electron/local-guard.js —— 写请求将被拒绝。请先运行 `npm run build:electron`（或 `npm run agent:serve`）。');
  }
  const token = String(process.env.FRAMEBOOST_API_TOKEN ?? '').trim();
  if (!token) console.warn('[agent] 未设置 FRAMEBOOST_API_TOKEN：本机任何进程都能调用写接口。要给接口上锁就设这个环境变量（MCP 桥会自动带上）。');

  const server = createServer(async (req, res) => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : Number(wantPort) || 8791;
    // 守卫在最前：Host / Origin / Referer / 令牌，任何一条不过都不进业务分支
    if (guard) {
      const verdict = guard.checkLocalGuard(req, { port, token, tokenHeader: 'x-frameboost-token' });
      if (!verdict.ok) { guard.replyGuardDenied(res, verdict); return; }
    } else if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 503, { ok: false, error: { code: 'GUARD_UNAVAILABLE', message: '守卫模块缺失（dist-electron/local-guard.js），写请求按 fail-closed 拒绝。请运行 `npm run build:electron` 后重启本服务。' } });
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'OPTIONS') { json(res, 204, { ok: false, error: { code: 'NO_CORS', message: '本机服务不做跨源放行；请从本机回环地址直接调用' } }); return; }
      if (route === '/api/health') {
        json(res, 200, { ok: true, data: { project: meta.name, version: meta.version, agent_api: 1, tools: tools.length, uptime_ms: Date.now() - START, guard: { hostAllowlist: `127.0.0.1:${port} / localhost:${port} / [::1]:${port}`, tokenRequired: !!token, compiled: !!guard } } });
      } else if (route === '/api/agent/tools') {
        json(res, 200, { ok: true, data: tools.map(descriptor) });
      } else if (route === '/api/agent/manifest') {
        json(res, 200, { ok: true, data: { project: meta.name, version: meta.version, description: meta.summary || '', base_url: `http://${host}:${server.address().port}`, tools: tools.map(descriptor) } });
      } else if (route === '/api/agent/tool' && req.method === 'POST') {
        const body = await readBody(req);
        const tool = byName.get(body.tool);
        // 未注册的工具必须在这里就回完并 return：落进下面的 try 会在已结束的响应上二次发送，
        // 把 keep-alive 连接打坏，后续请求全部 ECONNRESET。
        if (!tool) { json(res, 400, { ok: false, error: { code: 'unknown_tool', message: `未注册的工具：${body.tool}`, available: [...byName.keys()] } }); return; }
        try {
          const t0 = Date.now();
          validate(tool.input_schema, body.input);
          const data = await tool.handler(body.input || {}, { meta, host, port: server.address().port });
          json(res, 200, { ok: true, tool: tool.name, ms: Date.now() - t0, data });
        } catch (e) {
          const code = e instanceof AgentError ? e.code : 'handler_failed';
          json(res, e instanceof AgentError && e.code === 'bad_input' ? 400 : 500, { ok: false, tool: tool.name, error: { code, message: e.message } });
        }
      } else {
        json(res, 404, { ok: false, error: { code: 'not_found', message: `未知路径 ${route}`, endpoints: ['/api/health', '/api/agent/tools', '/api/agent/manifest', 'POST /api/agent/tool'] } });
      }
    } catch (e) {
      // 调用方修得了的问题不能报 500：坏 JSON、超大 body、缺必填都是调用方的错，
      // 回 5xx 会让 Agent 以为"服务坏了"而反复重试，永远学不会改那行 body。
      const code = e instanceof AgentError ? e.code : 'internal';
      const callerFixable = e instanceof AgentError && ['bad_json', 'too_large', 'bad_input', 'unknown_tool', 'not_found'].includes(e.code);
      json(res, callerFixable ? 400 : 500, { ok: false, error: { code, message: e.message } });
    }
  });

  const endpointFile = path.join(__dirname, '.endpoint');
  const listen = (p, tries) => new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries > 0) resolve(listen(p + 1, tries - 1));
      else reject(e);
    });
    server.listen(p, host, () => resolve(server.address().port));
  });

  const port = await listen(wantPort || server.address()?.port || 8790, 12);
  writeFileSync(endpointFile, `http://${host}:${port}\n`);
  console.log(`[agent] ${meta.name} v${meta.version} → http://${host}:${port} (${tools.length} tools)`);
  return { server, port, url: `http://${host}:${port}`, tools: tools.map(descriptor) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envPort = Number(process.env.AGENT_PORT || process.env.PORT || 0) || undefined;
  start({ port: envPort }).catch((e) => { console.error('[agent] 启动失败：', e.message); process.exit(1); });
}

#!/usr/bin/env node
// MCP (Model Context Protocol) stdio 桥 —— 标准实现，把所有项目的 Agent API 暴露为 MCP tools。
// 用法：node <project>/agent/mcp-server.mjs
// 逻辑：读 agent/.endpoint（或 AGENT_BASE_URL）；不通则按 agent/README 里登记的启动命令自动拉起本地服务。
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROJECT_ID = 'frameboost';
const PROTOCOL = '2025-06-18';
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const SERVER_INFO = { name: path.basename(PROJECT_ROOT) + '-agent-api', version: '1.0.0' };

const log = (...a) => process.stderr.write(`[mcp] ${a.join(' ')}\n`);

function endpointFile() {
  const p = path.join(__dirname, '.endpoint');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

let API_TOKEN = '';

function tokenFromHealth(payload) {
  const guard = payload?.data?.guard || {};
  if (guard.token_file && existsSync(guard.token_file)) {
    try {
      return readFileSync(guard.token_file, 'utf8').trim();
    } catch {
      // ignore
    }
  }
  const token = String(process.env.FRAMEBOOST_API_TOKEN || process.env.AGENT_API_TOKEN || '').trim();
  if (token) return token;
  const tokenFile = path.join(process.env.APPDATA || '', 'frameboost', 'agent-api.token');
  try {
    if (existsSync(tokenFile)) return readFileSync(tokenFile, 'utf8').trim();
  } catch {
    // ignore
  }
  return '';
}

// 自动拉起后必须重新问一次健康接口：服务是这一秒才生成令牌的，
// API_TOKEN 为空时所有写/执行工具都会 401，且会一直错到桥进程退出。
async function refreshToken(base) {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) API_TOKEN = tokenFromHealth(await r.json().catch(() => null));
  } catch {
    // 保持原值
  }
  return API_TOKEN;
}

const envToken = () => String(process.env.FRAMEBOOST_API_TOKEN || process.env.AGENT_API_TOKEN || '').trim();

async function rpc(base, method, params) {
  const send = (token) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-frameboost-token'] = token;
    return fetch(`${base}/api/agent/${method === 'tools/list' ? 'tools' : 'tool'}`, {
      method: method === 'tools/list' ? 'GET' : 'POST',
      headers,
      body: method === 'tools/list' ? undefined : JSON.stringify(params),
      // 执行类工具本身可能跑很久（下载/补帧），桥不能比服务端先放弃
      signal: AbortSignal.timeout(method === 'tools/list' ? 60_000 : 1_800_000),
    });
  };
  let res = await send(API_TOKEN || envToken());
  // 令牌是磁盘上共享的：服务重启会重新生成，桥这边重读一次再试，只试一次。
  if (res.status === 401 && method !== 'tools/list') {
    const before = API_TOKEN;
    const fresh = await refreshToken(base);
    if (fresh && fresh !== before) res = await send(fresh);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    const detail = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(res.status === 401 ? `${detail}（MCP 桥没带上本机令牌）` : detail);
  }
  return body;
}

async function ensureBase() {
  const candidates = [process.env.AGENT_BASE_URL, endpointFile(), process.env.AGENT_DEFAULT_BASE, 'http://127.0.0.1:8791'].filter(Boolean);
  for (const base of candidates) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const payload = await r.json().catch(() => null);
        // 端口是共享范围（8790 起顺延），只认本项目：否则会把别的项目的 Agent 当成自己
        if (payload?.data?.project !== PROJECT_ID) continue;
        API_TOKEN = tokenFromHealth(payload);
        return base;
      }
    } catch { /* 继续尝试 */ }
  }
  // 自动拉起：约定 agent/launch.json = {"command":"node","args":["agent/server.mjs"],"ready_port":8791}
  const launchFile = path.join(__dirname, 'launch.json');
  if (!existsSync(launchFile)) throw new Error(`Agent 服务未启动且缺少 ${launchFile}；请先运行 npm run agent:serve`);
  const spec = JSON.parse(readFileSync(launchFile, 'utf8'));
  const child = spawn(spec.command, spec.args, { cwd: PROJECT_ROOT, stdio: 'ignore', detached: true, shell: false });
  child.unref();
  const port = spec.ready_port || 8790;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    // 服务在端口被占用时会顺延到 +1..+12，这里跟着扫，命中后还要用项目名确认是不是自己。
    for (let p = port; p < port + 12; p++) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(800) });
        if (!r.ok) continue;
        const payload = await r.json().catch(() => null);
        if (payload?.data?.project !== PROJECT_ID) continue;
        API_TOKEN = tokenFromHealth(payload);
        return `http://127.0.0.1:${p}`;
      } catch { /* 未就绪 */ }
    }
  }
  throw new Error('自动拉起 Agent 服务超时（30s）');
}

let BASE = null;

function msg(id, result) { return { jsonrpc: '2.0', id, result }; }
function err(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    const asked = String(params?.protocolVersion || '').trim();
    return msg(id, { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return msg(id, {});
  if (method === 'tools/list') {
    BASE = BASE || await ensureBase();
    const body = await rpc(BASE, 'tools/list');
    return msg(id, { tools: body.data.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema, annotations: { readOnlyHint: t.risk === 'read', destructiveHint: false, openWorldHint: false } })) });
  }
  if (method === 'tools/call') {
    BASE = BASE || await ensureBase();
    try {
      const body = await rpc(BASE, 'tools/call', { tool: params.name, input: params.arguments || {} });
      return msg(id, { content: [{ type: 'text', text: JSON.stringify(body.data, null, 2) }], isError: false });
    } catch (e) {
      return msg(id, { content: [{ type: 'text', text: `调用失败：${e.message}` }], isError: true });
    }
  }
  return err(id, -32601, `不支持的方法：${method}`);
}

let buf = '';

function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { write(err(null, -32700, 'parse error')); continue; }
    // 响应是异步的。切勿在此 process.exit()：stdout 接管道时写是异步缓冲的，
    // 立即退出会丢掉尚未 flush 的 tools/list、tools/call 响应。让事件循环自然排空。
    handle(req).then((out) => { if (out) write(out); })
      .catch((e) => write(err(req.id, -32603, e.message)));
  }
});
log(`bridge ready for ${PROJECT_ROOT}`);

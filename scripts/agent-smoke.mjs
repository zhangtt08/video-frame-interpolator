import { spawn } from 'node:child_process';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEST_PORT = 8991;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

console.log('--- Testing FrameBoost Agent API & MCP ---');

const server = spawn('node', ['agent/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, AGENT_PORT: String(TEST_PORT) },
  stdio: 'pipe'
});

server.stderr.on('data', (d) => process.stderr.write(d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        return await res.json();
      }
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Server did not become healthy in time');
}

try {
  const health = await waitForHealth();
  console.log('✓ GET /api/health returned healthy');
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.data.project, 'frameboost');
  assert.strictEqual(health.data.agent_api, 1);
  assert(health.data.tools >= 7);

  let token = '';
  if (health.data.guard?.token_file) {
    try {
      token = readFileSync(health.data.guard.token_file, 'utf8').trim();
    } catch {
      // ignore
    }
  }

  const postHeaders = {
    'content-type': 'application/json',
    ...(token ? { 'x-frameboost-token': token } : {})
  };

  // Tools
  const toolsRes = await fetch(`${BASE_URL}/api/agent/tools`);
  const toolsData = await toolsRes.json();
  console.log(`✓ GET /api/agent/tools returned ${toolsData.data.length} tools`);
  assert.strictEqual(toolsData.ok, true);
  const toolNames = toolsData.data.map((t) => t.name);
  assert(toolNames.includes('frameboost.capability_probe'));
  assert(toolNames.includes('frameboost.list_inputs'));
  assert(toolNames.includes('frameboost.probe_video'));
  assert(toolNames.includes('frameboost.render_start'));
  assert(toolNames.includes('frameboost.job_status'));

  // Test tool call: frameboost.capability_probe
  const callProbe = await fetch(`${BASE_URL}/api/agent/tool`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({ tool: 'frameboost.capability_probe', input: {} })
  });
  const probeRes = await callProbe.json();
  assert.strictEqual(probeRes.ok, true);
  console.log(`✓ frameboost.capability_probe ok: ffmpeg=${probeRes.data.ffmpeg?.available}, nvenc=${probeRes.data.nvenc?.tier}`);

  // Test confirm requirement for render_start with real sample video
  const sampleVideo = path.join(ROOT, 'sample-30fps.mp4');
  const callRender = await fetch(`${BASE_URL}/api/agent/tool`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({
      tool: 'frameboost.render_start',
      input: { inputPath: sampleVideo, multiplier: 2, confirm: false }
    })
  });
  const renderRes = await callRender.json();
  assert.strictEqual(renderRes.ok, true);
  assert.strictEqual(renderRes.data.executed, false);
  console.log('✓ frameboost.render_start without confirm returns plan dryRun without executing');

  // Test MCP JSON-RPC
  const mcp = spawn('node', [path.join(ROOT, 'agent', 'mcp-server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, AGENT_BASE_URL: BASE_URL },
    stdio: ['pipe', 'pipe', 'inherit']
  });

  const mcpPromise = new Promise((resolve, reject) => {
    let out = '';
    mcp.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('"jsonrpc":"2.0"') && out.includes('"tools"')) {
        resolve(out);
      }
    });
    mcp.on('error', reject);
  });

  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');

  const mcpOut = await mcpPromise;
  console.log('✓ MCP stdio bridge responded with initialize and tools/list');
  mcp.kill();

  console.log('=== ALL FRAMEBOOST AGENT API & MCP CHECKS PASSED ===');
} finally {
  server.kill('SIGTERM');
}

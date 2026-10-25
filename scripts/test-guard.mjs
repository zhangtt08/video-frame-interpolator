// 本地服务守卫 / 路径归属 / CSP / IPC 发送方校验的验收测试。
// node scripts/test-guard.mjs（需先 npm run build）
//
// 这一组盯的是"本机端口不是边界"这件事：只监听 127.0.0.1 挡不住任何网页的简单 POST，
// 也挡不住本机任意进程把 ffmpeg 指到任何可写卷。每条断言都打真 HTTP 请求、走真的判定函数。
import { createRequire } from 'node:module'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const G = require('../dist-electron/local-guard.js')
const RD = require('../dist-electron/render-defaults.js')
const AA = require('../dist-electron/agent-api.js')
const IPC = require('../dist-electron/ipc-auth.js')
const MAIN_SRC = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
const RENDERER_SRC = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

let failed = 0
let total = 0

function eq(actual, expected, name) {
  total++
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) console.log(`  ok - ${name}`)
  else {
    failed++
    console.error(`  FAIL - ${name}\n    expected: ${e}\n    actual:   ${a}`)
  }
}

function ok(cond, name, detail = '') {
  total++
  if (cond) console.log(`  ok - ${name}`)
  else {
    failed++
    console.error(`  FAIL - ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}

/** 一个能被 Host/Origin 欺骗的真端口：先抢一个空闲端口再让出去 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

/** 手写请求：要能塞进任意 Host / Origin / Referer，fetch 做不到这件事 */
function raw(opts) {
  return new Promise((resolve, reject) => {
    const body = opts.body == null ? null : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) }
    if (body != null) headers['content-length'] = Buffer.byteLength(body)
    const req = http.request({ host: '127.0.0.1', port: opts.port, method: opts.method || 'GET', path: opts.path, headers }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          /* 非 JSON 保留原文 */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'frameboost-guard-'))
const WS = path.join(TMP, 'workspace')
const OUTSIDE = path.join(TMP, 'outside')
fs.mkdirSync(path.join(WS, 'nested'), { recursive: true })
fs.mkdirSync(OUTSIDE, { recursive: true })
const INPUT = path.join(WS, 'in.mp4')
fs.writeFileSync(INPUT, 'not-a-video-but-exists')
const ESCAPE_LINK = path.join(WS, 'escape')
let symlinkUsable = true
try {
  fs.symlinkSync(OUTSIDE, ESCAPE_LINK, 'junction')
} catch {
  try {
    fs.symlinkSync(OUTSIDE, ESCAPE_LINK, 'dir')
  } catch {
    symlinkUsable = false
  }
}

// ---------------------------------------------------------------------------
// 1. 守卫判据（单元级）
// ---------------------------------------------------------------------------
console.log('== 1. 守卫判据：Host / Origin / Referer / 令牌 ==')
{
  eq(G.hostAllowed('127.0.0.1:8393', 8393), true, '127.0.0.1:<本端口> 放行')
  eq(G.hostAllowed('localhost:8393', 8393), true, 'localhost:<本端口> 放行')
  eq(G.hostAllowed('[::1]:8393', 8393), true, '[::1]:<本端口> 放行')
  eq(G.hostAllowed('evil.example.com:8393', 8393), false, '外域 Host 拒绝（DNS rebinding 的形状）')
  eq(G.hostAllowed('127.0.0.1:8394', 8393), false, '端口对不上也拒（不许串端口）')
  eq(G.hostAllowed('127.0.0.1', 8393), false, '不带端口的 Host 拒（默认端口不是本服务）')
  eq(G.hostAllowed('', 8393), false, '空 Host 拒')
  eq(G.hostAllowed('attacker.test', 8393), false, '无端口外域拒')

  eq(G.originAllowed(undefined, 8393), true, '没带 Origin（命令行/本机进程）放行')
  eq(G.originAllowed('http://127.0.0.1:5173', 8393), true, '本机回环 Origin 放行')
  eq(G.originAllowed('http://evil.example.com', 8393), false, '外域 Origin 拒')
  eq(G.originAllowed('null', 8393), false, 'Origin: null 拒')
  eq(G.originAllowed('file://', 8393), false, 'Origin: file:// 拒')
  eq(G.originAllowed('不是个URL', 8393), false, '畸形 Origin 拒')

  // 这条是本轮的重点：把 Origin 和"请求自己的 Host"比，rebinding 时两者天然相等 → 闸门形同没有
  const rebound = {
    headers: { host: 'attacker.test:8393', origin: 'http://attacker.test:8393' },
    method: 'POST'
  }
  const v = G.checkLocalGuard(rebound, { port: 8393, token: '' })
  eq([v.ok, v.code], [false, 'HOST_NOT_ALLOWED'], 'Host 与 Origin 一致的 rebinding 请求仍然被拒（没有自比自）')

  eq(G.tokenMatches('secret', 'secret'), true, '令牌相同 → 通过')
  eq(G.tokenMatches('wrong', 'secret'), false, '令牌不同 → 拒')
  eq(G.tokenMatches(undefined, 'secret'), false, '没带令牌 → 拒')
  eq(G.tokenMatches('secret', ''), false, '未配置令牌时任何值都不算通过（不出现"空令牌=放行"）')
}

// ---------------------------------------------------------------------------
// 2. 真 HTTP：应用内 REST(8393 形状) 的守卫与路径归属
// ---------------------------------------------------------------------------
console.log('== 2. 应用内 REST：伪造来源被拒、越界输出被拒、合法路径放行 ==')
const policy = RD.emptyPolicy()
RD.addToPolicy(policy, 'writableRoots', WS)
RD.addToPolicy(policy, 'openedFiles', INPUT)
const realStartRender = (rawBody) => {
  try {
    const p = RD.validateRenderRequest(rawBody, policy)
    return Promise.resolve({ ok: true, outputPath: p.outputPath, quality: p.quality })
  } catch (e) {
    return Promise.resolve({ ok: false, error: e.message, code: e.code })
  }
}

function makeServer(port, token) {
  return AA.createAgentApiServer({
    version: 'test',
    port,
    token,
    startRender: realStartRender,
    canProbeInput: (p) => RD.checkInputAllowed(p, policy).ok,
    getJobSummary: () => ({ running: false, stage: 'queued', percent: 0 }),
    probeVideo: (p) => Promise.resolve({ path: p, fileName: path.basename(p) }),
    detectNvenc: () => Promise.resolve('none'),
    lastRenderState: { done: false, ok: false, result: null, error: null }
  })
}

const port1 = await findFreePort()
const server1 = makeServer(port1, '')
const bind1 = await G.listenLocal(server1, port1, { host: '127.0.0.1' })
ok(bind1.ok, `无令牌实例已监听 127.0.0.1:${port1}`, bind1.error)

{
  const legit = await raw({ port: port1, path: '/health' })
  eq([legit.status, legit.json?.ok], [200, true], '本机正常请求 /health → 200')
  eq(legit.headers['access-control-allow-origin'], undefined, '响应里没有 Access-Control-Allow-Origin:*')

  const spoofed = await raw({ port: port1, path: '/health', headers: { host: `attacker.example.com:${port1}` } })
  eq([spoofed.status, spoofed.json?.error?.code], [403, 'HOST_NOT_ALLOWED'], '伪造 Host 的请求被拒（403 + JSON 错误）')
  eq(spoofed.headers['access-control-allow-origin'], undefined, '被拒的响应也不带 ACAO')

  const rebound = await raw({ port: port1, path: '/health', headers: { host: `attacker.test:${port1}`, origin: `http://attacker.test:${port1}` } })
  eq([rebound.status, rebound.json?.error?.code], [403, 'HOST_NOT_ALLOWED'], 'rebinding（Host 与 Origin 同步伪装）仍被拒')

  const evilPost = await raw({
    port: port1,
    method: 'POST',
    path: '/api/render',
    headers: { origin: 'http://evil.example.com' },
    body: { inputPath: INPUT, outputPath: path.join(WS, 'o.mp4'), targetFps: 60 }
  })
  eq([evilPost.status, evilPost.json?.error?.code], [403, 'ORIGIN_NOT_ALLOWED'], '跨源浏览器 POST 被拒（不是靠"没有 CORS 头"糊过去）')
  ok(!('access-control-allow-origin' in evilPost.headers), '状态变更路由上没有 CORS 放行头')

  const evilReferer = await raw({ port: port1, path: '/health', headers: { referer: 'http://evil.example.com/x' } })
  eq([evilReferer.status, evilReferer.json?.error?.code], [403, 'REFERER_NOT_ALLOWED'], 'Referer 来自外域也拒')

  // 输出路径越界：这是"任意本机进程把 ffmpeg 指到任何可写卷"的那条路
  const escapeOut = await raw({
    port: port1,
    method: 'POST',
    path: '/api/render',
    body: { inputPath: INPUT, outputPath: path.join(OUTSIDE, 'evil.mp4'), targetFps: 60 }
  })
  eq([escapeOut.status, escapeOut.json?.code], [400, 'OUT_OF_WORKSPACE'], '输出落在工作目录之外 → 拒')
  ok(!fs.existsSync(path.join(OUTSIDE, 'evil.mp4')), '被拒之后外面那个文件确实没被写出来')

  const notOpened = await raw({
    port: port1,
    method: 'POST',
    path: '/api/render',
    body: { inputPath: path.join(OUTSIDE, 'someone-else.mp4'), outputPath: path.join(WS, 'ok.mp4'), targetFps: 60 }
  })
  eq([notOpened.status, notOpened.json?.code], [400, 'INPUT_NOT_ALLOWED'], '输入不是用户打开过的 → 拒')

  const probeOutside = await raw({ port: port1, method: 'POST', path: '/api/probe', body: { inputPath: path.join(OUTSIDE, 'x.mp4') } })
  eq([probeOutside.status, probeOutside.json?.error?.code], [403, 'INPUT_NOT_ALLOWED'], '拿 /api/probe 试探工作目录外的文件也拒')

  const legitRender = await raw({
    port: port1,
    method: 'POST',
    path: '/api/render',
    body: { inputPath: INPUT, outputPath: path.join(WS, 'nested', 'out.mp4'), targetFps: 60 }
  })
  eq([legitRender.status, legitRender.json?.ok], [202, true], '用户打开过的输入 + 工作目录内的输出 → 放行')
  eq(path.basename(legitRender.json?.outputPath || ''), 'out.mp4', '放行的请求带着原本要写的路径')

  // 同一条判据的正向面：直接问 validateRenderRequest，路径合规就该通过
  const passed = RD.validateRenderRequest({ inputPath: INPUT, outputPath: path.join(WS, 'nested', 'out.mp4'), targetFps: 60 }, policy)
  eq([passed.outputPath.endsWith('out.mp4'), passed.quality, passed.mode], [true, 'standard', 'balanced'], '工作目录内的合法请求放行且用共享默认值')

  const probeOk = await raw({ port: port1, method: 'POST', path: '/api/probe', body: { inputPath: INPUT } })
  eq(probeOk.json?.ok, true, '用户打开过的文件允许探测')
}

// ---------------------------------------------------------------------------
// 3. 真 HTTP：配了令牌之后
// ---------------------------------------------------------------------------
console.log('== 3. 共享令牌：非 GET 必须带，带错也拒 ==')
const TOKEN = 'frameboost-test-token-8f21c'
const port2 = await findFreePort()
const server2 = makeServer(port2, TOKEN)
const bind2 = await G.listenLocal(server2, port2, { host: '127.0.0.1', token: TOKEN })
ok(bind2.ok, `带令牌实例已监听 127.0.0.1:${port2}`, bind2.error)
{
  const getStill = await raw({ port: port2, path: '/health' })
  eq(getStill.status, 200, 'GET 不要求令牌（只读健康检查仍然可达）')

  const noToken = await raw({ port: port2, method: 'POST', path: '/api/render', body: { inputPath: INPUT, outputPath: path.join(WS, 'a.mp4'), targetFps: 60 } })
  eq([noToken.status, noToken.json?.error?.code], [401, 'TOKEN_REQUIRED'], 'POST 不带令牌 → 401')

  const wrongToken = await raw({ port: port2, method: 'POST', path: '/api/render', headers: { 'x-frameboost-token': 'guess' }, body: {} })
  eq([wrongToken.status, wrongToken.json?.error?.code], [401, 'TOKEN_REQUIRED'], 'POST 带错令牌 → 401')

  const withHeader = await raw({
    port: port2,
    method: 'POST',
    path: '/api/render',
    headers: { 'x-frameboost-token': TOKEN },
    body: { inputPath: INPUT, outputPath: path.join(WS, 'b.mp4'), targetFps: 60 }
  })
  ok(withHeader.status !== 401, '带对令牌 → 过了令牌这一关（后续按业务判定）', `status=${withHeader.status}`)

  const withBearer = await raw({ port: port2, method: 'POST', path: '/api/probe', headers: { authorization: `Bearer ${TOKEN}` }, body: { inputPath: INPUT } })
  eq([withBearer.status, withBearer.json?.ok], [200, true], 'Authorization: Bearer 也接受')

  const halfToken = await raw({ port: port2, method: 'POST', path: '/api/probe', headers: { 'x-frameboost-token': TOKEN.slice(0, TOKEN.length - 1) }, body: { inputPath: INPUT } })
  eq(halfToken.status, 401, '只差一个字符的令牌也拒（比较是真的比过）')

  const opts = await raw({ port: port2, method: 'OPTIONS', path: '/api/render' })
  ok(!('access-control-allow-origin' in opts.headers), 'OPTIONS 预检不回 ACAO:*（跨源浏览器请求无从成立）')
}

// ---------------------------------------------------------------------------
// 4. 绑定失败要如实报
// ---------------------------------------------------------------------------
console.log('== 4. 端口占用 / 非回环绑定 ==')
{
  const occupiedPort = await findFreePort()
  const hog = net.createServer()
  await new Promise((r) => hog.listen(occupiedPort, '127.0.0.1', r))
  const dup = makeServer(occupiedPort, '')
  const outcome = await G.listenLocal(dup, occupiedPort, { host: '127.0.0.1' })
  eq(outcome.ok, false, '端口被占用时结果是"失败"，不是静默 no-op')
  ok(/占用/.test(outcome.error) && outcome.error.includes(String(occupiedPort)), '失败原因是中文且带端口号与出路', outcome.error)
  eq(outcome.url, '', '失败时不给出一个看起来能用的地址')
  hog.close()
  dup.close()

  const badHost = await G.listenLocal(makeServer(occupiedPort, ''), occupiedPort, { host: '0.0.0.0' })
  eq(badHost.ok, false, '绑到 0.0.0.0 直接拒绝执行（标准第 1 条）')
  ok(/只允许监听本机回环/.test(badHost.error), '越界绑定的理由是中文可读的', badHost.error)
}

// ---------------------------------------------------------------------------
// 5. 路径归属：符号链接逃逸 / 大小写 / ..
// ---------------------------------------------------------------------------
console.log('== 5. 容器判定：真实符号链接逃逸必须被拒 ==')
{
  eq(RD.resolveInsideRoot(path.join(WS, 'a.mp4'), WS).ok, true, '工作目录内的正常路径放行')
  eq(RD.resolveInsideRoot(path.join(WS, '..', 'evil.mp4'), WS).ok, false, '../ 绕出去 → 拒')
  eq(RD.resolveInsideRoot(path.join(OUTSIDE, 'evil.mp4'), WS).ok, false, '目录外的路径 → 拒')
  eq(RD.resolveInsideRoot(path.join(WS, 'nested', 'deep', 'x.mp4'), WS).ok, true, '尚未创建的深层子目录放行（父级在界内）')
  eq(RD.resolveInsideRoot('C:\\Windows\\Temp\\x.mp4', WS).ok, false, '指到系统目录 → 拒')
  const caseKey = RD.pathKey(path.join(WS, 'A.MP4'))
  const caseKey2 = RD.pathKey(path.join(WS.replace(/workspace$/, 'WORKSPACE'), 'a.mp4'))
  eq(caseKey === caseKey2, true, 'Windows 路径按大小写/分隔符归一后是同一个键')
  if (symlinkUsable) {
    const escaped = RD.resolveInsideRoot(path.join(ESCAPE_LINK, 'x.mp4'), WS)
    eq([escaped.ok, escaped.reason], [false, 'OUT_OF_WORKSPACE'], '词面在工作目录内、真实位置在界外的符号链接 → 拒（逃逸已实测）')
  } else {
    // 本机没有创建链接的权限时，用注入的 realpath 把同一条判据跑完：判据必须仍然成立
    const fake = { realpath: (p) => (p.replace(/\\/g, '/').toLowerCase().includes('/escape/') ? OUTSIDE : p), exists: () => true }
    const escaped = RD.resolveInsideRoot(path.join(ESCAPE_LINK, 'x.mp4'), WS, fake)
    eq([escaped.ok, escaped.reason], [false, 'OUT_OF_WORKSPACE'], '（注入 realpath 的替身）符号链接逃逸 → 拒')
  }
  const realDep = RD.resolveInsideRoot(path.join(WS, 'a.mp4'), WS, { realpath: (p) => p, exists: () => true })
  eq(realDep.ok, true, '依赖注入后同一判据仍然成立')
}

// ---------------------------------------------------------------------------
// 6. IPC 发送方校验
// ---------------------------------------------------------------------------
console.log('== 6. IPC：只认自己那个窗口的调用 ==')
{
  const prefixes = IPC.allowedUrlPrefixesFor({ appDir: 'C:\\app\\dist-renderer', devUrl: 'http://localhost:5173/' })
  const pol = { trustedIds: [7], allowedUrlPrefixes: prefixes }
  eq(IPC.checkIpcSender({ sender: { id: 7 }, senderFrame: { url: 'file:///C:/app/dist-renderer/index.html' } }, pol).ok, true, '自家窗口的 file:// 页面放行')
  eq(IPC.checkIpcSender({ sender: { id: 7 }, senderFrame: { url: 'http://localhost:5173/index.html' } }, pol).ok, true, 'dev 地址放行')
  eq(IPC.checkIpcSender({ sender: { id: 99 }, senderFrame: { url: 'file:///C:/app/dist-renderer/index.html' } }, pol).ok, false, '别的 webContents（如打开的新窗口）→ 拒')
  const foreign = IPC.checkIpcSender({ sender: { id: 7 }, senderFrame: { url: 'http://evil.example.com/x.html' } }, pol)
  eq([foreign.ok, foreign.code], [false, 'FRAME_NOT_ALLOWED'], '外域 frame → 拒')
  eq(IPC.checkIpcSender({ sender: { id: 7 }, senderFrame: { url: 'file:///C:/Users/other/evil.html' } }, pol).ok, false, 'file:// 全盘也收紧到应用目录之内')
  eq(IPC.checkIpcSender(undefined, pol).ok, false, '没有事件对象 → 拒')
  eq(IPC.checkIpcSender({ sender: { id: 7 } }, pol).code, 'NO_FRAME_URL', '取不到 frame URL 时按拒处理（不"猜它是我们"）')
  eq(IPC.checkIpcSender({ sender: { id: 7 }, mainFrameUrlHint: 1 }, { trustedIds: [], allowedUrlPrefixes: prefixes }).code, 'UNTRUSTED_SENDER', '窗口还没建好时谁都不放行（不出现空名单=全放）')

  // 静态：主进程里不许有没过校验的 ipcMain.handle
  const bare = (MAIN_SRC.match(/ipcMain\.handle\(/g) || []).length
  eq(bare, 1, '主进程里只有一处 ipcMain.handle（就是那层守卫本身）')
  ok(/function registerHandler\([\s\S]*?ipcMain\.handle\(channel,[\s\S]*?checkIpcSender\(event/.test(MAIN_SRC), '唯一的 handle 调用点先过 checkIpcSender 再进 handler')
  const wrapped = (MAIN_SRC.match(/registerHandler\('/g) || []).length
  ok(wrapped >= 15, `所有 IPC 通道都走 registerHandler（实测 ${wrapped} 个通道）`)
  ok(!/ipcMain\.handle\('/.test(MAIN_SRC), '没有任何按通道名裸登记的 handler')
}

// ---------------------------------------------------------------------------
// 7. CSP：交付的那份 HTML 必须带，且判据是量出来的
// ---------------------------------------------------------------------------
console.log('== 7. CSP：构建产物里的策略与被实测的渲染层一致 ==')
{
  const htmlPath = new URL('../dist-renderer/index.html', import.meta.url)
  ok(fs.existsSync(htmlPath), 'dist-renderer/index.html 存在（npm run build 的产物）')
  const html = fs.readFileSync(htmlPath, 'utf8')
  // content 里本身带单引号（'self'），所以不能按"遇到引号就停"来截：
  // 先按同一种引号配对取出整段值，再把 &#39; 这类实体还原成字符，才是浏览器真正看到的那条策略。
  const tag = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i.exec(html)
  const raw = tag ? /content=(["'])([\s\S]*?)\1/i.exec(tag[0]) : null
  const m = raw ? [raw[0], raw[2]] : null
  ok(!!m, '交付的 HTML 里有 CSP meta')
  const csp = m ? m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&') : ''
  const directives = Object.fromEntries(csp.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [k, ...v] = s.split(/\s+/)
    return [k, v.join(' ')]
  }))
  eq(directives['default-src'], "'self'", 'default-src 是 self')
  eq(directives['script-src'], "'self'", 'script-src 只有 self，不含任何 unsafe-*')
  ok(!/unsafe-(inline|eval)/.test(directives['script-src'] || ''), '生产页面不放行内联脚本')
  eq(directives['object-src'], "'none'", 'object-src none')
  eq(directives['base-uri'], "'self'", 'base-uri self')
  eq(directives['form-action'], "'none'", 'form-action none')
  ok(directives['connect-src'] === "'self'", 'connect-src 只有 self（渲染层不发网络请求，实测无 fetch/XHR）')
  ok(!/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/i.test(html), '构建产物里没有内联脚本（所以 script-src self 足够）')

  // style-src 要不要 'unsafe-inline' 不是猜的：数一遍源码里的内联 style 属性
  const inlineStyles = (RENDERER_SRC.match(/style=\{\{/g) || []).length
  if (inlineStyles > 0) {
    ok(/'unsafe-inline'/.test(directives['style-src'] || ''), `style-src 放开 unsafe-inline（实测渲染层有 ${inlineStyles} 处内联 style 属性）`, directives['style-src'])
  } else {
    ok(!/unsafe-inline/.test(directives['style-src'] || ''), `渲染层没有内联 style（实测 ${inlineStyles} 处），style-src 就不该放开`)
  }
  ok(/blob:/.test(directives['media-src'] || ''), 'media-src 允许 blob:（预览用的是 createObjectURL，实测）')
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${total - failed}/${total} passed`)
process.exit(failed ? 1 : 0)

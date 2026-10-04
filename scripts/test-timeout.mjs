// 运行时闸门测试：探测超时、输出上限、进程总时限、队列等终态的时限。
// node scripts/test-timeout.mjs（需先 npm run build:electron）
//
// 这一组用例的意义在于"永不退出"这四个字：每一个用例都真起一个不会自己退出的子进程，
// 断言软件把它收掉了。修复之前这些用例全部会挂死并被外层看门狗判失败（见 README 的复现说明）。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const P = require('../dist-electron/pipeline.js')
const F = require('../dist-electron/ffmpeg.js')

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

/** 外层看门狗：被测代码卡住时，测试本身必须给出"卡住了"的结论而不是跟着一起挂死 */
function withWatchdog(p, ms, name) {
  let timer = null
  return Promise.race([
    p.then(
      (v) => {
        if (timer) clearTimeout(timer)
        return { status: 'resolved', value: v }
      },
      (e) => {
        if (timer) clearTimeout(timer)
        return { status: 'rejected', value: e }
      }
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 'hang', value: null }), ms)
    })
  ])
}

/** 一个永不退出的子进程（可选先把 stdout 灌爆） */
function hangSpawner(flood) {
  return (_bin, _args, opts) => {
    const script = flood
      ? 'const s="x".repeat(65536); setInterval(()=>{try{process.stdout.write(s)}catch(e){}},1);'
      : 'setTimeout(()=>{},1e8);'
    return spawn(process.execPath, ['-e', script], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
  }
}

const FAKE_FILE = process.execPath // 任何一个真实存在的文件：探测走的是注入的假二进制

console.log('== 1. 探测超时：ffprobe 永不退出时必须在时限内收口 ==')
{
  process.env.FRAMEBOOST_PROBE_TIMEOUT_MS = '600'
  const r = await withWatchdog(F.probeVideo(FAKE_FILE, { spawnFn: hangSpawner(false) }), 8000, 'probeVideo(永不退出的 ffprobe)')
  ok(r.status === 'rejected', '永不退出的 ffprobe 被判超时（不是等下去）', `实际状态=${r.status}`)
  const err = r.value
  ok(err && err.code === 'PROBE_TIMEOUT', '超时错误带 code=PROBE_TIMEOUT', `code=${err && err.code}`)
  ok(!!err && /超时/.test(err.message) && /强制结束/.test(err.message), '超时消息是中文并且说清了已强制结束', err && err.message)
}

console.log('== 2. 探测时限可配置：环境变量改了就真的生效 ==')
{
  process.env.FRAMEBOOST_PROBE_TIMEOUT_MS = '300'
  const t0 = Date.now()
  const fast = await withWatchdog(F.probeVideo(FAKE_FILE, { spawnFn: hangSpawner(false) }), 8000, 'FRAMEBOOST_PROBE_TIMEOUT_MS=300')
  const fastMs = Date.now() - t0
  ok(fast.status === 'rejected' && fastMs < 3000, `300ms 配置真的生效（实测 ${fastMs}ms）`, `status=${fast.status}`)
  process.env.FRAMEBOOST_PROBE_TIMEOUT_MS = '1200'
  const t1 = Date.now()
  await F.probeVideo(FAKE_FILE, { spawnFn: hangSpawner(false) }).catch(() => undefined)
  const slowMs = Date.now() - t1
  ok(slowMs >= 1000, `改成 1200ms 后等待时间跟着变长（实测 ${slowMs}ms）`, '配置没有接进调用')
  // 非法值不许把闸门关掉（0 = 显式不设限才是关闭闸门唯一的写法）
  process.env.FRAMEBOOST_PROBE_TIMEOUT_MS = 'abc'
  eq(P.readTimeoutMs('abc', 45000), 45000, '非法环境变量回落默认而不是 0')
  eq(P.readTimeoutMs('0', 45000), 0, '显式写 0 才是"不设限"')
  eq(P.readTimeoutMs(undefined, 45000), 45000, '没给就用默认')
  delete process.env.FRAMEBOOST_PROBE_TIMEOUT_MS
  ok(F.probeTimeoutMs() === P.DEFAULT_PROBE_TIMEOUT_MS, '默认探测时限来自共享常量', String(F.probeTimeoutMs()))
  ok(P.DEFAULT_PROBE_TIMEOUT_MS > 0, '默认探测时限是有限值（修复前这里是 0=永不超时）', String(P.DEFAULT_PROBE_TIMEOUT_MS))
  ok(P.DEFAULT_RUN_TIMEOUT_MS > 0, 'runBin 默认时限也是有限值', String(P.DEFAULT_RUN_TIMEOUT_MS))
}

console.log('== 3. 输出上限：超了就截断并如实报告，不把半截 JSON 当完整结果 ==')
{
  const cap = 64 * 1024
  const r = await withWatchdog(
    F.runBin('fake', [], 20000, { maxOutputBytes: cap, spawnFn: hangSpawner(true) }),
    15000,
    'runBin(灌爆 stdout 的假进程)'
  )
  ok(r.status === 'resolved', '输出超限后 runBin 自己收口了（不靠超时兜底）', `status=${r.status}`)
  const res = r.value
  ok(res && res.truncated === true, '结果里带 truncated:true（截断是显式事实，不是静默丢弃）', JSON.stringify({ truncated: res && res.truncated }))
  ok(res && res.truncatedBytes > cap, `truncatedBytes 报出真实字节数（>${cap}）`, res && String(res.truncatedBytes))
  ok(res && Buffer.byteLength(res.stdout) <= cap * 2, '交回的文本不超过上限的两倍（内存有界）', res && String(Buffer.byteLength(res.stdout)))

  const p = await withWatchdog(F.probeVideo(FAKE_FILE, { spawnFn: hangSpawner(true), maxOutputBytes: cap, timeoutMs: 20000 }), 15000, 'probeVideo(输出超限)')
  ok(p.status === 'rejected', '探测输出超限 → 直接失败，不解析半截 JSON', `status=${p.status}`)
  const e2 = p.value
  ok(e2 && e2.code === 'PROBE_OUTPUT_TOO_LARGE', '超限错误带 code=PROBE_OUTPUT_TOO_LARGE', e2 && e2.code)
  ok(!!e2 && /截断/.test(e2.message) && /\d+ 字节/.test(e2.message), '超限消息把截断事实说清楚', e2 && e2.message)

  const f = P.classifyFailure({ code: 'PROBE_OUTPUT_TOO_LARGE', message: e2 ? e2.message : '' })
  ok(!!f && Array.isArray(f.steps) && f.steps.length >= 2 && /FRAMEBOOST_PROBE_MAX_OUTPUT_MB/.test(f.steps.join(' ')), '归因给出可执行下一步（含放宽上限的出口）', f && f.steps.join(' / '))
}

console.log('== 4. 进程总时限：真起一个永不退出的子进程，闸门必须把它杀掉 ==')
{
  const script = 'setTimeout(()=>{},1e8);'
  const proc = spawn(process.execPath, ['-e', script], { windowsHide: true })
  let killedByDeadline = false
  let expired = false
  let closeCode = null
  const dl = P.attachProcessDeadline(proc, 400, () => {
    expired = true
  })
  proc.on('close', (code) => {
    closeCode = code
    killedByDeadline = expired
  })
  const done = await withWatchdog(
    new Promise((resolve) => {
      proc.on('close', () => resolve(true))
    }),
    10000,
    'attachProcessDeadline(永不退出的进程)'
  )
  ok(done.status === 'resolved', '进程在时限到后被收掉，close 真的来了', `status=${done.status}`)
  ok(expired === true, 'onExpired 被调用（渲染作业据此落终态）')
  ok(dl.fired === true, 'deadline.fired 标记为 true')
  ok(killedByDeadline && closeCode !== 0, `子进程被强杀（exit=${closeCode}，非正常退出）`)
  dl.cancel()

  // 正常退出的进程不该被误杀：时限内 settle → timer 取消
  const quick = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true })
  const dl2 = P.attachProcessDeadline(quick, 60000, () => {
    throw new Error('不该触发')
  })
  const quickDone = await withWatchdog(new Promise((r) => quick.on('close', () => r(true))), 8000, '正常退出的进程')
  ok(quickDone.status === 'resolved' && dl2.fired === false, '正常退出的进程不会被闸门判死')
  dl2.cancel()
  eq(P.attachProcessDeadline(null, 0, () => undefined).fired, false, 'ms<=0 或没有进程时闸门不启用')
}

console.log('== 5. 队列等终态：终态永不到来时队列必须继续 ==')
{
  const never = new Promise(() => undefined)
  const r = await withWatchdog(P.withDeadline(never, 400, 'RENDER_TIMEOUT', P.stalledReasonText(240000)), 8000, 'withDeadline(永不 settle)')
  ok(r.status === 'rejected', '永不 settle 的终态 Promise 被判超时（修复前队列就在这里等死）', `status=${r.status}`)
  const e = r.value
  ok(!!e && e.code === 'RENDER_TIMEOUT', '队列侧错误码是 RENDER_TIMEOUT', e && e.code)
  ok(!!e && /没有回报终态/.test(e.message) && /队列继续/.test(e.message), '消息是中文且说明队列会继续', e && e.message)

  // settle 了就必须原样交出结果，并且不许留下悬挂 timer
  const settled = await P.withDeadline(Promise.resolve('done'), 5000, 'X', 'y')
  eq(settled, 'done', '按时回来的终态原样交出')
  const rejected = await P.withDeadline(Promise.reject(new Error('真失败')), 5000, 'X', 'y').catch((e) => e)
  ok(rejected instanceof Error && rejected.message === '真失败', '原失败不被超时掩盖')
  eq(await P.withDeadline(Promise.resolve(1), 0, 'X', 'y'), 1, 'ms=0 时不设限（直接透传）')

  eq(P.terminalDeadlineMs(60000), 60000 + P.TERMINAL_GRACE_MS, '队列时限 = 任务时限 + 宽限')
  eq(P.terminalDeadlineMs(0), 0, '任务时限显式关闭时队列也不设限')

  const f = P.classifyFailure({ code: 'RENDER_TIMEOUT', message: P.stalledReasonText(P.DEFAULT_JOB_TIMEOUT_MS) })
  ok(!!f && /卡住/.test(f.title), '卡住有一条独立的中文结论', f && f.title)
  ok(!!f && f.steps.length >= 3 && f.steps.some((s) => /FRAMEBOOST_JOB_TIMEOUT_MS/.test(s)) && f.steps.some((s) => /重试/.test(s)), '卡住的下一步可执行（放宽时限 / 单独重试）', f && f.steps.join(' / '))
}

console.log(`\n${total - failed}/${total} passed`)
process.exit(failed ? 1 : 0)

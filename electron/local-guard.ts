// 本机服务守卫 —— 所有只监听 127.0.0.1 的 HTTP 面（应用内 REST 8393 / 独立 Agent API 8791）
// 都过这一份实现。判据来自 personal-agent-hub/docs/AGENT_API_STANDARD.md 的「本地服务守卫标准」：
//   1) 只绑 127.0.0.1；
//   2) Host 必须是 127.0.0.1:<port> / localhost:<port> / [::1]:<port>，否则拒；
//   3) Origin / Referer 只要出现就必须是同一个本机来源，不匹配回 JSON 错误；
//      ⚠ 绝不拿 Origin 去和"请求自己的 Host"比 —— 那正是 DNS rebinding 的洞（页面把域名
//      解析到 127.0.0.1 后两者自然相等，闸门形同没有）；
//   4) 配置了共享令牌时，非 GET 请求必须带令牌（定长时间比较）；
//   5) 状态变更路由永不发 Access-Control-Allow-Origin: *。
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

export interface GuardOptions {
  /** 本服务实际监听的端口，Host 白名单按它算 */
  port: number
  /** 共享令牌；未配置（空串/undefined）时不强制，但 2) 3) 5) 照旧生效 */
  token?: string | null
  /** 自定义令牌请求头名，默认 x-frameboost-token */
  tokenHeader?: string
}

export interface GuardVerdict {
  ok: boolean
  status?: number
  code?: string
  error?: string
}

/** 本机回环主机名（不含端口） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export function localApiToken(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.FRAMEBOOST_API_TOKEN ?? '').trim()
}

/** 拆开 "host:port"（IPv6 形如 [::1]:8393），返回 {host, port|null} */
export function splitHostPort(value: string): { host: string; port: number | null } {
  const s = String(value ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (s.startsWith('[')) {
    const end = s.indexOf(']')
    if (end < 0) return { host: s, port: null }
    const host = s.slice(0, end + 1)
    const rest = s.slice(end + 1)
    const m = /^:(\d+)$/.exec(rest)
    return { host, port: m ? Number(m[1]) : null }
  }
  const idx = s.lastIndexOf(':')
  if (idx < 0) return { host: s, port: null }
  const maybePort = Number(s.slice(idx + 1))
  if (!Number.isFinite(maybePort)) return { host: s, port: null }
  return { host: s.slice(0, idx), port: maybePort }
}

/** Host 判据：主机名在本机白名单里，并且端口就是本服务的端口 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false
  const { host: h, port: p } = splitHostPort(host)
  if (p !== port) return false
  const normalized = h.startsWith('[') ? h : h.replace(/^\[|\]$/g, '')
  const withBrackets = normalized.startsWith('[') ? normalized : normalized === '::1' ? '[::1]' : normalized
  return LOOPBACK_HOSTS.has(normalized.toLowerCase()) || LOOPBACK_HOSTS.has(withBrackets.toLowerCase())
}

/**
 * Origin/Referer 判据：没带 = 放行（命令行工具、node fetch 都不带）；
 * 带了就必须落在本机回环上。注意比较对象是**固定的本机白名单**，
 * 不是 req.headers.host —— 后者正是 DNS rebinding 会伪造的那一半。
 */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined || origin === null || String(origin).trim() === '') return true
  const s = String(origin).trim()
  if (s === 'null' || s === 'file://') return false
  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const h = parsed.hostname.toLowerCase()
  if (!LOOPBACK_HOSTS.has(h)) return false
  const explicit = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  // 本机任意端口都算同源（dev 渲染层在 5173），但端口必须是数字且合法
  return Number.isFinite(explicit) && explicit > 0
}

/** 定长时间比较：先把两侧都哈希成固定 32 字节，长度本身也不泄露 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!expected) return false
  const a = createHash('sha256').update(String(provided ?? ''), 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

function bearer(header: string | undefined): string {
  const s = String(header ?? '')
  const m = /^Bearer\s+(.+)$/i.exec(s.trim())
  return m ? m[1].trim() : ''
}

/**
 * 唯一的守卫入口。返回 {ok:false} 时调用方**必须**先把它回出去再 return，
 * 不许"记个日志继续跑"。
 */
export function checkLocalGuard(req: IncomingMessage, opts: GuardOptions): GuardVerdict {
  const port = opts.port
  if (!hostAllowed(req.headers.host, port)) {
    return {
      ok: false,
      status: 403,
      code: 'HOST_NOT_ALLOWED',
      error: `Host 头不被允许：本机服务只接受 127.0.0.1:${port} / localhost:${port} / [::1]:${port}（挡 DNS rebinding）。请把请求指到这些地址`
    }
  }
  const origin = req.headers.origin
  const referer = req.headers.referer ?? req.headers.referrer
  if (!originAllowed(typeof origin === 'string' ? origin : undefined, port)) {
    return {
      ok: false,
      status: 403,
      code: 'ORIGIN_NOT_ALLOWED',
      error: `Origin 不是本机来源：${String(origin)}。本接口只服务本机回环请求，不从网页里直接调用`
    }
  }
  if (referer && typeof referer === 'string' && !originAllowed(referer, port)) {
    return {
      ok: false,
      status: 403,
      code: 'REFERER_NOT_ALLOWED',
      error: `Referer 不是本机来源：${referer.slice(0, 120)}`
    }
  }
  const token = String(opts.token ?? '').trim()
  if (token && req.method && req.method.toUpperCase() !== 'GET' && req.method.toUpperCase() !== 'HEAD') {
    const headerName = (opts.tokenHeader ?? 'x-frameboost-token').toLowerCase()
    let provided = ''
    const direct = req.headers[headerName]
    if (typeof direct === 'string') provided = direct.trim()
    else if (Array.isArray(direct)) provided = String(direct[0] ?? '').trim()
    if (!provided) {
      // 没带专用头就退一步看 Authorization: Bearer —— 两条通道交出来的是同一个东西
      const auth = req.headers.authorization
      provided = bearer(Array.isArray(auth) ? auth[0] : auth)
    }
    if (!tokenMatches(provided, token)) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_REQUIRED',
        error: `缺少或错误的本机令牌：请带请求头 ${headerName}: <FRAMEBOOST_API_TOKEN>`
      }
    }
  }
  return { ok: true }
}

/**
 * 把拒绝理由回成 JSON。刻意不带任何 Access-Control-Allow-* 头：
 * 状态变更路由上发 ACAO:* 等于告诉浏览器"任意站点都可以来 POST 我"。
 */
export function replyGuardDenied(res: ServerResponse, verdict: GuardVerdict): void {
  const body = JSON.stringify({ ok: false, error: { code: verdict.code ?? 'FORBIDDEN', message: verdict.error ?? '请求被本机守卫拒绝' } })
  res.writeHead(verdict.status ?? 403, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(body)
}

/** 统一的本机响应头：永不出现 ACAO:* */
export function localHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: IncomingHttpHeaders & Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }
  for (const k of Object.keys(h)) {
    if (/^access-control-allow-origin$/i.test(k) && String(h[k]).trim() === '*') delete h[k]
  }
  return h
}

// ---------------------------------------------------------------------------
// 绑定：只准绑 127.0.0.1，绑不上要如实报，绝不再写 on('error', () => {})
// ---------------------------------------------------------------------------

export interface BindOutcome {
  ok: boolean
  port: number
  url: string
  error: string
  tokenRequired: boolean
}

/** 把 listen 失败翻译成一句能照着做的话（调用方原样显示，不许吞） */
export function describeBindError(err: { code?: string; message?: string } | unknown, port: number): string {
  const e = err as { code?: string; message?: string }
  const code = String(e?.code ?? '')
  if (code === 'EADDRINUSE') {
    return `端口 ${port} 已被别的程序占用，接口没有起来。用环境变量 FRAMEBOOST_API_PORT 换一个端口，或先关掉占用 ${port} 的程序（netstat -ano | findstr :${port} 可以看是谁）`
  }
  if (code === 'EACCES') {
    return `端口 ${port} 在本机被系统占用或需要管理员权限，接口没有起来。换一个 1024 以上的端口（FRAMEBOOST_API_PORT）`
  }
  return `接口未能监听 127.0.0.1:${port}：${e?.message ?? String(err)}`
}

/**
 * 绑定并交出真实结果：成功给地址，失败给中文原因。
 * 这条函数存在的意义就是"失败必须有返回值"，而不是像以前一样被空 catch 吃掉。
 */
export function listenLocal(
  server: { once(event: string, listener: (...args: any[]) => void): unknown; listen(port: number, host: string, cb: () => void): unknown; address(): unknown },
  port: number,
  opts: { host?: string; token?: string } = {}
): Promise<BindOutcome> {
  const host = opts.host ?? '127.0.0.1'
  const tokenRequired = !!String(opts.token ?? '').trim()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    // 标准第 1 条：禁止绑到 0.0.0.0。这不是"提醒一下"，是直接拒绝执行。
    return Promise.resolve({
      ok: false,
      port,
      url: '',
      error: `只允许监听本机回环（127.0.0.1），拒绝绑定到 ${host}`,
      tokenRequired
    })
  }
  return new Promise<BindOutcome>((resolve) => {
    let settled = false
    const done = (r: BindOutcome) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    server.once('error', (err: unknown) => done({ ok: false, port, url: '', error: describeBindError(err, port), tokenRequired }))
    server.listen(port, host, () => {
      const addr = server.address() as { port?: number } | string | null
      const realPort = typeof addr === 'object' && addr && typeof addr.port === 'number' ? addr.port : port
      done({ ok: true, port: realPort, url: `http://${host}:${realPort}`, error: '', tokenRequired })
    })
  })
}

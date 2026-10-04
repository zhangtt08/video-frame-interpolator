// FrameBoost Agent API — 本地 HTTP 服务，供外部 agent 以 tool 形式调用。
// 随桌面应用启动（main.ts 在 app ready 时接线），复用应用内的 probe/render 流程。
// 渲染是异步任务：POST /api/render 启动，GET /api/job 轮询进度与结果。
// 端口：环境变量 FRAMEBOOST_API_PORT，默认 8393。仅监听 127.0.0.1。
// 守卫：electron/local-guard.ts 那份标准实现（Host / Origin / 令牌），这里不另写一套。
import http from 'node:http'
import { checkLocalGuard, localHeaders, replyGuardDenied } from './local-guard'
import type { NvencLevel, RenderStage } from './pipeline'

export interface RenderStateSnapshot {
  done: boolean
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
}

/** 作业摘要：所有数字都取自主进程里那份真实 Job 状态（ffmpeg -progress 解析出来的） */
export interface JobSummary {
  running: boolean
  stage?: RenderStage
  percent?: number
  outputPath?: string
  inputPath?: string
  targetFps?: number
  encoder?: string
  frame?: number
  totalFrames?: number
  fps?: number
  speed?: number | null
  outTimeSec?: number
  etaSec?: number | null
  elapsedSec?: number
}

export interface AgentApiDeps {
  version: string
  startRender: (raw: unknown) => Promise<{ ok: boolean; [k: string]: unknown }>
  getJobSummary: () => JobSummary
  probeVideo: (inputPath: string) => Promise<unknown>
  detectNvenc: () => Promise<NvencLevel>
  lastRenderState: RenderStateSnapshot
  /** 实际监听端口：Host 白名单按它算，端口被占用后要如实报出来 */
  port?: number
  /** 共享令牌（FRAMEBOOST_API_TOKEN）；配置了才要求非 GET 带令牌 */
  token?: string | null
  /** 这份输入路径用户开没打开过 / 在不在授权目录内；不给就是"全部不许探测" */
  canProbeInput?: (inputPath: string) => boolean
}

export const DEFAULT_API_PORT = 8393

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  // 状态变更路由上永不发 Access-Control-Allow-Origin: *
  res.writeHead(status, localHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body))
  }))
  res.end(body)
}

function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function createAgentApiServer(deps: AgentApiDeps): http.Server {
  const port = deps.port ?? DEFAULT_API_PORT

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 守卫在最前：不合法的 Host/Origin/令牌在任何一次真实工作发生之前就被拒掉。
    const verdict = checkLocalGuard(req, { port, token: deps.token ?? null })
    if (!verdict.ok) {
      replyGuardDenied(res, verdict)
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = `${req.method} ${url.pathname}`

    if (route === 'GET /health') {
      send(res, 200, {
        ok: true,
        tool: 'frameboost',
        version: deps.version,
        guard: { host: '127.0.0.1|localhost|[::1]', tokenRequired: !!String(deps.token ?? '').trim() },
        hint: 'POST /api/render {inputPath, outputPath, targetFps, mode, quality?, useNvenc?, container?}；GET /api/job 轮询'
      })
      return
    }
    if (req.method === 'OPTIONS') {
      // 预检只在同源本机请求上接受；不带 ACAO:*，跨源浏览器请求本来就过不了上面的守卫
      send(res, 204, { ok: false, error: { code: 'NO_CORS', message: '本机服务不做跨源放行；请从本机回环地址直接调用' } })
      return
    }
    if (route === 'GET /api/nvenc') {
      send(res, 200, { ok: true, data: { nvenc: await deps.detectNvenc() } })
      return
    }
    if (route === 'POST /api/probe') {
      const body = await readBody(req)
      const inputPath = String(body.inputPath ?? '')
      // 探测也算读文件：只允许用户打开过的/在授权目录内的路径，否则任意本地进程可以拿 ffprobe 逐个试探磁盘上有什么
      if (deps.canProbeInput && !deps.canProbeInput(inputPath)) {
        send(res, 403, { ok: false, error: { code: 'INPUT_NOT_ALLOWED', message: '这份输入不是用户在界面里打开过的文件，也不在允许的读取目录内' } })
        return
      }
      try {
        send(res, 200, { ok: true, data: await deps.probeVideo(inputPath) })
      } catch (err) {
        send(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    if (route === 'POST /api/render') {
      let body: Record<string, unknown>
      try {
        body = await readBody(req)
      } catch (e) {
        send(res, 400, { ok: false, error: e instanceof Error ? e.message : '请求体无效' })
        return
      }
      const result = await deps.startRender(body)
      send(res, result.ok ? 202 : (String(result.error).includes('已有任务') ? 409 : 400), result)
      return
    }
    if (route === 'GET /api/job') {
      send(res, 200, { ok: true, data: { job: deps.getJobSummary(), last: deps.lastRenderState } })
      return
    }
    send(res, 404, { ok: false, error: `未知路由 ${route}，可用：GET /health、GET /api/nvenc、POST /api/probe、POST /api/render、GET /api/job` })
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) =>
      send(res, 500, { ok: false, error: err instanceof Error ? err.message : '内部错误' })
    )
  })
}

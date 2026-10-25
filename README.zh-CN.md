# FrameBoost · 视频补帧工具

**English**（[README.md](./README.md)）| 简体中文

一款 Windows 本地视频补帧（插帧）桌面应用：把低帧率视频提升到更高帧率（如 30fps → 60fps），让画面运动更顺滑。基于 Electron + FFmpeg，**全程本地处理，不上传任何数据**。面向"画质尽量无损"的场景做了专项工程化：精确帧数、色彩元数据透传、10bit 保持、多级失败回退。

**下载**：前往 [Releases](https://github.com/zhangtt08/frameboost/releases) 下载 `FrameBoost.exe`（Windows x64 便携版，免安装，内置 ffmpeg，约 135MB）。

![界面](docs/screenshot.png)

> 空态与运行中的样子见 `docs/screenshot-home.png`、`docs/screenshot-running.png`。

## 功能

### 补帧方式（三档）
| 方式 | 原理 | 适用 |
|---|---|---|
| 光流补偿 · 精细 | minterpolate AOBMC 自适应分块 + 双向运动估计 + 变分加权 | 画质优先，接受慢速 |
| 光流补偿 · 均衡 | minterpolate OBMC 运动补偿 | 大多数视频（推荐） |
| 帧混合 | 相邻帧加权融合（framerate 滤镜） | 速度优先；快速运动场景略有拖影 |

### 画质工程（企业级要点）
- **画质三档**：母版级（x264 CRF 10，视觉无损，用于再剪辑/存档）／高画质（CRF 16，推荐）／标准（CRF 20）
- **精确帧数**：滤镜链采用 `tpad 克隆补帧 → 插帧 → trim 回原时长`，修复了普通 `minterpolate` 链路尾部丢帧的问题（3s@30→60 实测输出恰好 180 帧），保证音画对齐
- **10bit 保持**：源为 10bit 时输出 10bit（内置编码器能力自动探测，不支持时降级 8bit 并提示）
- **色彩元数据透传**：bt709 / bt2020 / PQ 等 primaries/TRC/colorspace 原样写入输出，HDR 片源不发灰
- **音轨无损直写**：默认 `-c:a copy`；编解码器与容器不兼容（如 Opus→MP4）自动回退 AAC 重编码
- **NVENC 硬件加速**：自动检测（新旧两代驱动预设均支持），不可用或运行失败自动多级回退 CPU；10bit 输出自动跳过 NVENC
- **帧率解析防呆**：`r_frame_rate` 按 timebase 误报（如 90000/1）时回退 `avg_frame_rate`
- **封面图容错**：自动排除 MP4 内嵌封面图流，始终选主视频流插帧
- **输出防覆盖**：目标文件已存在时自动加 ` (1)` 后缀

### 使用体验
- **多文件队列**：拖拽/多选批量加入，逐个自动处理；每项独立状态徽标（等待/处理中/完成/失败/取消）
- **队列拖拽排序**：按住行首的把手把任意一条拖到目标位置（正在跑的那条不参与拖动）
- **失败重试**：队列结束后可一键重试失败项，并可直接「打开输出目录」；取消即全队停止
- **实时进度**：底栏常驻显示百分比、当前阶段、帧率、倍速与剩余时间，可展开看帧数/编码器等细节，随时暂停或取消
- **完成通知**：窗口不在前台时，跑完/失败会弹系统通知，点通知直接定位到产物
- **产物体积预估**：参数台按分辨率/时长/目标帧率/画质档实时估算产物大小，与磁盘预检用的是同一个算法
- **窗口记忆**：上次的窗口位置与大小会被记住（副屏拔掉时自动回落到主屏，不会跑到看不见的地方）
- **快捷键**：`Ctrl+O` 添加素材、`Enter` 开始、`Esc` 暂停、`Del` 移出队列
- **偏好持久化**：补帧方式/画质/帧率/封装/硬解设置自动记忆
- **视频预览**与信息展示（分辨率/帧率/时长/编码/音轨/体积）；完成后展示输出信息并可一键打开所在文件夹
- **任务进行中关窗确认**，防止误触丢任务

## 直接使用

双击项目根目录的 **`FrameBoost.exe`** 即可（便携版，免安装，内置 ffmpeg，约 130MB）。也可以双击 `FrameBoost 启动.lnk`。

界面按"左预览 + 右参数台 + 底栏操作"排布：拖入素材 → 选预设或调帧率/方式/画质 → 点底栏「开始补帧」。运行中底栏实时显示百分比、阶段、帧率与剩余时间，点右侧箭头展开详细数据。

## 使用

- 目标帧率：×2 / ×3 / ×4 或自定义（5-480，需高于原帧率）
- 封装：MP4（faststart）/ MKV
- 环境变量 `FFMPEG_PATH` / `FFPROBE_PATH` 可指向自定义 ffmpeg（如新版以获得更新的 NVENC 支持），默认用内置的

## 开发与测试

要求 Node.js ≥ 20.19（推荐 22 LTS）。克隆本仓库后：

```bat
npm install
npm run dev           # vite + electron 开发模式
npm run test:pipeline # 补帧参数构建单元测试
npm run sample        # 生成 6 秒 30fps 演示视频
npm run icon          # 重新生成 build/icon.ico
npm run dist          # 打包 portable exe 到 release/
```

三套测试（补帧参数 / 本地服务守卫 / 超时与时限）共 269 条断言，`npm run test:pipeline`、`npm run test:guard`、`npm run test:timeout` 分别跑，`npm run verify` 一次跑完。Windows 下也可直接双击 `启动开发模式.cmd` / `打包Windows.cmd`（首次运行会自动安装依赖）。

`npm run dist` 打完包会自动把 exe 发布到仓库根目录并清掉 `release/` 里的中间产物（`scripts/publish-exe.mjs`），所以仓库里始终只有一份 exe。

## 性能预期

光流补偿为 CPU 密集型：640×360 实测约 0.4x 实时速度，1080p 通常仅 0.05~0.2x。建议先用「帧混合」快速确认参数，再用光流模式出成片。场景切换处 ffmpeg 自动检测（scd）改为复制帧，避免跨镜头鬼影。NVENC 只加速编码环节，补帧本身始终由 CPU 完成。

## 🤖 Agent API / MCP

FrameBoost 把真实能力（ffmpeg 探测、NVENC 检测、补帧渲染）封装成带 JSON Schema 的工具面，任意 Agent（Tcode、Claude Code、Codex 或任何 MCP 客户端）无需读源码、无需猜路由即可驱动它。共两个入口：

### 1. 独立 Agent API + MCP（推荐给 Agent）—— 端口 **8791**

`agent/` 里一个零依赖本地服务，遵循本机统一的 Agent API 标准。它**复用与桌面应用完全相同的编译内核**（`electron/pipeline.ts` 负责命令构建，共享的 `electron/ffmpeg.ts` 引擎负责探测 / NVENC / 10bit 检测）——没有第二套实现，不返回写死数据。

```bash
npm run agent:serve     # 先构建 electron 内核，再监听 http://127.0.0.1:8791
npm run agent:mcp       # stdio MCP 桥（initialize / tools/list / tools/call）
```

| HTTP 契约 | |
|---|---|
| `GET /api/health` | `{ok, data:{project, version, agent_api:1, tools, uptime_ms}}` |
| `GET /api/agent/tools` | 工具描述符 `{name, description, input_schema, risk}` |
| `POST /api/agent/tool` | 请求体 `{tool, input}` → `{ok, data, tool, ms}`；失败为 `{ok:false, error:{code, message}}` |

工具（均以 `frameboost.` 前缀）：

| 工具 | 风险 | 作用 |
|---|---|---|
| `capability_probe` | read | 本机真实 ffmpeg/ffprobe 路径与版本、NVENC 等级、10bit 能力 |
| `list_inputs` | read | 列出目录中可处理的输入视频（真实 stat） |
| `probe_video` | read | ffprobe 单个文件 + ×2/×3/×4 目标帧率建议 |
| `render_start` | **exec** | 构建并真实执行补帧任务（必须 `confirm:true`，否则只返回预演计划），返回 `jobId` |
| `job_status` | read | 轮询进度（百分比/已处理时长/倍速/剩余时间）与真实回探的输出结果 |
| `cancel_job` | **write** | 停止运行中的任务并清理 `.part`（必须 `confirm:true`） |
| `list_outputs` | read | 列出目录中 FrameBoost 生成的输出文件 |

`render_start` 是写操作：不带 `confirm:true` 时不执行任何东西，只返回解析后的计划（输出路径、尝试序列、编码器）；带 `confirm:true` 时才 spawn 与桌面应用一致的 ffmpeg 进程。详见 [`agent/README.md`](./agent/README.md)。

### 2. 应用内 REST —— 端口 8393

桌面应用自身运行时，`127.0.0.1:8393` 提供一个更轻的 REST 入口（`FRAMEBOOST_API_PORT` 可覆盖），复用应用内的实时渲染流程：

| 路由 | 方法 | 请求体 | 返回 |
|---|---|---|---|
| `/health` | GET | — | 版本 |
| `/api/nvenc` | GET | — | NVENC 能力（`none` / `legacy` / `modern`）|
| `/api/probe` | POST | `{inputPath}` | 时长/帧率/像素格式/编码/10bit 信息 |
| `/api/render` | POST | `{inputPath, outputPath, targetFps, mode: "high"\|"balanced"\|"fast", quality?, useNvenc?, container?}` | 202 受理（异步渲染）|
| `/api/job` | GET | — | 实时进度 + 最近一次渲染结果（`outputPath`、`sizeBytes`、`fps`）|

## 许可证

MIT（[LICENSE](./LICENSE)）

# ⚡ FrameBoost (帧跃) · 本地极速视频补帧神器

<p align="center">
  <img src="./build/icon.png" width="100" height="100" alt="FrameBoost Icon" />
</p>

<p align="center">
  <b>一款免费开源、支持 GPU 硬件加速的本地离线视频插帧工具</b><br>
  一键将 24/30fps 动漫、老电影、游戏高光平滑插帧至 60/90/120fps 丝滑高刷！纯本地运行 · 零云端上传 · 保护隐私
</p>

<p align="center">
  <a href="./README.en.md">English Documentation</a> | <b>简体中文</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/Platform-Windows%2010%2B-0078D6?logo=windows&logoColor=white" alt="Platform" />
  <img src="https://img.shields.io/badge/GPU%E5%8A%A0%E9%80%9F-NVIDIA%20NVENC-76B900?logo=nvidia&logoColor=white" alt="NVENC" />
  <img src="https://img.shields.io/badge/100%25-纯本地离线-brightgreen" alt="Offline" />
  <img src="https://img.shields.io/badge/FFmpeg-免安装内置-007808?logo=ffmpeg&logoColor=white" alt="FFmpeg" />
  <img src="https://img.shields.io/badge/Agent-MCP%20Ready-orange" alt="MCP" />
</p>

---

## 🎯 为什么选择 FrameBoost？

你是否有过这样的体验：
* 想看 **60 帧 / 120 帧** 丝滑的高刷动漫或电影，但在视频网站需要会员甚至根本没有高帧率选项？
* 网上的在线 AI 补帧工具 **按分钟收费、限制文件大小、还要排长队**，而且容易泄露个人视频隐私？
* 用传统 FFmpeg 命令行处理，参数复杂得像天书，还常常遇到 **尾部莫名掉帧、HDR 画面发灰变色、音画不同步** 的恼人问题？

**FrameBoost 就是为你打造的终极解决方案！**  
无需安装复杂的 Python 或 CUDA 环境，自带精美的现代桌面界面与开箱即用的 FFmpeg 引擎。拖入视频，一键开启电影级补帧！

---

## ✨ 核心特性

| 特性 | 说明 |
| :--- | :--- |
| 🚀 **一键 60/120 帧** | 支持目标帧率自定义（60fps、90fps、120fps 或任意倍率），画面行云流水 |
| ⚡ **GPU 硬件加速** | 深度集成 NVIDIA NVENC 硬件编码器，智能探测驱动预设，导出速度倍增 |
| 🎨 **HDR & 10bit 色彩透传** | 独家色彩元数据（BT.709 / BT.2020 / PQ / HLG）原样透传，色彩不发灰，保留顶级母版画质 |
| ⏱️ **精准帧数与音画对齐** | 创新的 `tpad` 克隆与微修剪算法，杜绝传统光流插帧的尾部掉帧，确保音视频严丝合缝 |
| 🛡️ **100% 纯本地离线** | 所有数据全程在本机运行，绝不上传云端，不消耗网络流量，完全保障隐私 |
| 📋 **批量处理队列** | 支持多视频拖拽批量加入，支持拖拽排序、失败单项重试、完成后系统弹窗提醒 |
| 🤖 **AI Agent & MCP 支持** | 原生开放 MCP (Model Context Protocol) 与 REST API，支持让 Cursor、Claude Code、智能体自动批量剪辑与补帧 |

---

## 🖥️ 界面预览

<p align="center">
  <img src="docs/screenshot.png" alt="FrameBoost 主界面" width="85%" />
</p>

<p align="center">
  <em>左侧实时素材信息与播放预览，右侧参数控制台，底栏实时显示进度、帧率与剩余时间</em>
</p>

---

## ⚙️ 三种插帧模式随心选择

根据视频类型与机器性能，随心切换最适合的插帧算法：

1. **光流补偿 · 精细** (`AOBMC + 双向运动估计 + 变分加权`)
   * **特点**：运动矢量估计最平滑，边缘过渡细腻，几乎无撕裂。
   * **适用**：动漫、高画质电影特写、慢动作升格。
2. **光流补偿 · 均衡** (`OBMC 运动补偿`，**推荐**)
   * **特点**：速度与画质兼顾，运动补偿准确自然。
   * **适用**：绝大多数日常视频、Vlog、短视频。
3. **动态帧混合** (`相邻帧加权融合`)
   * **特点**：计算速度极快，CPU 占用极低。
   * **适用**：低配置设备快速处理、快速运动场景消除频闪。

---

## 🚀 快速上手

### 方式一：直接运行桌面版（开箱即用，推荐）
1. 前往项目根目录，直接双击运行 **`FrameBoost.exe`**（便携绿色版，免安装，内置 FFmpeg 引擎）。
2. 将想要补帧的视频拖入软件窗口。
3. 选择目标帧率（如 60fps）及补帧模式。
4. 点击底栏 **「开始补帧」**，静待导出完成即可！

### 方式二：从源码运行（开发者模式）
确保已安装 Node.js 18+ 与 npm：

```bash
# 1. 克隆仓库
git clone https://github.com/zhangtt08/video-frame-interpolator.git
cd video-frame-interpolator

# 2. 安装依赖
npm install

# 3. 启动开发模式
npm run dev
```

---

## 🤖 AI 智能体与 MCP 集成

FrameBoost 不仅是一个桌面软件，还是一个强大的视频处理微服务！应用内置本地 REST API 与 MCP 服务：

```bash
# 启动面向 Agent 的本地服务（默认端口 8791）
npm run agent:serve
```

已支持工具：
* `frameboost.probe`：探测本地视频分辨率、帧率、色彩空间与音轨元数据
* `frameboost.interpolate`：传入输入路径、目标帧率、插帧模式与输出路径，执行自动化补帧
* `frameboost.status`：查询后台任务实时进度与硬件状态

在 Cursor、Claude Code 或 Antigravity 中配置 `agent/mcp-server.mjs`，即可让 AI 助手直接调用补帧能力！

---

## ⭐ 支持与致谢

如果 FrameBoost 帮助你把心爱的视频变得更加流畅顺滑，请给本项目点一个 **Star ⭐**！您的支持是持续迭代维护的最大动力。

欢迎提交 [Issue](https://github.com/zhangtt08/video-frame-interpolator/issues) 反馈建议或提交 PR 贡献代码！

---

## 📄 开源许可证

本项目基于 [MIT License](./LICENSE) 协议开源。

# ⚡ FrameBoost · Local High-Performance Video Frame Interpolator

<p align="center">
  <img src="./build/icon.png" width="100" height="100" alt="FrameBoost Icon" />
</p>

<p align="center">
  <b>Free, open-source, offline video frame-interpolation desktop app with GPU hardware acceleration.</b><br>
  Smoothly upgrade 24/30fps videos to 60/90/120fps high-refresh buttery smoothness! 100% local · Zero cloud uploads · Privacy guaranteed.
</p>

<p align="center">
  <b>English</b> | <a href="./README.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/Platform-Windows%2010%2B-0078D6?logo=windows&logoColor=white" alt="Platform" />
  <img src="https://img.shields.io/badge/GPU%20Accel-NVIDIA%20NVENC-76B900?logo=nvidia&logoColor=white" alt="NVENC" />
  <img src="https://img.shields.io/badge/100%25-Local%20Offline-brightgreen" alt="Offline" />
  <img src="https://img.shields.io/badge/FFmpeg-bundled-007808?logo=ffmpeg&logoColor=white" alt="FFmpeg" />
  <img src="https://img.shields.io/badge/Agent-MCP%20Ready-orange" alt="MCP" />
</p>

---

## 🎯 Highlights & Features

- **Smooth 60/120fps Upgrades**: Interpolate low-framerate anime, movies, sports, or game clips into buttery 60/90/120fps.
- **NVENC Hardware Acceleration**: Automatic NVIDIA GPU detection and multi-level graceful fallback to CPU.
- **HDR & 10-bit Color Passthrough**: Preserves BT.709 / BT.2020 / PQ / HLG color metadata without washed-out colors.
- **Audio-Visual Sync Guarantee**: Precise output frame matching prevents tail frame drops and maintains perfect lipsync.
- **Queue & Batch Processing**: Drag-and-drop batch queue, reordering, failure retries, and background completion notifications.
- **AI Agent & MCP Support**: Native MCP (Model Context Protocol) and REST API for automation by Cursor, Claude Code, and autonomous agents.

---

## 🖥️ Preview

<p align="center">
  <img src="docs/screenshot.png" alt="FrameBoost UI Preview" width="85%" />
</p>

---

## 🚀 Quick Start

### Option 1: Run Pre-built Portable App (Recommended)
1. Double click **`FrameBoost.exe`** in the project directory (Standalone portable app with bundled FFmpeg).
2. Drag and drop your video file.
3. Select your target frame rate (e.g. 60fps) and interpolation mode.
4. Click **Start Interpolation**!

### Option 2: Run from Source
```bash
git clone https://github.com/zhangtt08/video-frame-interpolator.git
cd video-frame-interpolator
npm install
npm run dev
```

---

## ⭐ Star History & Feedback

If you find FrameBoost useful, please give it a **Star ⭐** on GitHub!
Licensed under the [MIT License](./LICENSE).

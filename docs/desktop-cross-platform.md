# 桌面端跨平台（Windows / macOS / Linux）

> 目标：mind-base-desktop 在 Windows、macOS、Linux 上都能构建与运行；
> 本文记录平台差异、构建前置条件与已验证/待验证范围。

## 1. 平台支持状态

| 平台 | 状态 | 说明 |
|------|------|------|
| Windows x64 | ✅ 主要开发/验证平台 | 全部功能已在本机验证 |
| macOS (arm64/x64) | ⚠️ 代码已按跨平台实现，待真机/CI 验证 | Tauri / russh / keyring 均有 macOS 后端 |
| Linux x64 | ⚠️ 代码已按跨平台实现，待真机/CI 验证 | 需要 WebKitGTK 等系统依赖；无桌面会话时凭据降级 |

## 2. 构建前置

通用：Rust stable（≥1.88，keyring 4 要求）、Node.js ≥ 22、npm、Python 3。Windows 使用官方
embeddable 运行时（应用自动下载）；macOS/Linux 使用系统 python3 创建 venv，需要
python3-venv + pip（Debian/Ubuntu 见下）。

Linux（Debian/Ubuntu 系）：

```bash
sudo apt update
sudo apt install -y build-essential curl wget file libssl-dev \
  libwebkit2gtk-4.1-dev libxdo-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf python3 python3-venv python3-pip
```

macOS：安装 Xcode Command Line Tools（`xcode-select --install`）、Rust、Node、Python 3
（python.org 安装包或 `brew install python`；venv 与 pip 随官方 Python 自带）。

Windows：Rust MSVC toolchain、Node、Python 3；FFmpeg sidecar 可用 `npm run fetch:ffmpeg:win`。

## 3. FFmpeg sidecar（三平台通用）

Tauri `bundle.externalBin` 需要按 target triple 命名的 sidecar：

```
src-tauri/binaries/ffmpeg-<target-triple>[.exe]
src-tauri/binaries/ffprobe-<target-triple>[.exe]
```

准备方式（只复制本机已安装的 ffmpeg/ffprobe，不联网下载）：

```bash
# Linux: apt install ffmpeg   macOS: brew install ffmpeg
npm run fetch:ffmpeg
# 或指定目录
node scripts/fetch-ffmpeg.mjs --source /opt/ffmpeg/bin --force
```

Windows 仍可使用原来的 PowerShell 下载/复制脚本：`npm run fetch:ffmpeg:win`。

> 若构建时缺少对应平台的 sidecar，`tauri build` 会失败；运行期也有
> 「系统 ffmpeg」回退链（`media/ffmpeg.rs`），但安装包构建必须先准备 sidecar。

## 4. 凭据存储（SSH）

- 统一走 `keyring` 4：Windows **Credential Manager**、macOS **Keychain**、
  Linux **Secret Service**（GNOME Keyring / KWallet）。
- 配置里只保存 `keyring:<scope>` 引用，不出现明文密码；历史 `dpapi:` 密文
  仅在 Windows 解密迁移，下次保存自动转 keyring。
- 系统凭据库不可用时（例如 Linux 无桌面会话 / 无 Secret Service）自动降级为
  `plain:` 明文并打印警告——此时请用私钥认证，或启动桌面密钥环。
- macOS 首次写入 Keychain 可能弹出系统授权，属正常行为。

## 5. SSH / 远程执行

- SSH 客户端为纯 Rust `russh`，Windows/macOS/Linux 共用同一实现；
- 交互终端用 xterm.js，三平台一致；
- Agent 上传文件时使用 POSIX 命令，base64 解码兼容 GNU / BSD(macOS) / openssl：

```bash
mkdir -p '<dir>' && printf %s '<b64>' | (base64 -d 2>/dev/null || base64 -D 2>/dev/null || openssl base64 -d) > '<file>'
```

## 6. Python 运行时（写作导出 / DOCX·PDF 预览 / 数据集画像 / 分析脚本 / PPTX）

桌面端不依赖用户手工维护的系统 pip 环境，运行时统一由应用准备：

| 平台 | 运行时 | 位置 |
|------|--------|------|
| Windows | 官方 **embeddable** Python（首次使用自动下载解压 + get-pip 引导） | `<data_dir>/python/python.exe` |
| macOS / Linux | 系统 **python3** 执行 `-m venv` 创建虚拟环境（已存在则复用；pip 缺失时 `ensurepip` 兜底） | `<data_dir>/python-venv/bin/python3` |

- 第三方依赖（dashscope、python-docx、pymupdf、openpyxl、pandas 等）一律用 venv 内的
  pip 安装到 `<data_dir>/python-venv`，不污染系统 Python；
- Linux 前置：`python3` + `python3-venv` + `python3-pip`（Debian/Ubuntu：
  `sudo apt install python3 python3-venv python3-pip`）；缺失时应用会返回中文错误并提示安装命令；
- macOS 前置：安装完整 Python 3（python.org 或 brew），Keychain 与 venv 均随系统组件；
- CUDA OCR 的 onnxruntime-gpu 替换目前**仅 Windows 适配**；macOS/Linux 保留 CPU 版
  onnxruntime（避免安装不匹配的 GPU 包）；
- Windows 行为与此前一致（嵌入版 + .pth + pip 引导），macOS/Linux 分支需 CI/真机验证。

## 7. 构建与测试

```bash
cd mind-base-desktop
npm install
npm run fetch:ffmpeg        # 准备本平台 sidecar
npm run build               # tsc + vite
npm run tauri build         # 打包（Windows: nsis/msi；macOS: dmg/app；Linux: deb/rpm/AppImage）
```

Rust 测试：

```bash
cd src-tauri
cargo test --lib
cargo test --test agent
```

## 8. 待办（跨平台）

- [ ] 增加 GitHub Actions 三平台矩阵（windows-latest / macos-latest / ubuntu-latest）
      跑 `cargo test` + `npm run build` + `tauri build`；
- [ ] macOS 真机验证 Keychain 写入/读取与交互终端；
- [ ] Linux 真机验证 Secret Service（有/无桌面会话两种）与 WebKitGTK 打包；
- [ ] 真实 SSH 服务器端到端验证（TOFU、指纹不匹配、项目绑定、upload/run）；
- [ ] sidecar 版本/hash 固定与许可证合规（GPL FFmpeg 分发）。

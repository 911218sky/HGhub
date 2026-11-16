# 开发指南

## 前置条件

| 工具 | 版本 / 说明 |
| --- | --- |
| Node.js | ≥ 26（`package.json` `engines`） |
| pnpm | 10 |
| Rust | ≥ 1.90（`src-tauri/Cargo.toml` `rust-version`） |
| Tauri CLI | 经 `pnpm`（`@tauri-apps/cli`） |

按 [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/) 安装各平台工具链。

```bash
pnpm install --frozen-lockfile
```

`.npmrc` 强制 `node-linker=hoisted`，以适配符号链接支持不佳的环境。

## 本地命令

```bash
pnpm dev              # Vite，通常为 http://127.0.0.1:1420
pnpm app:dev          # 桌面 Tauri + Vite
pnpm build            # 前端生产构建 + 类型检查
pnpm app:build        # 当前主机原生打包

pnpm test:playback    # scripts/test-playback.mjs（完整跑需 ffmpeg + playwright-core 的 Chromium）
pnpm test:api-loading # scripts/test-api-loading.mjs

cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
```

被忽略的网络类 Rust 测试（封面解密、在线播放链、镜像、探测、网络诊断）仅在以下方式运行：

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -- --ignored
# 封面测试需要真实 URL：
# HGHUB_TEST_COVER_URL='https://…' cargo test --locked --manifest-path src-tauri/Cargo.toml --lib cover_decrypt_works -- --ignored
```

浏览器 HTML 安全测试页：启动 `pnpm dev --host 127.0.0.1`，打开 `http://127.0.0.1:1420/tests/html-security.html`。

## 平台说明

| 目标 | 配置 / 入口 | 说明 |
| --- | --- | --- |
| Windows | `src-tauri/tauri.conf.json` | `LOCAL` = `http://hg.localhost`；系统代理经 reqwest `system-proxy` |
| macOS | + `tauri.macos.conf.json`；`macos_titlebar.rs` | `LOCAL` = `hg://localhost`；红绿灯标题栏调整 |
| Linux | 默认桌面配置 | `LOCAL` = `hg://localhost`；原生运行需 WebKitGTK 依赖 |
| Android | `pnpm android:init` / `android:dev` / `android:build`；`scripts/sync-android-icons.mjs` | `LOCAL` = `http://hg.localhost` |
| iOS | `tauri.ios.conf.json`；`scripts/build-ios-unsigned.sh` | `LOCAL` = `hg://localhost`；CI 未签名打包 |

变更平台或 scheme 处理时，务必保持前端 `src/api.ts` 的 `LOCAL` 与 Rust `media::LOCAL_ORIGIN` 同步。

开发态导航在严格模式下仅允许 localhost（或 `TAURI_DEV_HOST`）上的 `http://…:1420`（`lib.rs`）。

## 环境变量

| 变量 / 标志 | 作用 |
| --- | --- |
| `HGHUB_PROXY` | 强制 Rust reqwest 使用 HTTP(S) 代理（如 `http://127.0.0.1:7897`） |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | 标准代理环境变量（在 `net_diag` 中会脱敏） |
| `HGHUB_STRICT` | `0`/`false` → 启动时放宽；`1`/`true` → 严格 |
| CLI `--no-strict` / `--no-strict-security` / `--relaxed` | 进程启动时关闭严格安全 |
| CLI `--strict` / `--strict-security` | 强制开启严格模式 |
| `TAURI_DEV_HOST` | 调试时额外允许的 Vite 源 / 导航主机 |
| `HGHUB_TEST_COVER_URL` | 被忽略的 Rust 解密测试用的真实封面 URL |
| `PLAYBACK_SCENARIOS` | `test:playback` 的逗号分隔场景列表 |

严格模式也可在 **设置 → 网络** 中切换；Rust 将 `security.json` 持久化到应用数据目录（`security_set` / `app_boot`）。

可用系统代理或 `HGHUB_PROXY`；外部代理分流（Mihomo / sing-box 等）可选，不能替代应用内 `network_policy`。

# 维护者交接

接手时请先读根目录 [README](../README.md)，再快速浏览 [ARCHITECTURE](ARCHITECTURE.md)。

## 1. 先跑通桌面端

```bash
# Node 26 LTS、pnpm 10、Rust ≥ 1.90
pnpm install --frozen-lockfile
pnpm app:dev
```

若 UI 能打开但封面 / 视频失败：确认 `src/api.ts` 的 `LOCAL` 与 `src-tauri/src/media.rs` 的 `LOCAL_ORIGIN` 一致（Windows/Android → `http://hg.localhost`；macOS/iOS/Linux → `hg://localhost`）。

仅前端：`pnpm dev`（真实流媒体仍依赖 Rust 媒体协议）。

## 2. 模块速览

| 关注点 | 去哪看 |
| --- | --- |
| Tab、导航栈、主题、语言、本地收藏/历史 | `src/store.tsx` |
| 壳层 / Tab 栏 / 栈页面 | `src/App.tsx` |
| 竖滑播放器 | `src/components/Feed.tsx`（及 `VideoSurface.tsx`） |
| 离线下载 UI | `src/pages/Downloads.tsx` |
| 全部 `invoke` 门面 | `src/api.ts` → `src-tauri/src/api.rs` |
| 下载队列 / 合并 | `src-tauri/src/download.rs` |
| 上游 HTTP + 代理 | `src-tauri/src/net.rs`、`lines.rs` |
| 封面 AES + HLS 改写/缓存 | `src-tauri/src/media.rs`（[MEDIA.md](MEDIA.md)） |
| CSP / HTML 消毒 / 严格模式 | `src/html.ts`、[SECURITY.md](SECURITY.md) |
| zh / zh-TW / en 文案 | `src/i18n/zh.ts`、`zh-TW.ts`、`en.ts` — `t("key")` |

导航：五个 Tab（`home` / `category` / `downloads` / `search` / `profile`）。浮层：`feed`、`channel`、`ranks`、`settings`、`posts`、`post`、`downloads`。

## 3. 产品 UI 要点

- 视觉：抖音风短视频 UI（主色 `#FE2C55`、深色底、底部 5 个 Tab）。样式 token 见 `src/index.css`。
- 排行榜：`src/pages/Search.tsx` 中的 `RankPage`；领奖台与列表行在 `src/components/cards.tsx`。
- 动效：`.a-rise`、`.a-rank-in`、`.a-podium`、`.a-tab-ink`，以及 page/sheet/panel 类（需尊重 `prefers-reduced-motion`）。

## 4. 性能约定

**前端**

- `Feed.tsx` 只为 `index ± 1` 挂载媒体；其余 slide 用等高占位配合 snap 滚动。
- 播放时钟 UI 经 `setTimeUi` 节流（约 8 Hz）— 不要在每个 media tick 上调用 `setTime`。

**Rust**

- `media.rs` 用 `TouchCache`（按最近访问淘汰）管理 IMG / playlist / key / segment。
- 封面 AES 在 `spawn_blocking` 中执行；命中缓存时尽量直接返回已有 `Bytes`，避免多余拷贝。

## 5. 增加 UI 文案（i18n）

1. 在 `src/i18n/zh.ts`、`zh-TW.ts`、`en.ts` 三侧增加同一 key（繁体人工维护，不自动生成）。
2. 使用 `const { t } = useStore();`，再 `t("your.key", { n: 1 })`。
3. 跑 `pnpm exec tsc --noEmit` — `MessageKey` 由 zh 目录推导。

默认语言：`navigator.language` 含 tw/hk/mo/hant → `zh-TW`，其它 `zh*` → `zh`，否则 `en`；可在设置中覆盖（`hghub_locale`）。

## 6. 发版

1. 升版：改 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。
2. 提交后打 tag `vX.Y.Z` 并推送。
3. Android 真机装 `*_arm64.apk`（无 Secrets 时用仓库 sideload 证书）。
4. 想让 macOS / iOS「正常安装」需要 Apple 开发者账号，并在仓库 Secrets 配置：
   - 共用：`APPLE_CERTIFICATE`（p12 的 base64）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_TEAM_ID`、可选 `APPLE_SIGNING_IDENTITY` / `KEYCHAIN_PASSWORD`
   - macOS 公证：`APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`，或 `APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_BASE64`
   - 未配置时：macOS 为 ad-hoc（用户需右键打开），iOS 为 unsigned IPA（sideload）

## 7. 安全 / 信任边界（勿随意放宽）

- 严格模式会拦截风险 HTML，并收紧导航；通过 Rust `security_*` 命令持久化。
- 登录/注册仅允许固定 API 源（见 `net` / lines 策略）— 镜像仅供浏览。
- 文章 HTML 经 DOMPurify（`src/html.ts`）。优先修消毒配置，而不是关掉严格模式。
- 可用系统代理或 `HGHUB_PROXY`；外部代理分流不能替代应用内 `network_policy`。

## 8. 建议的首周任务

1. 在本机 OS 复现首页 Feed + seek + 静音。
2. 打开排行榜 → 前三领奖台 → 播放条目；在设置中切换语言。
3. 跑 `pnpm build` 与 `cargo check --locked --manifest-path src-tauri/Cargo.toml`。
4. 从 UI 的 `cover()` 跟踪一条封面 URL，直到 `media::load_image`。

## 9. 文档地图

| 文档 | 何时查阅 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 系统图 / 模块地图 |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 环境、环境变量、平台差异 |
| [SECURITY.md](SECURITY.md) | CSP、严格模式、网络策略 |
| [MEDIA.md](MEDIA.md) | HLS 代理、缓存、解密 |
| 本文 | 首日上手顺序与变更禁忌 |

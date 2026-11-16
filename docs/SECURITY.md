# 安全模型

相关实现：`src/html.ts`、`src-tauri/tauri.conf.json`（CSP）、`src-tauri/src/lib.rs`、`network_policy.rs`、`net.rs`、`session.rs`。

## CSP

生产 CSP 定义在 `src-tauri/tauri.conf.json`（`app.security.csp`）。摘要：

- `default-src 'none'`；脚本仅 `'self'`（生产禁止内联 / 远程 / `data:` 脚本）
- 样式：`'self' 'unsafe-inline'`
- 图片 / 媒体：`'self'`、`data:`（img）、`blob:`（media），以及 `hg` / `hg.localhost` 本地源
- `connect-src`：IPC + 本地 `hg` 源（开发 CSP 另允许 Vite 的 `ws:` / `wss:` / `'self'`）
- `worker-src 'self' blob:`（hls.js worker）
- `object-src`、`base-uri`、`form-action`、`frame-src` 收紧为 `none`

`devCsp` 仅为 Vite HMR 放宽 `script-src`；生产 CSP 不要跟着放宽。

## DOMPurify

帖子 HTML 经固定版本 DOMPurify（`src/html.ts`）后再 `dangerouslySetInnerHTML`。封面类图片 URL 会改写到 `LOCAL/img`，重复消毒保持幂等。

严格模式：白名单标签/属性（布局、链接、图片），去掉 SVG/MathML/脚本/事件/内联样式；拦截非 HTTP(S) 与私网/本机 URL。链接点击不在 WebView 内跳转，经策略校验后由 Rust `open_url` 打开。

兼容模式仍走 DOMPurify，但标签、内网与导航限制更松。

## 严格安全模式

默认开启。

| 控制方式 | 位置 |
| --- | --- |
| CLI | `--strict` / `--no-strict`（别名 `--strict-security`、`--no-strict-security`、`--relaxed`） |
| 环境变量 | `HGHUB_STRICT=0|1|false|true` |
| UI | 设置 → 网络 → 严格安全；持久化为应用数据目录下的 `security.json` |
| IPC | `security_set` / `app_boot`（`api.rs`）；前端经 `html.ts` 的 `setStrictSecurity` 镜像 |

严格模式下的效果：

- 导航插件拒绝非应用 / 非开发源（`lib.rs`）
- 若 `Origin` 不是允许的前端源，`hg` 协议返回 403
- `network_policy` 拒绝私有/环回/链路本地/ULA 主机，以及同一主机名同时解析到公网与私网地址的 DNS 结果；允许 FakeIP 池 `198.18.0.0/15`
- 带凭据的业务 POST 不跟随重定向；匿名 GET 每跳重新校验（最多 5 跳），禁止 HTTPS→HTTP 降级

## 网络策略

所有 Rust 拉取经 reqwest（`net.rs`），不经 WebView。目标在 `network_policy.rs` 中检查：

- 仅 HTTP(S)；URL 中禁止 userinfo
- DNS 结果在客户端按短 TTL 固定，过期后重新检查
- 线路 base 必须是裸 HTTPS origin（`net::normalize_base`）
- 登录/注册信任 `https://huangdou.me`、`https://huangguoai.com` 与 `https://huangguoai.ai`（`trusted_auth_origin`）；访客镜像不会扩展鉴权信任
- AI换脸 / AI魔改列表与播放走 `huangdou.me`（旧线路对该分类返回 410「内容已下线」）
- 会话 token 绑定源站（`session.rs`）；切换线路会清除跨源凭据；无源绑定的旧会话需重新登录

代理：系统代理 + 可选 `HGHUB_PROXY`。`net_diag` 在返回 UI/日志前会脱敏凭据与敏感代理字段。

## 维护者清单

1. 优先收紧 CSP / 策略，而不是用前端绕过。
2. 新增任何会请求远程 URL 的路径（含 `media.rs` 的 HLS 改写链路）都必须走 `network_policy`。
3. 在已有本地协议路径时，不要把原始上游媒体 URL 暴露给 WebView。
4. 策略变更后，跑 `cargo test --lib` 与 `tests/html-security.html`（见 [DEVELOPMENT.md](DEVELOPMENT.md)）。

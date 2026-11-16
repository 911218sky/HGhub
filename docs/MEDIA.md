# 媒体管线

实现以 `src-tauri/src/media.rs` 为准；`hg` 协议注册在 `lib.rs`；前端入口为 `src/api.ts` 的 `LOCAL` / `cover` / `playlist`。播放器见 `VideoSurface.tsx`（hls.js）。

## 为何使用本地协议

上游封面是 AES-128-CBC 密文，不是明文图片。HLS 播放列表常引用 WebView 无法直接加载的分片/密钥主机（CORS / 防盗链）。Rust 经 reqwest（配合网络策略）拉取、解密或改写，再通过 `hg` 自定义 scheme 提供字节。

平台 origin（`LOCAL_ORIGIN` / `LOCAL`）：

| OS | Origin |
| --- | --- |
| Windows、Android | `http://hg.localhost` |
| macOS、iOS、Linux | `hg://localhost` |

Rust 与 `src/api.ts` 不一致会导致全部媒体失败。

## 封面解密（`/img`）

1. UI：`cover(url)` → `${LOCAL}/img?u=${encodeURIComponent(url)}`
2. Rust `handle("/img", …)` → `load_image`：经 `net::fetch_bytes` 做 HTTP GET
3. 密文用 AES-128-CBC 解密（`IMG_KEY` / `IMG_IV`），去除 PKCS#7 填充，并按魔数判断 MIME（JPEG/PNG/GIF/WebP）
4. 结果写入 IMG 内存缓存，并以图片响应返回

可通过 Tauri 命令 `cache_clear` 清理（设置页也有入口）。

## HLS 代理（`/hls` + `/seg`）

1. UI：`playlist(url)` → `${LOCAL}/hls?u=…`
2. `load_playlist` 拉取 m3u8，拒绝非播放列表正文，执行 `rewrite_playlist`
3. 改写将 `#EXT-X-KEY`、variant、备用媒体与分片 URI 映射到 `${origin}/seg?u=…`。可能绕过代理的 steering / asset-list 类外部 URI 会被过滤
4. hls.js 请求改写后的 `/seg`；`load_segment` 拉取字节（或 AES 密钥）。嵌套播放列表会再次改写，避免原始上游 URL 到达播放器

## 内存缓存

| 缓存 | 常量 | 最大条目 | 内容 |
| --- | --- | --- | --- |
| IMG | `IMG_CACHE` / `IMG_CACHE_MAX` | 240 | 解密后的封面字节 |
| PL | `PL_CACHE` / `PL_CACHE_MAX` | 60 | 改写后的播放列表文本（键带 origin 前缀） |
| SEG | `SEG_CACHE` / `SEG_CACHE_MAX` | 36 | 分片字节；超过 `SEG_CACHE_MAX_BYTES`（4 MiB）的条目不入库 |
| KEY | `KEY_CACHE` / `KEY_CACHE_MAX` | 120 | HLS AES 密钥响应（与分片同加载路径） |

超限时在插入时修剪（`cache_put`）。均由 `media::cache_clear` / 命令 `cache_clear` 一并清空。UI「清理缓存」文案只提封面与播放列表；实际也会清空 SEG/KEY。

## 调试提示

- SEG/KEY 缓存在 seek 时更稳；若一直卡在错误清晰度，先清缓存，并确认 playlist 仍改写到 `/seg`
- 排查协议请求可打开设置里的播放诊断日志（`playback_log`）
- 媒体网络失败仍走 `network_policy`：私有 DNS，或 `198.18.0.0/15` 之外被拦截的 FakeIP，会表现为拉取错误，而不是 WebView CORS 提示

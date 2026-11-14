# XUQIAN 本地加密 API 与 skill 接口

> 面向「让脚本 / skill / 其他程序调用自己的加密站」。
> 这是一个**本地进程**：只绑回环地址，与静态站点（`publish/`）完全分离。
> 网站本身仍然是零网络请求；这个服务只在你自己的机器上跑。
>
> **唯一实现**是 `scripts/xq-api.mjs`。本文与代码不一致时，以代码为准。

## 一、定位与启动

```bash
pnpm api                       # = node scripts/xq-api.mjs，默认 127.0.0.1:5190
node scripts/xq-api.mjs --port 5191
```

- 开机自启：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\xuqian-local.cmd`
  会同时拉起**站点（5188）**与**本 API（5190）**；端口已在监听就跳过，不产生重复进程。
- 停止：结束对应的 node 进程即可（`Ctrl+C`，或 `Stop-Process -Id <pid>`）。
- 可选环境变量：`XQ_API_PORT`（端口）、`XQ_API_TOKEN_FILE`（会话令牌文件路径）、
  `XQ_API_KEYS_FILE`（API Key 存储路径）。
- 数据位置（都在仓库之外）：

| 内容 | 路径 | 说明 |
| --- | --- | --- |
| 会话令牌 | `%TEMP%\xuqian-api-token.json` | 每次启动随机生成，含 `{token, port, pid, startedAt}` |
| API Key 哈希库 | `%LOCALAPPDATA%\xuqian\api-keys.json` | **只存 sha256**，不存明文 |

## 二、认证

三种凭据，任选其一；`GET /v1/auth` 可确认当前请求用的是哪一种。

| 方式 | 请求头 | 生命周期 | 说明 |
| --- | --- | --- | --- |
| 长期 API Key（推荐） | `Authorization: Bearer xq_…` | 长期，直到吊销 | 同时接受 `X-XQ-Key: xq_…` |
| 会话令牌 | `X-XQ-Token: <token>` | 仅本次进程 | skill 自动读取令牌文件，无需用户干预 |

管理 API Key：

```bash
pnpm keys add my-tools --save   # 现场打印一次明文；同时写入 %LOCALAPPDATA%\xuqian\api-key.txt
pnpm keys list                  # 列出 id / 标签 / 创建时间 / 最后使用
pnpm keys revoke my-tools       # 接受 id 或标签；下一个请求立即生效（每请求重读文件）
pnpm keys path                  # 打印存储位置
```

> 明文只展示一次。生成时如果输出被重定向进会话记录，等同于泄露——请吊销重来。
> 哈希库在仓库之外，删掉整个文件即等于吊销全部 key。

## 三、防护（硬编码在服务里，不是建议）

1. **只绑 `127.0.0.1`**：局域网与公网访问不到。
2. **带 `Origin` 头的请求一律 403**：浏览器发起的跨源请求一定带 `Origin`，
   这条挡住了「你正在浏览的恶意页面偷偷 POST 到 127.0.0.1:5190」。
3. **请求体上限 1 MiB**：只传路径与参数，不传文件内容。
4. `/v1/health` 与 `/v1/methods` **免凭据**（便于探测服务与挑选加密方式）。
5. 除三个 GET 端点外只接受 `POST`，否则 `405`。
6. 凭据比对用 `timingSafeEqual`（等长摘要比较），避免计时旁路。

## 四、端点一览

| 方法 | 路径 | 凭据 | 作用 |
| --- | --- | --- | --- |
| GET | `/v1/health` | 否 | `{ok, service, version, port, pid}` |
| GET | `/v1/methods` | 否 | 算法清单、层数范围、凭据方式、形态分派规则 |
| GET | `/v1/auth` | 是 | `{ok, method, label, id}`，确认凭据身份 |
| POST | `/v1/keygen` | 是 | 生成密钥文件，返回 `{ok, keyFile}` |
| POST | `/v1/encrypt` | 是 | **统一入口**：文件→文件 / 字符串→数据 |
| POST | `/v1/decrypt` | 是 | **统一入口**：文件→文件 / 数据→字符串 |
| POST | `/v1/encrypt-text` | 是 | 数据模式别名（等价于给 `/v1/encrypt` 传 `text`） |
| POST | `/v1/decrypt-text` | 是 | 数据模式别名（等价于给 `/v1/decrypt` 传 `token`） |
| POST | `/v1/inspect` | 是 | 读 `.XUQIAN` 头部自述（算法链、层数、分块、声明），不解密 |
| POST | `/v1/verify` | 是 | 只验密钥是否匹配，返回 `{ok, matched, exit}` |

## 五、形态决定输出（核心规则）

| 加密传入 | 输出 | `outputType` |
| --- | --- | --- |
| `inputs`（文件路径，字符串或数组） | 同目录生成 `.xuqian` 文件 | `"file"` |
| `text`（字符串） | base64url 字符串（`token` 字段） | `"data"` |

| 解密传入 | 输出 | `outputType` |
| --- | --- | --- |
| `inputs`（`.xuqian` 路径） | 还原出的原文件 | `"file"` |
| `token`（base64url 字符串） | 明文字符串（`text` 字段） | `"data"` |

`text`/`token` 与 `inputs` **同时给 → 400**。两个显式别名端点 `/v1/encrypt-text`、`/v1/decrypt-text`
与统一入口行为完全一致，保留只是为了调用处可读。

## 六、请求字段

### `/v1/encrypt`、`/v1/encrypt-text`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `inputs` | string \| string[] | 二选一 | 文件路径；非字符串一律拒绝（绝不拼进命令行） |
| `text` | string | 二选一 | 短内容（密码 / token） |
| `keyfile` | string | 二选一 | `.XUQIANKEY` 路径（推荐） |
| `key` | string | 二选一 | 直接传主密钥；仅自动化兼容，**不推荐**（会进请求体/日志） |
| `keyPassword` | string | 否 | 口令保护的密钥文件必须同时给 |
| `layers` | string | 否 | 层数 `"1"`~`"10"`（字符串） |
| `chunkSize` | string | 否 | 分块大小 |
| `note` | string | 否 | 写入 `meta.m` 的备注 |
| `notice` | string | 否 | 明文声明正文（默认声明不可省略） |
| `expires` / `notBefore` | string | 否 | 时间锁：到期 / 生效时间 |
| `gzip` / `encryptMeta` / `timestampSalt` | boolean | 否 | 对应 `0x02` / `0x04` / `0x08` 三个 flag |
| `out` | string | 否 | 输出路径（文件模式） |
| `force` | boolean | 否 | 覆盖已存在文件 |

### `/v1/decrypt`、`/v1/decrypt-text`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `inputs` | string \| string[] | 二选一 | `.XUQIAN` 路径 |
| `token` | string | 二选一 | base64url 密文（即加密返回的 `token`） |
| `keyfile` / `key` / `keyPassword` | string | 二选一 | 同加密侧 |
| `out` | string | 否 | 输出路径（文件模式） |
| `checkOnly` | boolean | 否 | 只验密钥与首块认证，**不返回明文** |
| `force` | boolean | 否 | 覆盖已存在文件 |
| `expectAlgorithm` | string | 否 | 钉死单层算法，不符即 400 |
| `expectLayers` | string[] | 否 | 钉死算法链（顺序一致），不符即 400 |

> 解密**不需要传算法**：`.XUQIAN` 头部自述 `layers:[{a,s,n}]`，服务端按逆序自动剥。
> `expectAlgorithm`/`expectLayers` 是"额外核对"，用于确认拿到的就是预期那份密文。
> 头部结构见 [FORMAT.md](./FORMAT.md)。

## 七、响应（2026-10-30 实测抓取）

```jsonc
// POST /v1/encrypt  { "text": "…", "keyfile": "…", "layers": "3" }
{ "ok": true, "outputType": "data", "token": "WFVRSUFOAg…", "bytes": 1039, "layers": ["AES-128-GCM", "…"] }

// POST /v1/decrypt  { "token": "WFVRSUFOAg…", "keyfile": "…" }
{ "ok": true, "outputType": "data", "text": "原文", "bytes": 12 }

// POST /v1/decrypt  { "token": "…", "keyfile": "…", "checkOnly": true }
{ "ok": true, "outputType": "data", "checked": true, "noticeBytes": 85 }
```

文件模式在 CLI 的结果对象上补一个 `outputType: "file"`：

```jsonc
{ "ok": true, "outputType": "file", "results": [ { "file": "…", "output": "…" } ] }
```

## 八、错误码

| 状态 | 含义 |
| --- | --- |
| 400 | 参数缺失/冲突、解密失败、算法校验不符、请求体不是 JSON 对象 |
| 401 | 缺少或错误的凭据 |
| 403 | 请求带 `Origin`（浏览器跨源） |
| 404 | 未知端点 |
| 405 | 该端点只接受 POST |
| 413 | 请求体超过 1 MiB |
| 500 | 服务内部错误（含"输出异常，不应发生"这类断言） |

启动时端口被占：进程以**退出码 3** 结束，并提示换端口——不会去抢端口。

## 九、安全边界（诚实披露）

- **数据模式的明文会短暂落盘**：CLI 只做文件进出，`/v1/encrypt` 传 `text` 时明文经 stdin 交给 CLI，
  产物写入 `%TEMP%\xq-api-*` 临时目录，读完立即整目录删除。写入瞬间它确实存在于磁盘上。
- **没有速率限制**：唯一的门槛是「只有本机进程能连 + 需要凭据」。装了恶意软件的机器上没有防线。
- **API 不校验 `keyfile` 位置**：路径由调用方给，写在桌面/共享盘上都合法——密钥放哪由你负责。
- **只暴露简单路线**：`src/selfcrypto`（自研路线）没有通过本 API 开放，两条路线的产物互不通用。
- **`key` 字段会进请求体**：优先用 `keyfile`；`key` 只给"临时自动化"用。
- 会话令牌文件在 `%TEMP%`，可读性依赖系统 ACL；同机多用户场景请自行收紧权限。

## 十、与网站、CLI 的关系

- **同一内核**：每个请求 `spawn` 现成的 `cli/xuqian.mjs`，不复制加密逻辑——
  API、CLI、网站三者的产物完全一致。
- 数据模式的产物是标准 `.XUQIAN` 容器（base64url 编码）：解码写回文件后，
  可直接用网站「简单加密」页或 CLI 解开。
- 命令行更适合大文件；API 更适合"程序里调用、不落盘拿到数据"。
  CLI 用法见 [GUIDE.md](./GUIDE.md) 与 `node cli/xuqian.mjs --help`。

## 十一、skill 接入

- skill 本体在仓库之外：`~/.dsh/skills/xuqian-crypto/SKILL.md`。
- 调用顺序：**端口优先**（5190 在跑就用 API），端口没起**退回 CLI**。
- 会话令牌由 skill 自动读取 `%TEMP%\xuqian-api-token.json`；
  长期 API Key 建议让用户自己执行 `pnpm keys add`，**不要让明文出现在会话记录里**。

## 十二、验收记录

2026-10-30 22:47 在本机实测（非推断）：

| 检查 | 结果 |
| --- | --- |
| `GET /v1/health` | `200 {"ok":true,"service":"xuqian-api","version":"<当前版本>","port":5190,"pid":…}` |
| `GET /v1/auth`（会话令牌） | `200 {"ok":true,"method":"session-token"}` |
| 数据模式 3 层往返 | `roundtrip = true`（1386 字符 token → 原文一致） |
| `checkOnly` | `200`，返回体**不含** `text` 字段 |
| 篡改密文末 8 字符 | `400`（认证失败，拒绝解密） |
| 无凭据 / 带 `Origin` / 非 JSON / 未知端点 / GET 到 POST 端点 / 请求体 > 1 MiB | `401` / `403` / `400` / `404` / `405` / `413`（逐个实测） |
| 指纹 / 文件模式 / 口令密钥 | 由 `pnpm test:cli`（58 项）与 `tests/unit` 覆盖 |

浏览器套件（smoke / header / interop / offline）与本 API 无关，不在上表范围内。

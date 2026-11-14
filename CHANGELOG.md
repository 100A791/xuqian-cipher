# 更新日志

本文件记录 XUQIAN 加密站 / 许七安密匣（`package.json` 的 `version`）的对外可见变更。

- 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。
- 本项目**不使用**自动生成（conventional-changelog 之类）：变更记录手写，因为"为什么改"比"改了哪些文件"更重要。
- 分类含义：`新增` 新能力 ｜ `变更` 行为变化 ｜ `修复` 缺陷修正 ｜ `安全` 与安全模型相关的改动 ｜ `文档` ｜ `工程`（构建、测试、工具链，不影响运行时行为）。

---

## [2.6.0] - 2026-10-30

> 主题：**本地部署与可编程接口**。打开浏览器就是构建产物、登录即起服务，另加只绑回环的本地 API
> 与 skill 接口；顺带把 lint 从 2112 个 error 清到 0。

### 新增

- **本地静态部署** `scripts/serve.mjs`：服务的是**构建产物** `publish/`（不是源码），只绑
  `127.0.0.1:5188`。带 MIME、`index/sw/manifest` 走 `no-cache`、带哈希资源 immutable、
  路径穿越防护、SPA 回退；端口被占**直接报错退出**，不去抢别人的端口。
- **开机自启** `…\Startup\xuqian-local.cmd`：纯 ASCII、用 `where /r` 定位脚本（避开中文路径），
  登录时拉起站点与 API；端口已在监听就跳过，重复登录不会起重复进程。
- **本地 API** `scripts/xq-api.mjs`（`127.0.0.1:5190`）：`/v1/encrypt`、`/v1/decrypt`
  按**输入形态**分派——`inputs`（文件）→ 输出文件，`text`/`token`（数据）→ base64url 字符串；
  同时给两者返回 400。另有 `/v1/encrypt-text`、`/v1/decrypt-text`（等价别名）、
  `/v1/keygen`、`/v1/inspect`、`/v1/verify`、`/v1/auth`、`/v1/health`、`/v1/methods`。
- **凭据**：长期 **API Key**（`xq_…`，磁盘只存 sha256；`pnpm keys add/list/revoke/path`
  管理，每请求重读，吊销立即生效）+ **会话令牌**兜底（每次启动随机，写在 `%TEMP%`）。
- **加密方式可选**：`layers` 1~10 层、5 种算法（AES-128/256-GCM、ChaCha20、XChaCha20、SM4-GCM）；
  支持**口令保护的密钥**（`keyPassword`）。
- **解密选项**：`checkOnly`（只验密钥与首块认证、不返回明文）、`expectAlgorithm`/`expectLayers`
  （钉死算法链）、`out`/`force`。
- **skill 接口**：`~/.dsh/skills/xuqian-crypto/SKILL.md`（仓库外），端口优先、CLI 兜底。
- **meta CSP**：`default-src 'none'` + 同源脚本/样式/worker。刻意**不写** `frame-ancestors`
  ——写在 `<meta>` 里浏览器会直接忽略，留着只会变成虚假防护。

### 变更

- 启动方式：从「双击 `start-xuqian.bat` 起开发服务器」改为**本地部署 + 开机自启**；
  `start-xuqian.bat` 保留为开发模式入口，旧的 `xuqian-dev.cmd` 已删除（它会与 5188 抢端口）。
- API 安全：任何带 `Origin` 的请求一律 403；请求体上限 1 MiB；只监听回环地址。

### 修复

- 数据模式解密（`/v1/decrypt-text`）漏传 `--json`，导致调用方拿不到结构化结果。
- `publish/` 内嵌版本落后于 `package.json`（重新构建 + `site:sync` 后一致）。
- `scripts/lib/browser-harness.mjs` 使用 `existsSync` 却未导入（等待下载落盘的轮询会直接
  `ReferenceError`）。

### 文档

- 新增 **`docs/API.md`**：端点、鉴权、请求字段、响应示例、错误码、安全边界，全部配实测结果。
- README 文档表、文档索引页、`sync-docs` 的文档清单同步收录。

### 工程

- **lint 归零**：`eslint .` 从 **2112 error** 到 **0**。其中 2082 个来自 `publish/` 构建产物
  被当源码检查（已加 ignore），其余 30 处逐项修（未使用导入/变量、空 catch、三元表达式当语句等），
  并删掉 `scripts/smoke.mjs` 里一段什么都不做的空循环。
- 测试与构建基线不变：tsc 0 / vitest 102 / 自研 15 套 234 项 / CLI 58 / build 64 文件可复现。

---

## [2.5.0] - 2026-10-17

> 主题：**更新日志功能**。工具箱新增「更新日志」面板，展示每个版本的完整更新内容。

### 新增

- **更新日志面板**（`ToolsTab` 内，`ChangelogPanel`）。数据源是仓库根 `CHANGELOG.md`，
  经 Vite `?raw` 打包进应用（`src/app/changelog.ts` 运行时解析）——发版只改 CHANGELOG.md
  一处，网页自动跟进；**离线（PWA）也可查**。当前版本默认展开并带「当前运行」徽标，
  旧版本折叠；粗体用微型渲染器处理，表格/代码等续行按原文纯文本展示，不引入 Markdown
  渲染器（无 XSS 面）。版本号来自 `package.json`（打包期读取），与 CHANGELOG 的对应关系
  由 `pnpm release` 的护栏保证。

### 测试

- `changelog.test.ts`（4 项）：**直接吃真实 CHANGELOG** —— 版本顺序与日期、2.4.0 条目
  含时间锁、2.3.0 的表格续行不丢失、当前版本标记精确、空输入容错与 `splitBold`。
  单元测试 98 → **102**。

---

## [2.4.0] - 2026-10-17

> 主题：**时间锁（基于时间戳验证）**。加密时可设「生效时间」与「到期时间」，
> 解密端在解出任何明文之前强制校验。格式向后兼容：新 flag `0x10`，旧文件行为不变。

### 新增

- **时间锁**。加密端 UI（`EncryptTab` 新增"生效时间"输入，原"到期提醒"升级为"到期时间"）
  与 CLI（`--not-before`）都可写入 `meta.nbf` / `meta.exp`；任一存在即置位
  `HEADER_FLAG_TIMELOCK = 0x10`。解密端（Worker / CLI 共用的 `decryptStream`）在**解开 meta
  之后、解开任何密文块之前**用当前时间戳校验，闭区间 `[nbf, exp]` 之外抛
  `TimeLockError`（`TIMELOCK_NOT_YET` / `TIMELOCK_EXPIRED`）——明文一个字节都不会被解出。
- **自检提前告知**：`keyCheck` 不再抛时间锁异常，改为返回
  `timelock: { enforced, exp, nbf }`；解密页自检结果直接显示"时间锁：某时刻前/后不可解密"，
  用户在点解密之前就知道窗口。

### 变更

- **`encrypt.expires` 语义升级**：旧版是"到期后仅提示"，新版对**打上 0x10 位的新文件**是
  "过期后拒绝解密"。兼容性：没有 `0x10` 位的旧文件即使带 `meta.exp` 也保持仅提醒语义，
  不会因升级突然解不开（有专项测试钉住）。
- CLI 加密新增 `--not-before <ISO时间>`；CLI 解密遇到时间锁拒绝时输出人话而不是错误码。

### 修复

- **CLI 直跑 `.ts` 时崩溃**（本轮引入并当场修复）：`TimeLockError` 最初用了 TS 构造函数
  参数属性（`constructor(readonly code)`)——CLI 是让 Node 直接跑 `.ts`（类型擦除模式），
  参数属性属于"不可擦除语法"，模块加载即崩，8 个 CLI 测试全红。已改为显式字段声明并留注释。
  教训：`cli/` 目前不在 tsc 检查范围（`tsconfig.app.json` 只含 `src`），曾尝试纳入检查但
  CLI 是松类型风格（几十处隐式 any），纳入属独立重构，暂缓。

### 必须诚实说明的局限

时间锁基于**本机时钟**（纯前端没有可信时间源，本站承诺零网络请求），修改系统时间即可绕过。
它的定位是"防手滑 + 跨设备约定"（例如"密钥明天才交给对方"），**不是对抗性访问控制**。
真正的强制自毁（文件头里烧死到期时间、到点自毁）纯前端做不到。

### 文档

- `docs/FORMAT.md`：新增 flags `0x10` 说明（§2.4.2）、`meta.nbf` 字段、meta 写作顺序更新。

### 本轮验证记录（2026-10-17，2.4.0）

| 项目 | 结果 |
| --- | --- |
| 类型检查 | ✅ 0 错误 |
| Vitest | ✅ **98/98**（新增 `timelock.test.ts` 6 项：过期拒绝 / 未生效拒绝 / 闭区间端点 / 无字段不加位 / 默认真实时钟 / keyCheck 返回窗口） |
| 兼容性 | ✅ 专项测试：无 `0x10` 位的旧文件带 `meta.exp` 仍可解 |

---

## [2.3.0] - 2026-10-17

> 从 2.2.0 升级：无破坏性变更，`.XUQIAN` / `.XUQIANKEY` 格式与密钥语义完全不变。
> 本次的重点是**可用性**（PWA 离线、刷新保护）与**可验证性**（CI、端口卫生、离线验证）。

### 新增

- **PWA 离线壳**。构建时由 `vite.config.ts` 生成 `dist/sw.js`（模板在 `scripts/sw-template.js`），
  预缓存本次构建的全部 hashed 产物；导航请求 network-first，离线回退到缓存。
  于是断网（或纯离线环境）也能打开并完成加解密。**刻意不做 `skipWaiting`**：
  新版本在所有标签页关闭后生效，正在使用的页面不会因为"更新到一半"而取不到旧 chunk。
  图标由 `scripts/gen-icons.mjs` 生成（纯 Node，无第三方依赖）；`manifest.webmanifest`
  声明 standalone。Service Worker **只缓存构建产物**，不碰用户文件、明文或密钥。

- **离开页面前的确认**。密钥尚未销毁时，刷新/关闭标签页会触发浏览器确认框
  （`src/worker/client.ts`）。原实现在 `beforeunload` 里直接 `destroyKeySync()`——
  误按 F5 就是永久丢失，且没有任何挽回余地。现在只有 `pagehide`（页面确实要走了）
  才销毁密钥；用户点"取消"留在页面时，密钥必须还在。

- **CI**（`.github/workflows/ci.yml`）。每次 push / PR 跑：文档数字守卫 → ESLint →
  Prettier → 类型检查 → Vitest → 构建；真浏览器套件（冒烟 / 文件头 / 互操作 / 离线壳）
  放在手动触发的 `e2e` job。此前 234 + 119 + 27 项断言只存在于本机，没有任何自动执行入口。

- **离线壳验证**（`scripts/verify-offline.mjs`，`pnpm test:offline`，5 项）。真构建、真 preview、
  用 CDP 把网络切成 offline 后刷新，断言外壳仍能启动、且**断网状态下还能完成一次文本加密**。
  这条同时把"加密不依赖网络"从声明变成了可复现证据。

- **调试端口卫生**（`scripts/lib/devtools.mjs`）。`assertPortFree()` 在启动浏览器前检查端口，
  被占用就**直接报错退出**并提示用哪个环境变量换端口；`closeBrowser()` 用 CDP `Browser.close`
  真正关浏览器、等端口释放后再删临时 profile。四套浏览器脚本的端口均可用
  `XQ_SMOKE_PORT` / `XQ_INTEROP_PORT` / `XQ_HEADER_PORT` / `XQ_OFFLINE_PORT` 覆盖。

- **一键启动 `start-xuqian.bat`**。双击即完成：检查 node / pnpm（含 Node ≥ 20.19 与 corepack
  兜底）→ 缺依赖自动 `pnpm install` → 在独立窗口启动 dev server → 轮询到 `200` 后**自动打开
  浏览器**；端口已在跑时只开浏览器。所有失败分支（缺 node、旧 node、缺 pnpm、安装失败、
  超时未起）都有可读指引。原 `start-xuqian.cmd` 改为 3 行转发文件，旧快捷方式继续可用。
  脚本刻意保持纯 ASCII + CRLF（历史教训：中文注释 + chcp 会让 cmd 把 rem 行当命令执行）。
  调试开关：`XQ_NO_BROWSER=1`（不开浏览器）、`XQ_NO_WINDOW=1`（服务器窗口最小化）。

- **PWA 更新提示条**（`src/components/UpdateBanner.tsx`）。SW 不做 skipWaiting，新版本停在
  waiting；`src/app/pwa.ts` 在检测到 waiting（注册时已有 / updatefound→installed）时广播
  `xq-sw-update`，横幅给出「立即刷新 / 稍后」。文案明确提醒：刷新会销毁未备份的密钥；
  「立即刷新」走的仍是 `beforeunload` 确认，不会绕过密钥保护。

- **离线手册**。SW 安装时在预缓存构建产物之外，"尽力而为"地缓存 `docs/*.md` 纯文本
  （不含截图，量很小；缺任何一篇不影响离线壳本身）。断网也能查格式规范和安全模型。
  `verify-offline` 相应加到 **6 项**（断网 `fetch('./docs/FORMAT.md')` 必须可读）。

- **全局错误边界**（`src/components/ErrorBoundary.tsx`）。此前全站没有任何 `ErrorBoundary` /
  `componentDidCatch`，任一路由在渲染期抛异常就会白屏；而本站是加密工具，白屏时用户**无法区分**
  "界面崩了"与"密钥被销毁了"。新的崩溃页把这两件事明确分开，并说明：主密钥仍在 Worker 内存中、
  界面崩溃不会把它写入磁盘或上传、**未备份密钥时先不要刷新**（刷新即彻底销毁密钥）。
  崩溃页刻意不依赖 store / i18n / 共享组件，避免在崩溃时二次抛错。

- **文档数字守卫**（`scripts/check-counts.mjs`，`pnpm test:counts`）。把文档里手写的实测数字
  变成断言：截图口径、Vitest 用例数、自研套件数与断言数、以及"分项之和必须等于总数"的结构性校验。
  同时校验跨文档一致性（同一数字在多篇文档中必须相同）。已接入 `pnpm test:all`。
  动机：这些数字已经漂移过两次，上一次是人工改对的，结果又漂了 —— 手改治不住。

- **双语字典完整性测试**（`src/app/i18n.test.ts`，4 项）。`translate()` 在英文键缺失时会
  **静默回退到中文**，而 `MessageKey` 从中文表推导，TypeScript 不会拦住"只在中文表加键"。
  现在键集合不一致会直接让测试变红。

- **提交前钩子**（`scripts/hooks/pre-commit` + `pnpm hooks:install`）。提交前跑三件事：
  文档数字守卫 → 类型检查 → 单元测试（约 4 秒）。刻意**不含**冒烟测试（需要真实浏览器与开发服务器）
  与自动格式化（格式重排应当是独立提交）。绕过方式：`git commit --no-verify`。

- **Prettier 与 ESLint 配置**（`.prettierrc.json` / `.prettierignore` / `eslint.config.js`）
  与对应脚本 `pnpm format`、`pnpm format:check`、`pnpm lint`、`pnpm lint:fix`。

### 变更

- **工具箱（ToolsTab）改为按需加载**（`src/App.tsx`）。Shamir 分片 / 密钥轮换 / 日志 / 设置
  不是首屏必经路径，拆成独立 chunk 后：主包 414.28 → **405.43 kB**（gzip 138.12 → **136.03**），
  新增 `ToolsTab-*.js` 10.86 kB（gzip 3.92）按需 chunk。四个主 Tab 共用同一个 Suspense 兜底
  （i18n 键 `common.loading`）。

- **默认调试端口避开 9333**（smoke 9411、interop 9412、header 9413、offline 9414）。
  原因见「修复」第一条。

- **`version` 提升到 2.3.0**，`packageManager` 固定为 `pnpm@11.7.0`。

- **自研加密路线改为按需加载**（`src/App.tsx`）。两条路线此前都是静态导入，导致选择「简单加密」的
  用户也要下载整个自研路线（含 AI 检测的 FFT/DWT）。改为 `React.lazy` + `Suspense` 后，
  `vite build` 实测（同一台机器、同一套依赖）：

  | | 主包 | gzip |
  | --- | --- | --- |
  | 改前 | 484.43 kB | 162.66 kB |
  | 改后 | **414.06 kB** | **138.01 kB** |

  首屏 **−70.4 kB raw / −24.7 kB gzip（−15.2%）**。自研路线拆成约 13 个按需 chunk
  （`SelfAiPage` 18.99、`selfWorkerClient` 13.58、`fail` 12.02 kB …）；
  选路线二的用户总下载量基本不变，只是分成两步。新增 i18n 键 `sc.loading` 作为加载占位文案。

- **启动脚本收敛为单一入口**：删除 `启动加密站.cmd`，只保留 `start-xuqian.cmd`。
  被删的那个是旧版：中文文件名（`start-xuqian.cmd` 自己的注释就写明"中文名 .cmd 经
  explorer.exe 启动会失败"）、缺依赖不会自愈、`netstat` 少了 `2>nul`。
  如确需恢复：`git checkout -- "启动加密站.cmd"`。
  `start-xuqian.cmd` 另新增：`pnpm dev` 失败时给出可读诊断（见下方"已知环境陷阱"）。

### 修复

- **浏览器套件「等待超时: 页面加载完成」的真因（不是"顺序耦合"）**。2026-10-17 复检抓到现场：
  端口 9333 被 IDE 内置的 headless 预览浏览器占着（命令行 `--user-data-dir=...\Temp\wbcdp_run`），
  而 `waitForDevtools()` 只判断 `/json/version` 是否 200，**不校验这个实例是不是自己启动的**，
  于是连到对方的 `about:blank` 上等 60 秒。同一份脚本把端口换成 9411 后 **119/119 全绿**；
  上一轮那两条"回归"（水印页元素缺失、找不到 `.XUQIAN` 下载按钮）也随之消失——它们是错连页面后的级联误报。
  现在启动前用 `assertPortFree()` 直接报错，不再四处静默复用别人的浏览器。

- **测试收尾没有真正关掉浏览器**。`browser.kill()` 在 Windows 只杀启动器，而 `finally` 紧接着
  `rmSync(workDir)` 把仍在运行的浏览器 profile 删掉——下一次运行更容易命中陈旧实例。
  现在统一走 CDP `Browser.close`，**等端口释放后**再删临时目录。实测跑完后
  `remote-debugging-port=9411..9414` 的残留进程为 **0**。

- **`sync-docs` 失败会删掉半个 `public/docs`**。原实现先 `rmSync(outDir, { recursive: true })` 再复制：
  只要删除被中断（目录被 dev server 占用、或 safe-delete 一类 shim 拦下），就会留下"少了 index.html、
  只剩 images/"的半截目录，而且失败发生在复制之前。现改为逐文件覆盖 + 清理多余文件；
  实测在 **Node 22 + shim + vite dev 正在运行** 的最坏组合下也能成功同步。

- **冒烟测试中一条长期静默失败的断言**（`scripts/smoke.mjs`）。该断言检查开始页自研卡片里
  出现"**已经可用**"，但这句话已在 10-06 的文案改写中被替换为 `start.self.pending`
  （"…格式互不通用——两者不能互相解密"），**全仓库已无"已经可用"**，于是这条断言一直失败。
  断言已改为检查当前文案真正要传达的两点（`互不通用` + `不能互相解密`），标题同步。
  它没被发现的原因很直白：**冒烟测试不在任何自动化流程里**——这正是新增提交前钩子与 CI 的动机。

- **冒烟套件此前无法当门禁**（`scripts/smoke.mjs`）。「时序回归：首次『立刻点自检』未落空」
  是作者**刻意保留的最坏时序探针**，因此约一半运行会落空——2026-10-16 做了 6 次对照：
  改动版 3/3 落空、**基线 1/2 落空**（即与代码改动无关）。作者的原意本就是"抖动不该让整轮失败"，
  但原实现仍会 `exit 1`，于是套件永远是红的、不能做门禁。
  现按原意补完：落空打印为 `NOTE` 并写进 `smoke-report.json` 的备注，**不计入失败**，
  功能正常时退出码为 0。**功能正确性没有放松** —— 紧邻的「自检结论：密钥匹配」
  「自检结果带指纹」两项仍是硬检查。

- **`docs/GUIDE.md` 关于 `now-*` 截图的陈述与事实不符**。原文说这 7 张"**没有被其它文档引用**"
  （暗示可以删除），但 `docs/PROJECT-REPORT.md` 第 55、57 行**内嵌引用了** `now-06` / `now-07`，
  而且 GUIDE 自己就在附录里展示这 7 张。已改为如实说明，并提示：要清理请连同引用一起改，
  `scripts/sync-docs.mjs` 会在构建时校验 Markdown 链接、指向缺失文件会中止构建。

- **文档数字修正**：`README.md` 目录树把 `docs/images/` 的截图数写成 21（实为 31）；
  单元测试数在 4 处仍写 88（新增 i18n 测试后实为 92）。

- **`pnpm test:header` 此前是坏的（三处失效叠加，2026-10-17 复验发现并修复）**。
  该脚本挂在 `test:all` 里，却一直没被跑过 —— 下面 3 个问题各自都足以让它失败：
  1. **没有处理开始页**（路线二选一）→ 主界面未挂载，`[role=tab]` 为空 →
     `Cannot read properties of undefined (reading 'click')`。
  2. **把文件起点当成容器起点**。文件布局是 `[明文声明前导区] ‖ [加密容器]`，
     脚本却按文件偏移读 `version`/`headerLen`，于是从声明正文的第二个字节开始 `JSON.parse`，
     报 `Unexpected token '证'`。现改为先解前导区、再按容器相对偏移解析。
  3. **无条件断言 `meta.n` / `meta.os`**。简单路线默认开启元数据加密后，这些字段已被移入
     `meta.x`，明文头部里读到的是 `undefined`。现按 `flags & 0x04` 分流，并在加密时改断言
     「这些字段**不得**出现在明文头部、原文件名不得出现在明文/声明区」——比断言值更强的性质。
  修完实测通过，输出可见声明前导区、容器起点、三层算法逆序、`meta.x` 存在。
  端口也从与 interop 共用的 9335 改为 9336（仅端口分工，**不解决**下面"顺序耦合"那条）。

- **文档数字再次修正（2026-10-17）**：上一轮"4 处写 88"其实只修了**守卫锚住的那几处**，
  `docs/PROJECT-REPORT.md` §6 套件表与 `src/selfcrypto/README.md` 仍写 88。已改为 92，
  并给 `scripts/check-counts.mjs` 补了两条锚点（已做负向测试：故意写错即报错）。
  教训：文档里同一个事实出现几次，就要有几个锚点；数字守卫的盲区就是"它没锚的地方"。

### 文档

- **自研 AES 侧信道的边界描述精确化**（`src/selfcrypto/README.md` §8.1、`docs/SECURITY.md`）。
  原文准确指出了 `SBOX[b]`，但漏掉两个可从源码直接验证、且**实质性减轻风险**的事实：
  ①表只有 **256 字节 S 盒**（约 4 条缓存行），**没有**经典软件 AES 的 1 KB T 表；
  ②`mixColumns` **是常数时间的**（固定 8 次迭代的 `gfMul`，无数据相关分支、不查表）——
  这正是它只有约 2 MB/s 的原因，**慢是常数时间的代价而非实现粗糙**。
  修正后把"查表型 AES"这个易被过度概括的说法收窄为准确表述："**除 S 盒查表外都是常数时间**"。
  结论不变（敏感场景仍建议走简单路线），但读者现在能自己判断风险量级。

  > 同时说明**为什么不改密码学内核**：要做真正常数时间的 AES 只能位切片或现算 `gfInv`，
  > 代价是再慢一到两个数量级（2 MB/s → 0.2~0.3 MB/s），路线二的可用性会基本消失；
  > 而这是安全关键改动，不应在没有独立评审的情况下顺手做掉。需要时请作为独立任务推进。

- `docs/TESTING.md` 补 §2.9 双语字典完整性一节（原文只记录了 8 个测试文件）。
- `docs/WORKSPACE-AUDIT.md` 增加"阅读提示"：说明该报告是**按轮次追加**的，
  §2/§3 是首轮（10-06）快照，其中"75 个文件 / 13 312 行""本机版本控制：无"已被后续轮次改变，
  同一文件里"首轮 66/66、二轮 88/88"是时间先后而非自相矛盾；当前口径以 `pnpm test:counts` 为准。

### 工程

- **发布流程**（`scripts/release.mjs`，`pnpm release [patch|minor|major|x.y.z]`）：
  bump version → 提交 → 打 `vX.Y.Z` tag。两道护栏：工作树必须干净；
  `CHANGELOG.md` 必须已有 `[x.y.z]` 小节——没有"为什么改"就不发版。

- **pre-push 钩子**（`scripts/hooks/pre-push` + `install-hooks` 现在同时安装两者）：
  push 前跑 文档同步 → 生产构建 → 离线壳验证。比 pre-commit 重（几十秒）但自包含，
  不需要开发服务器与浏览器交互。本仓库暂无远端，钩子暂不触发；配上远端即自动生效。

- **Dependabot**（`.github/dependabot.yml`）：npm 与 github-actions 每周检查。
  本仓库锁定精确版本，所以它只负责提醒，升级仍由维护者手工评估。

- **跨浏览器手工验收清单**（`docs/CROSS-BROWSER-CHECKLIST.md`）：Firefox / Safari 从未
  被自动化覆盖，这份清单把「验什么、怎么验、已知的引擎差异表」写成文档，
  与冒烟测试逐项对应。

- **互操作报告确定化**：`docs/interop-report.md` 不再写入运行时间戳与 Node/平台信息（只打印到控制台），
  随机密钥前缀（`ccaadd90…`）在写入前脱敏。连续两次运行产出**完全相同的文件**
  （md5 一致），`pnpm test:all` 不再因为重跑而把工作树弄脏。

- 新增依赖（均为 devDependencies，精确锁版本，与项目惯例一致）：
  `prettier`、`eslint`、`@eslint/js`、`typescript-eslint`、`eslint-plugin-react-hooks`、`globals`。
- 新增 `.gitattributes`，只规定 `scripts/hooks/* text eol=lf`（钩子脚本带 CRLF 会导致
  `sh` 报 `\r: command not found`）。**故意不写 `* text=auto`**：全仓行尾归一化会重写上百个文件，
  应作为独立提交处理。
- **Prettier 首次全量重排**：71 个文件，作为独立提交 `9edaf60`（提交信息注明"仅格式无逻辑改动"）。
  `.prettierignore` 刻意排除 `*.md`（手工排版的散文会被 proseWrap 切碎）、
  `tests/vectors/`（OpenSSL 生成的固定夹具）、`pnpm-lock.yaml`。重排后 tsc / 92 项单测 /
  自研 15 套 234 项（含与 OpenSSL 的双向交叉验证）全部通过，证明未改变行为。
- **`format:check` 接入 `pnpm test:all`**，并加入提交前钩子（钩子由 3 步改为 4 步：
  数字守卫 → 代码格式 → 类型检查 → 单元测试）。钩子里用 `node_modules/.bin/prettier`
  而非 `node_modules/prettier/bin/prettier.cjs`：顶层包目录在个别安装下可能缺失（本机实测确实缺失过），
  `.bin` 才是包管理器生成的稳定入口。
- 本轮提交：`4c7b134`（功能与工具链）、`9edaf60`（格式重排与门禁接线）。

### 本轮验证记录（2026-10-17，2.3.0）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `tsc -p tsconfig.app.json --noEmit` | ✅ 0 错误 |
| 单元测试 | `vitest run` | ✅ **92/92** |
| 自研路线 | `node tests/unit/run-all.js` | ✅ **15 套 / 234 项** |
| 文档数字守卫 | `node scripts/check-counts.mjs` | ✅ 通过 |
| 格式 | `prettier --check .` | ✅ 通过 |
| 构建 | `vite build` | ✅ 161 模块，主包 **405.43 kB / gzip 136.03 kB**，`sw.js` 3.55 kB |
| 端到端冒烟 | `node scripts/smoke.mjs` | ✅ **119 项、失败 0、备注 1**，退出码 0（端口 9411） |
| 文件头结构 | `verify-header.mjs` | ✅ 通过（端口 9413） |
| 互操作 | `interop-test.mjs` | ✅ **27/27**（端口 9412，**紧随 header 运行**，未复现旧的"顺序耦合"） |
| 离线壳 | `verify-offline.mjs` | ✅ **6/6**（含断网手册可读） |
| 收尾 | `netstat` / 进程检查 | ✅ 9411–9414 无 LISTENING；无残留 headless 浏览器 |

### 此前验证记录（2026-10-16，2.2.0 → 2.3.0 开发期）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `tsc -p tsconfig.app.json --noEmit` | ✅ 0 错误 |
| 单元测试 | `vitest run` | ✅ **92/92 通过**（9 个文件） |
| 自研路线 | `node tests/unit/run-all.js` | ✅ **15/15 套、234 项断言** |
| 文档数字守卫 | `node scripts/check-counts.mjs` | ✅ 通过（含负向测试：故意写错即报错） |
| 代码格式 | `prettier --check .` | ✅ 全部符合（重排后） |
| 文档同步 | `node scripts/sync-docs.mjs` | ✅ 8 篇文档 + 截图，链接校验通过 |
| 构建 | `vite build` | ✅ 159 模块，主包 414.06 kB / gzip 138.01 kB |
| 提交前钩子 | `sh .git/hooks/pre-commit` | ✅ 四步全过（并在两次真实提交中被 git 实际调用通过） |
| 端到端冒烟 | `node scripts/smoke.mjs` | ✅ **119 项、失败 0、备注 1**，退出码 0 |

**关于那条"备注"（重要，避免误判为本轮回归）**：它是
「时序回归：首次『立刻点自检』未落空」—— 作者**刻意设计的最坏时序探针**（上传密钥文件后
立即点「自检」，此时 React 可能还没拿到密钥，首次点击会静默落空）。已按作者原意改为
**备注而非失败**（理由见「修复」一节）。

本轮做了 6 次冒烟对照（改动版 3 次 / 基线 3 次）来判断它是否由本轮改动引入：

- 改动版：3 次落空；**基线：也有 1 次落空** → **属既有抖动，与本轮改动无关**。
- 同时确认该落空不影响功能：补点后「自检结论：密钥匹配」「自检结果带指纹」两项**均通过**。
- 另外，早先两次冒烟出现的"等待超时：密钥弹窗出现"是**环境干扰**：本轮 `pnpm add` 改了
  锁文件 → Vite 下次启动重新预构建依赖 → 触发页面自动重载（并有一次因沙箱批量删除保护
  直接崩溃），打断了流程。用独立 CDP 脚本针对该路径单独复现，**密钥弹窗正常出现、无异常**。
- 基线（含过期断言）为 118/119；本轮改动后仍为 118/119，且失败项从"过期断言"换成了
  这个已知抖动项 —— 过期断言那条已被修好。

### 已知环境陷阱（不是本项目的缺陷，但会浪费你的时间）

- **`pnpm dev` / `pnpm build` / `pnpm test:all` 的第一步是 `node scripts/sync-docs.mjs`。
  旧实现在这里可能*静默*崩溃或报 `safe-delete ... Some operations were aborted`**
  （pnpm 有时只打印 `[ELIFECYCLE] Command failed with exit code 3221226505`，即 `0xC0000409`）。
  根因是"先 `rmSync` 整棵 `public/docs` 再复制"：删除被 shim 或 dev server 占用打断，就留下半截目录。
  **2.3.0 已改为覆盖式同步**，本轮在 Node **22.22.2 + shim + vite dev 正在运行** 的组合下实测通过。
  排查时看 `node --version` 与 `pnpm exec node --version`（后者才是 pnpm 实际用的）；
  若仍失败，把 Node 24 置于 PATH 最前。
- **本仓库的 `node_modules` 曾被沙箱环境的安装过程部分破坏**（pnpm 只创建了目录、
  未填充内容，表现为 `Cannot find module 'debug'` 之类）。在自己机器上跑一次 `pnpm install`
  即可恢复。这也是 `pnpm lint` 目前**未能实际执行验证**的原因（见下）。
- **改了依赖之后第一次 `pnpm dev` 会重建依赖并自动刷新页面**。Vite 检测到锁文件变化会重新
  预构建依赖（日志：`Re-optimizing dependencies because lockfile has changed`），完成后触发
  `optimized dependencies changed. reloading` —— 页面会**自己刷新一次**。手动点页面时无所谓，
  但会打断任何自动化的浏览器流程。等 `node_modules/.vite/` 稳定后再跑冒烟即可。

### 待办 / 未完成

- **ESLint 仍未在本机验证**：`eslint.config.js` 已就位，但本机 `node_modules/eslint` 目录缺失
  （`.bin/eslint` 是悬空 shim），`pnpm lint` 无法启动。**已接入 CI（`quality` job）**，
  首次 CI 通过即可确认规则与配置有效；在那之前请勿把本地 `pnpm lint` 的失败当成代码问题。
- **`verify-offline` 的安装态未验证**：离线与断网加密已自动化（5/5），但"从浏览器地址栏安装为
  应用"这一步需要人工点击，未纳入自动化。手工验收：Chrome/Edge 地址栏右侧出现安装图标 →
  安装 → 断网打开 → 仍可加解密。

### 已完成（此前列为待办，2026-10-16 已做）

- **`pnpm format` 已执行**：71 个文件重排，作为**独立提交** `9edaf60`（提交信息注明"仅格式无逻辑改动"）。
  刻意排除 `*.md`、`tests/vectors/`、`pnpm-lock.yaml`；重排后 tsc / 92 项单测 / 自研 15 套 234 项
  （含与 OpenSSL 的双向交叉验证）全部通过，证明未改变行为。
- **`format:check` 已接入 `pnpm test:all`**，并加入提交前钩子（钩子现为 4 步）。
- **冒烟套件现在可以当门禁**：「时序回归」探针落空时记为备注而非失败（见「修复」一节），
  `node scripts/smoke.mjs` 在功能正常时**退出码为 0**。

---

## [2.2.0] — 2026-10-06

首个纳入版本控制基线（commit `5121a02`，166 个文件）的版本。其后 4 次提交都属于本版本内的工作：

### 安全 / 修复

- `fix(selfcrypto)`（`b0a01a9`）：修复自研路线的 **nonce 熵浪费**与**统一失败延迟失效**，
  并在文档中如实标注安全边界。
- `fix`（`020367d`）：修复 `randomUint32()` 的**位数退化** —— 原写法
  `new Uint32Array(randomBytes(4))[0]` 是逐元素复制而非 buffer 视图，取到的是首个字节，
  32 位随机性退化成 8 位。当时无生产调用方（密钥都走 `randomBytes`），未影响密钥安全；
  已改为 `DataView.getUint32`，并新增 `tests/unit/test_random.js` 钉死位数完整性。
  同一提交还消除了 `Math.random`（延时与日志 ID 改用 CSPRNG）与一批陈旧文案、文档漂移。

### 变更

- `feat(privacy)`（`3f8d32d`）：围绕数据保护定位补强 5 项能力 —— 元数据加密（默认开启）、
  空闲自动锁定、口令强度实时评估、密钥轮换向导、时间戳盐上下文。
- `refactor(format)`（`7a29b67`）：文件头保留字段正名，消除与国密 SM4 的 `FK` 常量混淆
  （`FK` 是 GB/T 32907-2016 的 16 字节算法内置常量，永不落文件；原命名 `RESERVED_FK` 属误导）。

---

## 维护约定

1. **改动"用户能感知到的行为"就必须在本文件留一条**。纯重构可以只写进提交信息。
2. 数字不要手写进文档后就不管 —— 会漂。凡属"实测数字"，请同时加进
   `scripts/check-counts.mjs` 的断言，让它自己报警。
3. 发版时把 `[未发布]` 改为 `## [x.y.z] — YYYY-MM-DD`，并在 `package.json` 提升 `version`。

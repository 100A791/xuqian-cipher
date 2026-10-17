# 工作区检查报告 · XUQIAN 加密站 / 许七安密匣

> 检查时间：2026-10-06 02:13–02:20（GMT+8）
> 检查对象：`C:\Users\xuqian\Desktop\dsh 加密网站`
> 检查方式：**独立复跑**（不采信既有文档结论）——类型检查、单测、CLI 真实往返、负向安全测试、静态审计。
> 结论一句话：**这是一个质量明显高于平均水准的纯前端加密项目；核心密码逻辑经得起复跑，主声明（无网络、无后门、密钥不落盘）经静态核验属实。发现 1 个用户可见的功能描述错误 + 若干文档计数漂移，无安全类缺陷。**

> **阅读提示（2026-10-16 补记）**：本报告是**按轮次追加**的，不是一次性快照。
> 下面 §2「规模与技术栈」与 §3 的验证表格记录的是**首轮（10-06 02:13）的实测结果**，
> 其中「`src/` 共 75 个文件、13 312 行」与「本机版本控制：**无**（`.git` 不存在）」
> **已被后续轮次改变**——现为 **82 个文件 / 14 469 行**，且已建立 git 基线（首个 commit `5121a02`）。
> 后续章节（§4 起）是二~四轮复验的内容，故同一文件内会出现"首轮 66/66、二轮 88/88"这类并存数字，
> 那是时间先后，不是自相矛盾。
> 需要**当前口径**时，以 `node scripts/check-counts.mjs` 的输出为准——它用实测值断言文档中的数字。

---

## 1. 它是什么

纯前端、浏览器本地的文件/文本加密工具，外加一个复用同一套密码内核的命令行工具。**文件与密钥都不上传**，128 位主密钥只展示一次、关闭弹窗即销毁、**没有任何找回入口**。

工作区里实际并存**两条互相独立的加密路线**（后缀都是 `.xuqian`，靠 MAGIC/版本区分，密钥互不通用）：

| | 简单加密 | 自研加密 |
| --- | --- | --- |
| 算法来源 | `@noble/ciphers`、`@noble/hashes` + 浏览器 WebCrypto | 全部自研（`src/selfcrypto/`），零第三方加密库 |
| 算法 | AES-128/256-GCM、ChaCha20/XChaCha20-Poly1305、SM4-GCM | SHA-256、HMAC、PBKDF2、AES、AES-CTR |
| 认证 | AEAD 自带 tag | AES-CTR + 整体 HMAC-SHA256（encrypt-then-MAC） |
| 层数 | 1~10 层可叠 | 不叠层，改为 3 段字节交错 + 重排 |
| 附带 | gzip、加密声明、密钥文件、Shamir 分片、CLI、二维码 | 图片水印（公开/私有层 + 有形水印）、AI 检测、本地密文库 |
| 性能 | 原生加速，快 | 纯 JS，实测 1.8~2.0 MB/s 单向 |
| 代码 | `src/crypto/` + `src/worker/` | `src/selfcrypto/` + `src/components/selfcrypto/` |

## 2. 规模与技术栈

- **技术栈**：React 19 + TypeScript 5.7 + Vite 7 + Tailwind 3 + Zustand；加解密全部跑在 Web Worker 里。
- **代码规模**：`src/` 共 75 个文件、**13 312 行**（ts/tsx/js/css）。
- **依赖规模**：`node_modules` 仅 **15 个顶层目录**（8 个运行时依赖 + 12 个开发依赖），非常克制。
- **文档**：`docs/` 8 篇 Markdown + 31 张真实截图；`public/docs/` 与 `dist/docs/` 均已同步，浏览器可直接打开。
- **本机版本控制**：**无**（`.git` 不存在，`.gitignore` 只是个空壳承诺）。

## 3. 本次实际做了什么验证

| # | 检查 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 类型检查 | `tsc -p tsconfig.app.json --noEmit` | ✅ 退出码 0，零错误 |
| 2 | 单元测试（Vitest） | `vitest run` | ✅ **66/66 通过**（5 文件，2.68s） |
| 3 | 自研路线测试 | 逐个 `node tests/unit/test_*.js` | ✅ **14 套全绿 / 220 项断言** |
| 4 | CLI 构建（帮助） | `node cli/xuqian.mjs --help` | ✅ 帮助与算法表正常 |
| 5 | CLI 密钥生成 | `keygen -o backup.XUQIANKEY` | ✅ 生成 + 指纹 `5EC3E6439620EADB` |
| 6 | **CLI 三层加密 + gzip** | `encrypt a b --layers AES-256-GCM,CHACHA20-POLY1305,SM4-GCM --gzip` | ✅ 产出 `.XUQIAN` |
| 7 | **CLI 解密还原** | `decrypt ... --keyfile` | ✅ **字节级一致**（`cmp` 通过） |
| 8 | 文件头查看 | `inspect secret.txt.XUQIAN` | ✅ 明文声明 + 元数据 + 算法链正确 |
| 9 | **错误密钥** | 用另一把密钥解密 | ✅ 统一提示「密钥错误或文件损坏」，不泄露原因 |
| 10 | **篡改 1 字节** | 翻转末尾一字节后解密 | ✅ 同样统一提示，未输出部分明文 |
| 11 | 零第三方依赖 | `grep` 非相对 import | ✅ `src/selfcrypto/` 零外部 import |
| 12 | 无网络调用 | `grep fetch/XHR/WebSocket` | ✅ 全 `src/` 零命中 |
| 13 | 密钥不落盘 | `grep localStorage/indexedDB` | ✅ 仅存主题/语言/日志；IndexedDB 仅存**密文** |
| 14 | 随机数来源 | `grep Math.random / getRandomValues` | ✅ 密码路径全部 CSPRNG；仅延时与日志 ID 用 `Math.random` |
| 15 | 既有冒烟报告 | 读 `smoke-report.json` | ✅ 内载 **119/119 通过**（2026-10-04） |

### 一个必须说明的环境干扰

`pnpm test:selfcrypto` 和 `pnpm test:cli` 这两个**汇总脚本**在本机沙箱内会**整体误报失败**。根因已定位：它们用 `spawnSync(process.execPath, …)` 再拉起一个 Node 子进程，而沙箱对该操作返回 `EBUSY`，于是子进程从未真正执行、输出为空、汇总行缺失。

- 这是**执行环境限制，不是项目缺陷**——单独运行每个测试文件全部通过（见第 3 表中第 3、5~8 项）。
- 但这暴露了一个**健壮性问题**：汇总器把"子进程没跑起来"和"测试失败"混为一谈，输出是误导性的 `FAIL … （无汇总行）`，而不是"无法启动子进程"。建议汇总器检查 `run.error`，把启动失败单列为一种结果。

## 4. 架构与安全审计（逐条核验）

### 4.1 密钥生命周期 —— 核验通过

- 主密钥的**唯一权威副本**在 `src/worker/crypto.worker.ts` 的 `masterKey` 里；`src/worker/client.ts` 明确不写任何持久化。
- `key-destroy` 命令会 `MasterKey.destroy()` 覆写字节并置 `null`；`requireKey()` 随后抛 `KEY_NOT_AVAILABLE`。`pagehide`/`beforeunload` 还会兜底同步销毁。
- 诚实边界写得清楚：**JavaScript 字符串无法擦除**，所以 Hex/Base64 文本副本只能等 GC——这一点项目自己写在注释和文档里，没有粉饰。

### 4.2 加密容器（简单路线）—— 设计合理

- 明文声明前导区（收件人免密钥可读）与加密容器分离；声明的长度与 SHA-256 写进加密头部并**参与 AAD**，所以「删声明 / 改声明」会导致解密失败——"声明不可删"是密码学强制的，不只是界面限制。
- 每层独立 HKDF 子密钥、每块独立 nonce、块内 tag 布局可逆；头部另有 CRC32 做快速定位。
- 值得称道的一点：`canonicalHeader()` 用**重建**的固定字段顺序对象参与 AAD/CRC，因此磁盘 JSON 的空白排版与顶层键顺序不进认证，只有 `meta` 内部键顺序进认证——这个边界处理得很细（也是踩过坑后的修正）。

### 4.3 自研路线 —— 零依赖且"诚实"

- `src/selfcrypto/` 真有 8 个算法模块 + 格式层 + 水印 + AI 检测 + IndexedDB，不是空壳：`frequency.js` 里有真实的 2D FFT（基数-2 Cooley-Tukey）和 Haar DWT。
- 测试向量由 `tools/gen_vectors.js` 用 `node:crypto`（OpenSSL）**独立生成**，而非手抄；文件加解密还与 OpenSSL 做了**双向交叉验证**。
- 文档如实记录了被测试抓出的真 bug（`Buffer.slice` 是视图不是副本；段重排后必须按长度切分）。这种"把自己的坑写下来"的做法在个人项目里少见。

### 4.4 主声明核验表

| 声明 | 核验方式 | 结论 |
| --- | --- | --- |
| 文件和密钥永不上传 | 全 `src/` grep 网络 API | ✅ 零命中 |
| 密钥从不落盘 | grep 存储 API + 逐点阅读 | ✅ 属实 |
| 不提供找回入口 | 阅读 worker/client 全部密钥分支 | ✅ 属实 |
| 密钥错误与篡改统一提示 | 真实 CLIm负向测试 | ✅ 属实 |
| CSP 禁止外部资源 | 阅读 `index.html` | ✅ `default-src 'none'`，仅同源 |
| 自研路线零第三方依赖 | grep 非相对 import | ✅ 属实 |

## 5. 发现的问题

### P1 · 用户可见的功能描述与实现矛盾（建议尽快修）

`src/app/i18n.ts` 第 152 行（及英文对应第 472 行）在「算法与状态」页定义了一条**已知缺口**文案：

```
'频域只实现了 8×8 DCT，FFT / DWT 未实现；PRNU 只到残差强度。'
```

但 `src/selfcrypto/ai/frequency.js` **已实现** FFT（2D，基数-2，含与朴素 DFT 逐点对照的测试）与 Haar DWT 2 级，`PROJECT-REPORT.md` 也把该项标注为"已闭环（D37）"。

- 后果：页面（`SelfStatusPage.tsx` → 已知缺口列表）向用户**低报**了自身能力，与应用实现、文档三处互相打架。
- 修法：把该文案改为"FFT / DWT 已实现并纳入频域分；PRNU 只到残差强度"，中英两处同步。

### P2 · 文档计数漂移（不影响功能，但会削弱文档可信度）

| 指标 | 文档声称 | 实测 | 差异 |
| --- | --- | --- | --- |
| 浏览器冒烟条目 | 116（README §测试、`docs/TESTING.md`） | `smoke-report.json` = **119** | 少报 3 |
| `test_watermark` 断言 | 21 | **29** | 少报 8 |
| `test_storage` 断言 | 13 | **19** | 少报 6 |
| 自研合计 | 220（但表格逐行相加只有 206） | **220**（逐项相加） | 表格自身不自洽 |

建议以"生成式"方式更新：把各套件断言数从测试输出自动写回文档，杜绝手抄漂移。

### P2 · 版本号与里程碑表述

`package.json` 版本为 **2.1.0**，而 `PROJECT-REPORT.md` 用 "v2.2" 描述一批已完成的里程碑。两者不是同一语义，但并列出现容易让人误判当前版本，建议统一口径（例如在报告里注明 "package 2.1.0 / 里程碑 v2.2"）。

### P2 · 无版本控制

`.git` 不存在。一旦改坏，**无法按行回退**——这一点项目文档已自认，但风险实际存在。强烈建议 `git init` 并至少提交一次基线。

### P2 · SPEC 的 `FK` 字段未定义（**已定案**）

自研格式头部有 2 字节 `RESERVED_FK`，SPEC 全文只出现名字、没有定义。当时按最保守默认处理：**保留槽位、强制为 0、非零即拒绝解析**。

**用户已裁定（2026-10-06）**：该 `FK` 指**国密 SM4 标准（GB/T 32907-2016）的系统参数** —— 算法内置常量、16 字节、不落文件，与文件头这 2 字节无关。因此字段已正名为 `RESERVED`（错误码 `RESERVED_FIELD_UNSUPPORTED`），误导性的 `FK` 命名已全部清除。详见第 8 节。

### P3 · 非加密路径使用 `Math.random`

`src/selfcrypto/common/delay.js`（4~5 秒统一失败延时）与 `src/app/store.ts`（日志条目 ID）使用 `Math.random`。

- 两者**都不是**密码用途，不构成安全问题；但 SPEC 有"随机数只用 CSPRNG"的强约束，严格读法下会被算作违规。建议要么改用 `crypto.getRandomValues`，要么在注释里显式声明"非安全用途、豁免"。

### P3 · 未复跑的能力（非缺陷，属检查覆盖空白）

- **浏览器冒烟测试**（真实 Edge + CDP，需先起 dev 服务器）本次未复跑，采用工作区既有 `smoke-report.json`（119/119，早于本次检查数小时）。要独立确认需在有浏览器的交互式环境执行。
- **Firefox / Safari 从未验证**（项目文档已自认），浏览器覆盖只有 Chromium 系。

## 6. 结论与建议

**结论**：项目的主体价值——"纯前端、可验证、不打折扣的加密工具"——是成立的。核心密码逻辑、密钥生命周期、失败处理、零网络/零依赖这几条硬声明，经独立复跑与静态审计**均属实**。没有发现安全类缺陷。

**优先处理（成本低、收益直接）**：

1. 修 `sc.status.gap2` 文案（P1，5 分钟，纯文本）。
2. `git init` 并提交基线（P2，一次性投入，止损）。
3. 校准文档计数（P2，建议改成脚本自动回写）。
4. 汇总测试脚本区分"子进程启动失败"与"用例失败"（第 3 节的健壮性问题）。

**需要你决策（已解决）**：

- ~~SPEC 的 `FK` 到底怎么定义（D3）~~ → 已确认指 **国密 SM4 的系统参数**；文件头字段正名为 `RESERVED`。
- ~~自研路线的 PBKDF2 是否真要用 RFC 6070（需解禁 SHA-1，D6）~~ → 决定**维持** PBKDF2-HMAC-SHA256 向量，不引入 SHA-1。

**长期**：自研密码代码未经第三方审计，项目自己标注"不应上线公网"——这个判断应当保持。

---

## 7. 修复记录（2026-10-06 02:25）

第 5 节列出的问题**已全部处理**。下表为逐项动作与验证方式。

| # | 原问题 | 处理 | 落点 |
| --- | --- | --- | --- |
| P1 | `sc.status.gap2` 称 FFT/DWT 未实现 | 改为如实描述（三种变换均已实现并纳入频域分，仍缺真 PRNU）；**同时发现并修正同类陈旧项 `gap3`**（元数据扫描已支持 WebP + HEIC/AVIF 标记扫描） | `src/app/i18n.ts`（中英各 2 处） |
| P1′ | 开始页文案 `start.self.p3` 称水印/AI 检测"规划中" | 改为"另有图片水印与 AI 检测"，如实描述已交付能力 | `src/app/i18n.ts`（中英各 1 处） |
| P2 | 冒烟条目 116 → 实测 119 | 全部校准 | `README.md`、`docs/TESTING.md`(×2)、`docs/PROJECT-REPORT.md`(×2)、`src/selfcrypto/README.md`(×2) |
| P2 | `test_watermark` 21→29、`test_storage` 13→19 | 校准；并补上缺行 | `src/selfcrypto/README.md`、`docs/TESTING.md` |
| P2 | 自研合计表格逐行相加 206 ≠ 声称 220 | 校准为实测 **15 套 227 项**（见下方新增套件） | `docs/PROJECT-REPORT.md`(×3)、`docs/TESTING.md`(×2)、`src/selfcrypto/README.md` |
| P2 | `package.json` 2.1.0 与里程碑 v2.2 易混 | 版本号对齐为 **2.2.0** | `package.json` |
| P2 | 无版本控制 | `git init` + 基线提交（166 文件；忽略 `node_modules`、`dist`、`public/docs`、`.dsh-meow`、`.workbuddy`）。**注意**：仓库身份暂设为 `xuqian <xuqian@localhost>`，请按需 `git config` 修改 | `.git/`（新建）、`.gitignore` |
| P2 | 汇总器把"子进程没启动"误报成"用例失败" | 检查 `run.error`，单列 `ERROR` 并给出环境提示（"请在有权限派生子进程的普通终端重跑"） | `tests/unit/run-all.js`、`scripts/cli-test.mjs` |
| P3 | `Math.random` 用于延时与日志 id | 统一改走 CSPRNG：`delay.js` 用 `randomInt`，`store.ts` 日志 id 用 `getRandomValues` | `src/selfcrypto/common/delay.js`、`src/app/store.ts` |
| P2′ | i18n 键数文档写 194 / 304 | 校准为实测 **314**（中英各 314，逐键对齐已核） | `docs/PROJECT-REPORT.md`(×2) |
| P2′ | `engines` 与 `bin` 冲突条目已过期 | 改写为如实描述（`bin` 已指向启动器；残留的只是"装得上、CLI 跑不了"） | `docs/PROJECT-REPORT.md` |

### 修复过程中**新发现并修掉的一个真 bug**（值得单独记一笔）

把统一失败延时从 `Math.random` 改为 `randomInt` 后，`test_uniform_delay` 立刻从 7/7 变成 6/7，报"覆盖范围应接近整个区间，实际跨度 255"。

根因在 `src/selfcrypto/crypto/random.js`：

```js
// 错误：用 TypedArray 作参数构造 `new Uint32Array(typedArray)` 是【逐元素复制】，
// 不是 buffer 视图。randomBytes(4) 是长度 4 的 Uint8Array，于是得到 4 个各自 0~255 的元素，
// [0] 只是第一个字节 —— 32 位随机性退化成 8 位。
export function randomUint32() { return new Uint32Array(randomBytes(4))[0] }
```

- **实测确认**：连续 2000 次调用，最大值恒为 **255**。
- **影响面**：`randomUint32`/`randomInt` 此前**没有任何生产调用方**（密钥材料都直接走 `randomBytes`），所以**未影响任何密钥/水印/分块逻辑**；这是一个潜伏 bug，不是泄露。
- **修复**：改用 `new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)`。
- **回归防护**：新增 `tests/unit/test_random.js`（7 项断言），用"最大值必须超过 255、且至少出现一个 ≥ 2^31 的样本"把位数完整性钉死；已注册进 `run-all.js`，自研路线因此由 14 套 220 项升为 **15 套 227 项**。

### 修复后的复验结果

| 检查 | 结果 |
| --- | --- |
| `tsc --noEmit` | ✅ 0 错误 |
| `vitest run` | ✅ 66/66 |
| 自研路线 15 套 | ✅ **全绿，227 项断言** |
| `docs:sync` | ✅ 通过（无死链） |
| `vite build` | ✅ 154 模块，产物正常（有 1 条 chunk 提示，见下） |
| CLI 真实往返（2 层 + gzip，300 KB 随机文件） | ✅ 字节级一致 |

### 两个环境坑（与本项目无关，但会让人误判，记录备查）

本次检查用的**托管 Node 22.22.2** 有两个静默失败点，都会让"项目看起来是坏的"，实际换到项目文档指定的 **Node 24** 全部正常：

1. **`spawnSync` 自我派生返回 `EBUSY`** —— 导致 `pnpm test:selfcrypto` / `pnpm test:cli` 整体误报失败（已按第 7 节改造汇总器，现在会明确提示是环境问题）。
2. **`fs.cpSync(dir, dest, { recursive: true })` 静默退出 127、无任何输出** —— 导致 `docs:sync` 失败，进而 `pnpm build` 整条链在第一步就断掉。单文件 `cpSync` 正常，只有**目录递归**会崩。

> 这两条都不是代码缺陷：`sync-docs.mjs` 只用了 `node:fs`；同样的脚本在 Node 24 上输出「已同步 8 篇文档 + 截图（链接校验通过）」。建议在普通终端用 Node 24 执行 `pnpm build` / `pnpm test:*`。

**构建期的一条非致命提示**（未处理，留给作者判断）：`src/selfcrypto/watermark/extract.js` 被 `ai/report.js` 动态 import、同时被 `SelfWatermarkPage.tsx` 静态 import，Vite 提示"动态 import 无法把它拆到独立 chunk"。功能无影响，只是分包未达最优；若要消除，可把界面那侧也改成动态 import。

---

## 8. 用户裁定与随之而来的改动（2026-10-06 02:35）

第 6 节末尾留给用户的两个决策已裁定，据此完成一轮改动。

### 裁定 1 —— `FK` = 国密 SM4 标准的系统参数

据此确认：文件头偏移 10 的那 2 字节与 `FK` **毫无关系**（SM4 的 `FK` 是 `a3b1bac6 56aa3350 677d9197 b27022dc`，16 字节的算法内置常量，永不落文件）。原命名 `RESERVED_FK` 属误导，已全面正名：

| 落点 | 改动 |
| --- | --- |
| `src/selfcrypto/file/format.js` | 偏移表 `RESERVED_FK` → `RESERVED`；序列化/解析注释同步；错误码 `RESERVED_FK_UNSUPPORTED` → `RESERVED_FIELD_UNSUPPORTED` |
| `tests/unit/test_format.js` | 用例名与断言改用 `OFFSETS.RESERVED` / `RESERVED_FIELD_UNSUPPORTED` |
| `tests/unit/test_interrupt.js` | 篡改用例标签改为"保留字段写 1" |
| `src/selfcrypto/common/constants.js` | `UNCONFIRMED` 移除「FK 包装后的字节布局」（9 → 8 项）并注明定案理由 |
| `src/app/i18n.ts` | 状态页键 `sc.status.pending` → `sc.status.specParams`，中英重写；告警 tone `warn` → `info`；`vectorNote` 补上"15 套 227 项" |
| `src/components/selfcrypto/SelfStatusPage.tsx` | 引用新键；**并校准算法表的陈旧计数**（水印 21→**29**、AI 21→**45**），补齐自研路线其余 6 套 |
| 文档 | `PROJECT-REPORT.md`（6 处）、`src/selfcrypto/README.md`（头部表 / D3 / §9 对照）、本报告，全部同步 |

> 顺带核实：SM4 实现的 `FK` 与 `CK` **与 GB/T 32907-2016 逐项一致**（CK 按 `ck_{i,j} = (4i+j)×7 mod 256` 全 32 项比对通过）。也就是说命名混乱并未波及算法正确性。

### 裁定 2 —— PBKDF2 维持 HMAC-SHA256 向量，不引入 SHA-1

D6 由"替用户做的取舍"升格为**用户确认的定案**。理由：RFC 6070 校验的是 PBKDF2 的**骨架**（迭代循环 / 块索引 `INT(i)` / 逐块异或链 / 末块截断），与所用哈希无关 —— 用 SHA-256 向量验的是同一个结构，不必为跑一组向量而在最小化代码库里引入已不安全的 SHA-1。

本条判断的旁证：本项目用 OpenSSL 复算了 RFC 6070 的官方值，确认它确实是 HMAC-SHA1 向量集 ——

```
PBKDF2-HMAC-SHA1("password","salt",c=1,   dkLen=20) = 0c60c80f961f0e71f3a9b524af6012062fe037a6
PBKDF2-HMAC-SHA1("password","salt",c=2,   dkLen=20) = ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957
PBKDF2-HMAC-SHA1("password","salt",c=4096,dkLen=20) = 4b007901b765489abead49d926f721d065a429c1
```

**改动后的复验**：`tsc` 0 错误 · `vitest` 66/66 · 自研 **15 套 227 项全绿** · CLI 往返字节一致。至此 SPEC §9 的待确认参数**已无遗留**（G2/G3/G5/G7 属有意保留的已知能力缺口，性质不同）。

---

## 9. 第三轮：围绕"数据保护"定位的能力补强（2026-10-06）

> 编号修正（2026-10-17）：本节原编号为 §10，但本报告从来没有 §9（该编号自引入起就跳号）。
> 全文没有任何地方引用"本报告 §10"，故直接回填为 §9，避免读者以为漏读了一节。

### 9.1 立项依据（不是拍脑袋加功能）

用户提出"网站主要以数据保护/加密为主，能否据此完善"。复核后确认：**密码学内核已经很强**（内容机密性、密钥生命周期、完整性、零网络、内存卫生、统一失败提示六项达标），
真正的短板在**内核之外的"数据保护维度"**。据此定下 5 项，全部有源码依据：

| # | 缺口（复核证据） | 补强 |
| --- | --- | --- |
| 1 | 简单路线把 `meta.n`（原文件名）等**明文**写进文件头（`container.ts` 注释原文"非机密元数据"），而自研路线是加密的 → 两条路线不一致，且**文件名本身就是泄露源** | **元数据加密**，默认开启 |
| 2 | 无任何空闲锁定 | **空闲自动锁定** + 手动锁定 |
| 3 | SECURITY.md 要求"≥16 位随机口令"，但界面只查长度 ≥8 → **要求了却没帮用户做到** | **口令强度实时评估** |
| 4 | 改密钥文件口令须整文件重加密 | **密钥轮换**（只重封装 KEK） |
| 5 | 威胁模型只在 Markdown 里，界面无任何态势提示（次要） | 界面文案补充（未做独立态势面板） |

### 9.2 一项被拒绝的需求（重要）

用户追加要求"密钥基于时间戳生成，以及当前 IP 或 Mac 地址"。**已明确拒绝并说明理由**，因为它会把前面所有努力一次性抵消：

| 来源 | 纯前端可得性 | 结论 |
| --- | --- | --- |
| MAC 地址 | **浏览器无任何 API 可读** | 物理上做不到 |
| 当前 IP | 要拿只能请求外部服务 → 必须改 CSP、开 `connect-src`、发网络请求 | **直接推翻"本站不发任何网络请求"的核心卖点**；且 NAT 后熵极低 |
| 时间戳 | 可得 | 攻击者已知大致时间窗，熵约 20 位 |

把这三者当密钥材料 = 把 128 位随机密钥**降级成十几位可猜的量**。最终按用户选择折中为：
**只把时间戳当"附加盐"**（第 5 项），并在 UI 与 FORMAT.md 中**明确标注它不提升安全性**——因为时间戳必须明文存进文件头才能被解密端复现，公开的低熵盐不提供任何机密性。

### 9.3 实现与验证

| 项 | 落点 | 关键设计 |
| --- | --- | --- |
| 元数据加密 | `keys.ts`（MEK 派生）、`container.ts`（`sealPrivateMeta`/`openPrivateMeta`、`meta.x`）、`stream.ts`、`FORMAT.md §2.4` | 只加密**信息性**字段（`n/m/os/c/as`）；`s/h/nl/nh/k` 因解密必需保持明文；`meta.x` 参与 AAD |
| 空闲锁定 | `app/useAutoLock.ts`、`components/LockScreen.tsx`、`store.lockNow()` | 超时即 `destroyKeySync()` + 清空一次性视图与已解明文 |
| 口令强度 | `crypto/passphrase.ts`、`components/PassphraseMeter.tsx` | 熵估算 + 重复/序列/键盘步/常见口令惩罚；**并统一了 ToolsTab 原本较弱的本地实现** |
| 密钥轮换 | `ToolsTab` 新面板、`keyfile.ts` 复用 | 只重封装 KEK；主密钥与指纹不变 |
| 时间戳盐 | `keys.ts`（`context` 参数）、`container.ts`（`tsSaltContext`、`0x08` 位）、`stream.ts` | 默认关闭、默认上下文为空串 → **旧文件派生结果不变** |

**复验**（Node 24 构建）：

```
tsc --noEmit                       0 错误
vitest run                         88/88 通过（8 个文件；原 66）
自研路线                           15 套 / 227 项全绿（其后 D39 修复新增用例，已增至 234 项）
cli-test.mjs                       58/58 通过（原 55，新增加密元数据用例）
docs:sync                          通过（8 篇文档 + 截图，链接校验通过）
vite build                         成功（158 模块）
CLI 全特性往返                      --gzip --encrypt-meta --timestamp-salt + 2 层 → 解密字节一致
```

同时修正了两处**文档陈旧**：README 的"尚未实现（P2）"里仍写着"命令行工具"，但 `cli/` 早已存在且有 58 项测试 —— 已移入"已实现"。

---

## 10. 第四轮：对 `b0a01a9` 之后 4 个提交的独立复验（2026-10-17 04:24）

> 复核对象：`4c7b134`（懒加载 + 错误边界 + 工程基建）、`9edaf60`（Prettier 全量重排）、`21f863e`（更新日志）、`5b16dd7`（lockfile），HEAD = `5b16dd7`，工作树干净，`version` 2.2.0。
> 方式与前几轮一致：**不采信文档，全部重跑**。本轮特别关注两件事 —— ① 新增的"门禁"是否真的能拦住东西；② 一次 71 文件的重排有没有悄悄改动行为。

### 10.1 实测结果

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `tsc -p tsconfig.app.json --noEmit` | ✅ 0 错误 |
| 单元测试 | `vitest run` | ✅ **92/92**（9 个文件） |
| 自研路线 | 逐套跑 `tests/unit/test_*.js` | ✅ **15 套 / 234 项**，逐套明细与 `src/selfcrypto/README.md` 的表格逐行一致 |
| 文档数字守卫 | `node scripts/check-counts.mjs` | ✅ 通过（**补充锚点后**仍通过，见 10.3） |
| 端到端冒烟 | `node scripts/smoke.mjs` | ✅ **119/119**，失败 0 |
| 文件头结构 | `node scripts/verify-header.mjs` | ✅ 全部通过（**修复后**，见 10.3） |
| 浏览器 ↔ CLI 互操作 | `node scripts/interop-test.mjs` | ✅ **27/27**（单独运行时） |
| 构建 | `vite build` | ✅ 159 模块，主包 **414.06 kB / gzip 138.01 kB** |
| 静态审计 | 源码级 grep | ✅ `src/` 内无任何网络能力（`fetch`/XHR/WebSocket/sendBeacon/EventSource 全无）；`src/selfcrypto/` 无非相对 import（零第三方依赖） |

包体积与 `CHANGELOG.md` 的数字**逐个吻合**（含 `SelfAiPage` 18.99 kB、`selfWorkerClient` 13.58 kB、`fail` 12.02 kB 三个按需 chunk），说明那份记录是真跑的。

### 10.2 Prettier 全量重排：确认"只改格式"

71 个文件的机械重排最危险的地方是"看起来只是换行，其实改了逻辑"。用两条独立的证据排除：

1. `git diff 9edaf60^ 9edaf60 -w`（忽略空白）逐文件看 —— `sha256.js`（K 常量重排）、`encrypt.js`（三元表达式拆行）、`tsconfig.json`（数组压缩）**均无语义变化**。
2. `git diff b0a01a9 HEAD --stat -- tests/vectors/` **输出为空** —— 测试向量文件一个字节都没动。

第 2 条比第 1 条更关键：向量是交叉验证的"外部锚点"。**如果重排碰到了向量，测试就会变成自己和自己对齐，234 项全绿也不再意味着任何事。**

### 10.3 发现的问题

#### P2 · 文档数字仍在漂移，而且漂在守卫的盲区里（已修）

- `docs/PROJECT-REPORT.md` §6 套件表写 `| 单元测试（Vitest） | 88 |`，实测 **92**；
- `src/selfcrypto/README.md` 写"站点原有单测 88 项"，实测 **92**。

`CHANGELOG.md` 的「修复」一节声称已修正"单元测试数在 4 处仍写 88"，但**被修的恰好是守卫锚住的那几处**，这两处不在锚点内，于是漏了。这不是笔误，是结构性问题：**同一个事实在文档里出现几次，就需要几个锚点**；守卫的价值不在于它查了什么，而在于**它没查的地方会静默漂移**。

处理：两处改为 92；并给 `scripts/check-counts.mjs` 补了两条锚点（§6 套件表行、`站点原有单测 N 项`），做了**负向测试**（故意写回 88 → 报错、退出码 1），确认新锚点真的会响。

#### P2 · `pnpm test:header` 其实是坏的，而且是**三处独立失效叠在一起**（已修）

这是本轮最有价值的发现。`verify-header.mjs` 挂在 `test:all` 里，但 `CHANGELOG.md` 的验证记录表格里**没有它**——它大概从没被跑过。直接跑，依次撞上三个问题：

| # | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | `TypeError: Cannot read properties of undefined (reading 'click')` | 脚本**从未处理开始页**。开始页（路线二选一）会挡住主界面，此时 `[role=tab]` 是空数组，`.find(...)` 返回 `undefined` | 先按 `data-testid="start-simple"` 进「简单加密」（与 `smoke.mjs` 的 `enterSimpleMode()` 同一组标记），并给 tab 查找补判空 |
| 2 | `Unexpected token '证', "证加密文件 ｜ 由 "…` | 文件布局是 `[明文声明前导区] ‖ [加密容器]`（`FORMAT.md` §2.3.1），而脚本把**文件起点当成容器起点**：`version` 读到了前导区标记 `0x02`，`headerLen` 落进声明正文中间，于是 JSON 从"认证加密文件"的**第二个字节**开始切 | 先解前导区算出容器起点，容器字段改按**相对偏移**读；顺带补上"声明长度/哈希与头部 `nl`/`nh` 一致"的断言 |
| 3 | `原始文件名未正确记录（undefined）` / `原始大小…（undefined）` | 简单路线**默认开启元数据加密**，`n`/`m`/`os`/`c`/`as` 已被移出明文头部、收进 `meta.x`。原断言是**无条件**比对明文里的 `meta.n`/`meta.os` | 按 `flags & 0x04` 分流：加密时改断言「这些字段**不得**出现在明文头部，且原文件名不得出现在明文头部与声明区」——比断言字段值更强的性质 |

修完实测通过，且它现在**真的在验证安全属性**：

```
文件魔数        : XUQIAN
声明前导区      : 存在（485 字节）
容器起点        : 496
version / flags : 1 / 6 (gzip=on)
算法顺序        : SM4-GCM -> CHACHA20-POLY1305 -> AES-256-GCM   ← UI 逆序，正确
元数据加密      : 已开启（标识性字段收进 meta.x）
原始文件名      : (已加密，明文头部不可见)
meta.x 密文块   : 存在（100 字符 base64）
✅ 文件头验证全部通过（明文声明前导区、算法层栈、层数、gzip、元数据、哈希均正确写入）
```

> 这三处的共同点值得记下来：**它们都不是"实现坏了"，而是"检查坏了"**。而且失效方式完全一致——先是沉默地不报错（脚本没被跑），一跑又立刻报出一个**看起来像回归、其实是旧脚本跟不上新格式**的错误。这正好印证了 10.3 开头那条：没进自动化流程的检查等于不存在。

#### P3 · 报告章节编号跳号（已修）

本文件从 §8 直接跳到 §10，§9 自引入起就不存在。全文无任何"本报告 §10"的引用，已回填为 §9。

#### P3 · 浏览器套件之间存在顺序耦合（**未修，仅记录**）

实测可复现：**`verify-header.mjs` 跑完之后，紧接着跑任何浏览器套件（interop / smoke）都会报 `等待超时: 页面加载完成`**；单独跑则正常。两次复现，与代码改动无关。

- 已排除"共用调试端口"这个猜测：把 `verify-header` 的端口从 9335 换成 9336 后现象不变（改动保留，但只为端口分工，注释已如实写明它没解决这个问题）。
- 观察到的线索：`browser.kill()` 在 Windows 上只杀启动器进程，浏览器本体仍在（`verify-header` 还会紧接着删掉它正在使用的 profile 目录）。根因未定位。
- 影响：`test:all` 的顺序是 `smoke → header → interop`，因此**这一步组合下 interop 很可能失败**。临时绕法：两套之间留间隔或手动清残留 `msedge` 进程。

#### 环境确认（非缺陷）

- **`sync-docs.mjs` 在 Node 22.22.2 下静默失败**（无任何输出、非零退出），Node 24.21.0 正常 —— 与 `CHANGELOG.md`「已知环境陷阱」的记载一致，本轮再次实测复现。`pnpm dev/build/test:all` 第一步都是它，所以用 22 会得到"什么都没发生"的假象。
- **冒烟第一次跑到第 48 项中止**（`等待超时: 密钥弹窗出现`）：Vite 检测到锁文件变化 → 重新预构建依赖 → **页面自己刷新一次**，打断流程。依赖预热稳定后重跑 **119/119 全绿**。与 `CHANGELOG.md` 的记录完全一致，属环境干扰，不是回归。
- **沙箱内 `node tests/unit/run-all.js` 无法整体跑**（`spawnSync` 自派生 EBUSY），改用逐套调用得到 15 套 234 项。

### 10.4 结论

- **这 4 个提交没有引入回归。** 类型、单测、自研向量、端到端冒烟、互操作、构建全部独立复现通过；包体积从 484.43 → 414.06 kB 属实，懒加载确实把自研路线拆成了独立 chunk。
- **新增的工程基建取向正确**，而且做的是同一件事：**把口头约定变成断言**（数字守卫、Prettier 门禁、双语字典测试），并给"白屏 vs 密钥被销毁"这个真实歧义加了错误边界（已在 `main.tsx` 实测接入）。这与本站"诚实边界"的整体思路一致。
- **唯一的实质问题是门禁的覆盖边界**：`check-counts` 保护了被锚住的数字，于是没被锚住的数字成了盲区；`verify-header` 挂在 `test:all` 里却早已失效。两条都指向同一个教训 —— **检查本身也需要被检查**（比如"每套件最近一次通过的时间"这类元信息，比再写一条断言更有效）。
- **仍未闭环**（沿用，非本轮引入）：① ESLint 未能在沙箱验证（依赖树不完整）；② Firefox / Safari 从未验证；③ 10.3 的浏览器套件顺序耦合；④ `SELFCRYPTO-REVIEW.md` §0.5 里的 B1（是否接口令模式）、D2（主密钥是否升 256 位）**仍待用户决策，本轮未擅自更改**。

## 11. 第五轮：工作站复检与「等待超时: 页面加载完成」根因定位（2026-10-17 18:07）

> 复核对象：HEAD `5b16dd7` + **7 个未提交文件**（第四轮的修复尚未提交）。Node 24.21.0（系统）/ 22.22.2（受管，带 WorkBuddy 注入的 `NODE_OPTIONS` shim）；Edge 155。本轮**只读**，未改任何源码；唯一副作用是 `public/docs/` 被重新生成了一次（原因见 11.3）。

### 11.1 复跑矩阵

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `tsc -p tsconfig.app.json --noEmit`（Node 24） | ✅ 0 错误 |
| 单元测试 | `vitest run` | ✅ **92/92**（9 文件） |
| 自研路线 | `node tests/unit/run-all.js` | ✅ **15 套 / 234 项**（本轮可整体跑通，未复现此前记录的 `spawnSync` EBUSY） |
| 文档数字守卫 | `node scripts/check-counts.mjs` | ✅ 通过（31 / 22 / 92 / 15 / 234） |
| 格式 | `node_modules/.bin/prettier --check .` | ✅ 全部符合 |
| 构建 | `vite build` | ✅ 159 模块，主包 **414.06 kB / gzip 138.01 kB**（与 CHANGELOG 完全一致） |
| 端到端冒烟 | `node scripts/smoke.mjs`（**换到空闲端口**） | ✅ **119/119** |
| 文件头结构 | `node scripts/verify-header.mjs` | ✅ 全部通过（前导区 485B、容器起点 496、三层逆序、`meta.x` 存在） |
| 互操作 | `node scripts/interop-test.mjs` | ✅ **27/27**（紧随 header 运行，未复现"顺序耦合"） |
| 文档链接 | `node scripts/sync-docs.mjs`（Node 24） | ✅ 8 篇 + 截图，链接校验通过 |
| 静态审计 | grep | ✅ `src/` 内无 `fetch`/XHR/WebSocket/sendBeacon；无 `dangerouslySetInnerHTML`/`innerHTML=`/`eval`/`new Function`；无 TODO/FIXME |

**结论：产品侧没有回归。** 92 + 234 + 119 + 27 项断言、类型、构建、格式、文档数字全部独立复现通过。

### 11.2 「等待超时: 页面加载完成」的根因（上一轮的 P3"顺序耦合"）

上一轮记的是"`verify-header` 之后跑浏览器套件必挂，根因未定位"。本轮抓到了现场：

1. **调试端口被别的浏览器占着。** 失败时 `netstat` 显示 `127.0.0.1:9333 LISTENING`，进程命令行是：

   ```
   msedge --headless=new --remote-debugging-port=9333
          --user-data-dir=...\Temp\wbcdp_run   ← WorkBuddy 内置预览浏览器，不是本项目的
   ```

   `scripts/smoke.mjs` 的 `waitForDevtools()` **只判断 `/json/version` 是否 200，不校验这个实例是不是自己启动的**，于是连到对方的 `about:blank`，等 `#root` 等到 60s 超时。这正是 `test:all` 里那句报错的来源。

2. **同一份脚本只把 `PORT` 从 9333 改成 9347（临时副本，未入库），全套 119/119 通过。** 原先那两条"回归"也就不再出现：
   - `自研路线「watermark」页可独立打开且元素齐备 ({"shell":true,"target":false})` —— 页面源码里 `sc-wm-input` 存在，独立探针里 `target:true`；
   - `找不到 .XUQIAN 下载按钮` —— 用隔离页面复跑 `notes.txt`（4 KB / 2 层 / ChaCha20）到同一位置，按钮 `下载 notes.txt.XUQIAN` **确实在**。

   两条都是"连错页面/冷启动懒加载"下的级联假阳性，不是产品缺陷。

3. **收尾没有真正关浏览器。** `browser.kill()` 在 Windows 只杀启动器；`finally` 紧接着 `rmSync(workDir)`，把仍在运行的浏览器 profile 删掉。下一次运行更容易命中陈旧实例，或者让浏览器卡在异常状态——这是"隔一段时间就抖一次"的机制，和"套件顺序"无关。

> 影响：`test:all` 在本机（只要 WorkBuddy 预览浏览器活着）**不可用**，而它恰好是唯一的自动化入口。这不是测试写得不对，是**端口所有权没有校验**。

### 11.3 第二个环境陷阱：`sync-docs` 的整目录删除会被 safe-delete 拦截

本机 `NODE_OPTIONS` 被注入了 WorkBuddy 的 `node-language-shim.cjs`（内含 safe-delete）。用受管 Node 22 跑：

```
node scripts/sync-docs.mjs
→ Error: [safe-delete] 操作失败: ... public\docs: Error during a `trash` operation: Some operations were aborted
→ 退出码 1
```

`scripts/sync-docs.mjs:81` 是 `rmSync(outDir, { recursive: true, force: true })`。**删除先发生、复制后发生**，于是失败时 `public/docs/index.html` 已被移走、目录里只剩 `images/`（本轮实际发生，已用 Node 24 重新生成恢复）。Node 24 下同一脚本正常。

这解释了两件事：① `pnpm dev` / `pnpm build` / `pnpm test:all` 第一步就挂（它们都先跑 `docs:sync`，而 `node` 是 22）；② 挂法看起来"什么都没发生"或像原生崩溃，实际是可读的 shim 错误。

补一条本轮实测：**`vite dev` 正在运行时再跑 `sync-docs`，Node 24 也会在同一行失败**（`public/docs` 被 dev server 占用，trash 中止），停掉 dev 后立即恢复。也就是说，这个失败模式不只与 Node 版本/shim 有关——**只要目标目录被任何进程占用，就会"删了一半"**。

**项目侧可改进**（与沙箱无关，也值得做）：不要"先删整棵树再拷"，改成**逐文件覆盖 + 清理多余文件**，或写入临时目录后原子替换。这样即使中途失败，`public/docs` 也不会变成半截。

### 11.4 建议（按"能不能让门禁跑起来"排序）

> 2026-10-17 18:40 起，下列 1–3、6–8 已实施，验证结果见 §12。

**P0 · 让自动化真正可执行**

1. **调试端口可配置 + 启动前判占用**：`PORT = Number(process.env.XQ_SMOKE_PORT ?? 9411)`；启动前请求一次 `/json/version`，有人应答就报"端口 X 被占用（可能是 IDE 预览浏览器），请换端口"并退出，**不要静默连上去**。三套浏览器脚本（smoke / interop / header）同理。
2. **收尾用 CDP `Browser.close`**，等端口释放后再删 `workDir`；`browser.kill()` 只作兜底。这样 `test:all` 连跑三套不会互相污染。
3. `sync-docs` 改为覆盖式同步（见 11.3），或至少在 `rmSync` 前后加保护。

**P1 · 工程化缺口**

4. **CI**：目前 234 + 119 + 27 项只能手动跑，且没有任何远程仓库（`git remote -v` 为空）。建议至少把 `docs:sync → counts → format:check → typecheck → vitest → build` 放进 CI（E2E 可夜间跑）；本地单机 + 无远端，等于所有证据只存在于这台机器上。
5. **提交第四轮的 7 个文件**（`CHANGELOG` / `PROJECT-REPORT` / `WORKSPACE-AUDIT` / `interop-report` / `check-counts` / `verify-header` / `selfcrypto/README`）。它们现在是"已修但未入库"的状态。
6. **ESLint 仍未验证**：`node_modules/eslint` 目录缺失（`.bin/eslint` 是悬空 shim），本机无法跑；需在正常环境 `pnpm install` 后验证一次再接入门禁。
7. `docs/interop-report.md` 每次运行都会重写时间戳与环境行，制造 diff 噪声；建议标注为生成物，或把时间戳/环境移到末尾单独一行。

**P2 · 产品决策（需你拍板，未擅自改）**

8. **刷新保护**：`beforeunload` 直接 `destroyKeySync()`，没有确认框。误按 F5 = 密钥永久丢失。可加"密钥尚未备份，确定离开？"——这与"关闭即销毁"不冲突，只是把不可逆操作从"误触"里救回来。
9. **PWA / Service Worker**：纯本地工具最需要离线可用，比再加功能更贴合定位（README 已列为 P2）。
10. **跨浏览器**：至今只验证过 Edge/Chromium。至少做一次 Firefox + Safari 手工矩阵（重点：Worker、`crypto.subtle`、剪贴板、下载）。
11. **发布**：`version` 仍 2.2.0，CHANGELOG 的 `[未发布]` 建议 2.3.0；无远端 = 无备份，建议私有仓库 + tag。

## 12. 第五轮修复记录（2026-10-17 18:40–19:10）：§11 的建议已实施

> 用户裁定「全做」。本节只记**实际改动与验证结果**，不改写 §11 的复检结论（那一节是当时的现场）。

### 12.1 测试基础设施

| 改动 | 文件 | 验证 |
| --- | --- | --- |
| 端口可配置 + 启动前判占用 | `scripts/lib/devtools.mjs`（新）、smoke / header / interop | 9333 被 wbcdp 占用时 smoke 现在**立即报错并给出换端口提示**，不再等 60 秒 |
| 收尾用 CDP `Browser.close`，等端口释放后再删 profile | 同上 + `browser-harness.mjs` | 跑完 `9411–9414` 无 LISTENING、无残留 headless 进程 |
| 默认端口改为 9411/9412/9413/9414 | 三套脚本 + harness | smoke 119（118+1 备注）、header 通过、interop 27/27，**header → interop 连续跑无复现** |
| beforeunload 确认框的自动化处理 | `scripts/lib/browser-harness.mjs`、`smoke.mjs` | 三处 `Page.reload` 全部正常，未被对话框卡住 |

### 12.2 产品

- **PWA 离线壳**：`src/app/pwa.ts`、`public/manifest.webmanifest`、`scripts/sw-template.js`、
  `vite.config.ts` 的 `offlineServiceWorker()` 插件、`scripts/gen-icons.mjs`（纯 Node 生成 PNG）。
  新增 `scripts/verify-offline.mjs`（5 项）：真构建 → 真 preview → **CDP 断网** → 刷新仍启动 →
  断网下完成一次文本加密。实测 **5/5**。
- **刷新确认**：`src/worker/client.ts` 在密钥存在时 `preventDefault()`，只在 `pagehide` 销毁密钥。
  自动化里由 CDP 自动接受对话框，真实用户看到浏览器原生提示。

### 12.3 工程

- `sync-docs.mjs` 改覆盖式同步；实测 **Node 22 + shim + vite dev 运行中** 也能成功（旧实现两种组合都失败）。
- `.github/workflows/ci.yml`：`quality`（每次 push/PR：counts → lint → format → typecheck → vitest → build）
  与 `e2e`（手动触发：smoke / header / interop / offline）。**尚未在真实 GitHub Actions 上跑过**。
- `package.json` → 2.3.0、`packageManager: pnpm@11.7.0`、新增 `test:offline` / `gen:icons`，
  `test:all` 末尾追加离线套件。
- **互操作报告确定化**：去掉时间戳与环境行、随机密钥前缀脱敏；连续两次 `interop-test.mjs`
  产出 md5 相同的文件（`89d2d642…`），`test:all` 重跑不再弄脏工作树。
- 文档：README（PWA、刷新保护、体积、目录树、调试端口）、TESTING（§四 修正为元数据加密后的真实断言、新增 §四·补）、
  CHANGELOG（2.3.0）。

### 12.4 本轮全量复跑（Node 24.21.0）

```
tsc 0 错误 · vitest 92/92 · 自研 15 套 234 项 · counts 通过 · prettier 通过
build 160 模块，主包 414.28 kB / gzip 138.12 kB，sw.js 2.91 kB
smoke 119（失败 0，备注 1）· header 通过 · interop 27/27 · offline 5/5
```

### 12.5 仍未闭环

1. **ESLint 本机不可运行**（依赖目录缺失）—— 已放进 CI，等首次 CI 结果。
2. **CI 未实跑**（本地无网络/无远端），workflow 里的 preview 与浏览器路径按 Ubuntu 预装 Chrome 编写。
3. **PWA 的"安装"动作**（地址栏点安装）无法自动化，只验证了注册、接管与离线可用。
4. Firefox / Safari 仍未验证。

---

*本报告为独立复核产物，与 `docs/PROJECT-REPORT.md`（项目自述）互为补充：前者是"作者说它做到了什么"，本报告是"我从外部验证了哪些、以及哪里对不上"。*

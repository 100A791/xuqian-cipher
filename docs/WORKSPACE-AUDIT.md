# 工作区检查报告 · XUQIAN 加密站 / 许七安密匣

> 检查时间：2026-10-06 02:13–02:20（GMT+8）
> 检查对象：`C:\Users\xuqian\Desktop\dsh 加密网站`
> 检查方式：**独立复跑**（不采信既有文档结论）——类型检查、单测、CLI 真实往返、负向安全测试、静态审计。
> 结论一句话：**这是一个质量明显高于平均水准的纯前端加密项目；核心密码逻辑经得起复跑，主声明（无网络、无后门、密钥不落盘）经静态核验属实。发现 1 个用户可见的功能描述错误 + 若干文档计数漂移，无安全类缺陷。**

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

*本报告为独立复核产物，与 `docs/PROJECT-REPORT.md`（项目自述）互为补充：前者是"作者说它做到了什么"，本报告是"我从外部验证了哪些、以及哪里对不上"。*

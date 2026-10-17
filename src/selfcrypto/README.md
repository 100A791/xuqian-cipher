# 自研加密（selfcrypto）—— 设计输出与实现状态

> 本文件对应 SPEC 第 8 节要求的输出顺序：**目录结构 → 接口定义 → 核心伪代码 → 字节级文件格式表 → 测试向量清单与验收标准**。
> 每一步标注对应 SPEC 章节号。**字节级格式表暂缺**，原因见文末「待确认项」。

## 0. 与 SPEC 的路径映射

SPEC 第 2 节要求 `src/crypto/`、`src/common/` 等。本仓库已存在 AEAD 版 `src/crypto/`（站点原有的「简单加密」路线），
两条路线要**并存**（用户要求：开始页二选一、两者独立），因此自研路线整体挂在 `src/selfcrypto/` 命名空间下：

| SPEC 路径 | 本项目实际路径 | 状态 |
| --- | --- | --- |
| `src/crypto/` | `src/selfcrypto/crypto/` | ✅ 7 个算法 + `kdf.js`（我加的） |
| `src/common/` | `src/selfcrypto/common/` | ✅ SPEC 的 4 个 + `bytes.js`（我加的） |
| `src/file/` | `src/selfcrypto/file/` | ✅ |
| `src/watermark/` | `src/selfcrypto/watermark/` | ✅ |
| `src/ai/` | `src/selfcrypto/ai/` | ✅ SPEC 的 6 个 + `helpers.js`（我加的） |
| `src/storage/` | `src/selfcrypto/storage/` | ✅ `indexeddb.js`；`file_io.js` 有意不做（D28） |
| `src/ui/` | `src/components/selfcrypto/`（React） | ⚠ **偏差**：用户定「不重做界面」，改用现有 React 栈实现同样页面划分（D25）；`src/selfcrypto/ui/README.md` 就地记录映射 |
| `src/third/` | `src/selfcrypto/third/` | ✅ 按 SPEC **留空**，只有说明文件 |
| `tests/vectors/` `tests/unit/` `tools/` | 同 SPEC | ✅ 项目根下无同名目录，不冲突 |

三处额外新增文件都在上表标注了（`kdf.js` / `bytes.js` / `helpers.js`），决策记录里也各有一条。
"零第三方依赖"这条红线不靠人看：`tests/unit/test_storage.js` 会机械校验 `src/selfcrypto/` 下
**没有任何非相对路径的 import**、**没有任何网络调用**、**没有 localStorage/sessionStorage**。


## 1. 目录结构（SPEC §2、§5 阶段零/一）

```
src/selfcrypto/
  common/
    constants.js   SPEC §3 核心常量表（未定义项留 TODO，不假设）
    fail.js        SPEC §4 阶段零：统一失败出口（§7 禁止提示具体原因）
    delay.js       SPEC §3/§5：统一延迟 4~5 秒随机
    validate.js    SPEC §2：输入校验（长度/类型/取值）
  crypto/
    random.js      SPEC §4：封装 crypto.getRandomValues（§7 禁止自研随机算法）
    compare.js     SPEC §4：常数时间比较（§7 禁止非常数时间比较 MAC）
    sha256.js      SPEC §5 阶段一：FIPS 180-4 ✅ 18/18
    hmac.js        SPEC §5 阶段一：RFC 4231     ✅ 14/14
    pbkdf2.js      SPEC §5 阶段一：见下方冲突说明 ✅ 10/10 ⚠ **仅通过向量，未接入加密流程**（见 §8.4）
    aes.js         SPEC §5 阶段一：FIPS 197（密钥扩展+单块）✅ 12/12
    ctr.js         SPEC §5 阶段一：SP 800-38A   ✅ 14/14
tests/
  vectors/{sha256,hmac,pbkdf2,aes,ctr}_vectors.json   全部由 OpenSSL 生成
  unit/_helpers.js              零依赖测试基座
  unit/test_*.js                每个算法一个向量测试
  unit/run-all.js               汇总入口（pnpm test:selfcrypto）
tools/
  gen_vectors.js                用 node:crypto 生成全部向量（独立于自研实现）
```

## 2. 接口定义（SPEC §4）

### 阶段零

| 模块 | 接口 | 说明 |
| --- | --- | --- |
| `common/constants.js` | `MAGIC, VERSION, ITER, SALT_LEN, TIMESTAMP_LEN, BOOT_NONCE_LEN, KEY_CHECK_LEN, MAC_LEN, RULES_LEN_LEN, CHUNK_SIZE, SEGMENTS, SEGMENT_ORDER, SPLIT_MODE, ENDIAN, LSB_CHANNEL_ORDER, UNIFORM_DELAY_MS, UNCONFIRMED` | 全部取自 SPEC §3；§9 待确认项集中在 `UNCONFIRMED` |
| `common/compare.js` | `timingSafeEqual(a,b): boolean`、`timingSafeNotEqual(a,b)` | 长度不同也走完整循环，不提前返回 |
| `common/random.js` | `randomBytes(n): Uint8Array`、`randomUint32()`、`randomInt(min,max)` | 仅封装 CSPRNG；`randomInt` 用拒绝采样避免取模偏置 |
| `common/delay.js` | `uniformDelayMs(): number`、`uniformDelay({ms}?): Promise<void>` | 默认 4000~5000ms；`{ms}` 仅供测试 |
| `common/fail.js` | `fail(internalReason?): Promise<never>`、`failSync()`、`FAIL_MESSAGE`、`setInternalDiagnostics(fn)` | 先延迟再抛；对外只有一句文案 |
| `common/validate.js` | `assertBytes`、`assertExactLength`、`assertEnum`、`assertIntegerInRange` | 不明确即拒绝 |

### 阶段一

| 模块 | 接口 | 状态 |
| --- | --- | --- |
| `crypto/sha256.js` | `class Sha256 { update(bytes): this; digest(): Uint8Array; hexDigest(upper?): string }`、`sha256(bytes): Uint8Array`、`sha256Hex(bytes): string` | ✅ 18/18 |
| `crypto/hmac.js` | `hmacSha256(key, msg): Uint8Array`、`hmacSha256Hex(key, msg): string`、`verifyHmac(key, msg, mac): boolean` | ✅ 14/14 |
| `crypto/pbkdf2.js` | `pbkdf2Sha256(pwd, salt, iterations, dkLen): Uint8Array`、`pbkdf2Default(pwd, salt, dkLen)` | ✅ 10/10 |
| `crypto/aes.js` | `expandKey(key): {roundKeys, rounds}`、`encryptBlock(block, key): Uint8Array`、`SBOX` | ✅ 12/12 |
| `crypto/ctr.js` | `aesCtr(key, counter, data): Uint8Array`、`incrementCounter(counter)`、`counterFromNonce(nonce)` | ✅ 14/14 |

### ⚠ 与 SPEC 的一处冲突（需确认）

SPEC §5 要求 PBKDF2「跑 **RFC 6070** 测试向量」，但 **RFC 6070 是 PBKDF2-HMAC-SHA1** 的向量集；
要用它就必须实现 SHA-1，而 SHA-1 不在 SPEC §7 允许自研的算法清单里（只允许 SHA-256/HMAC/PBKDF2/AES/CTR）。
**当前处理**：改用 PBKDF2-**HMAC-SHA256** 向量（含 RFC 7914 §11 的两个公开用例），由 OpenSSL 独立生成。
如果你要的就是 RFC 6070 本身，那需要先解禁 SHA-1，请明确。

### 踩过的坑（已写成回归测试）

**`Buffer.prototype.slice` 是 `subarray`（共享内存的视图），不是 `Uint8Array.prototype.slice`（复制）。**
早期 `aes.js` 用 `block.slice()` 复制状态、`shiftRows` 里用 `state.slice()` 取快照，
一旦调用方传进来的是 Node `Buffer`（测试里的 `materialize` 正是返回 Buffer），
两者就共享同一块内存 → ShiftRows 边读边写把自己改坏 + 就地改写调用方明文。
表现为「纯 Uint8Array 输入正确、Buffer 输入错误」，极易误判成算法写错。
现已全部改为 `new Uint8Array(x)` 显式复制，并在 `test_aes.js` / `test_ctr.js` 加了三条回归断言：
Buffer 与 Uint8Array 结果一致、加密不改写调用方输入、同一计数器对象连用两次结果相同。

**一处有意的例外（2026-10-06 厘清）**：`file/format.js` 的 `splitFile()` 对
规则块 / 载荷 / MAC 三段**刻意保留 `subarray()` 视图**而不复制 —— 载荷可能上 GB，
复制一份会让内存直接翻倍；这三段在下游只被读取（MAC 计算、解密、判等），无处就地改写。
与此相对，`parseHeader()` 里的小字段（nonce / salt / KEY_CHECK / 段顺序）已改为
`copyRange()` **显式复制**，因为这些值会脱离文件缓冲区被长期持有；
`metadata.js` 解出的取值也改为显式复制（它会作为返回值交给调用方）。

规矩精确表述为：**不要用 `.slice()` 去表达"我想要一份副本"**（在 Buffer 上它不是副本）；
需要视图时明确写 `subarray()`，让意图落在代码上。

**用 TypedArray 作参数构造 `new Uint32Array(...)` 是逐元素复制，不是 buffer 视图。**
`random.js` 的 `randomUint32()` 原本写成 `new Uint32Array(randomBytes(4))[0]`：
`randomBytes(4)` 是长度为 4 的 `Uint8Array`，作为**类数组**传给 `Uint32Array` 构造器时会被**逐元素**复制成
4 个各自 0~255 的元素，于是 `[0]` 只是第一个字节 —— **32 位随机性退化成 8 位**（实测 2000 次调用最大值恒为 255）。
它一直潜伏，是因为没有任何调用方：密钥材料都直接走 `randomBytes`，而 `randomUint32`/`randomInt` 当时无人使用。
直到统一失败延迟从 `Math.random` 改为 `randomInt`（见 D38）才被暴露。
现改为 `new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)`，
并在新增的 `test_random.js` 里用"最大值必须超过 255、且至少出现一个 ≥ 2^31 的样本"钉死。

## 3. 核心伪代码（SPEC §8）

```
SHA-256（SPEC §5 阶段一）:
  state = INIT[8]
  对每个 64 字节块:
    W[0..15] = 块的大端 32 位字
    W[16..63] = σ1(W[i-2]) + W[i-7] + σ0(W[i-15]) + W[i-16]
    (a..h) = state
    循环 64 次:
      T1 = h + Σ1(e) + Ch(e,f,g) + K[i] + W[i]
      T2 = Σ0(a) + Maj(a,b,c)
      整体右移一位; e = d + T1; a = T1 + T2
    state += (a..h)
  收尾: 补 0x80 → 补零至 ≡56 (mod 64) → 追加 8 字节大端比特长度

统一失败（SPEC §4/§5/§7）:
  fail(reason):
    [内部诊断钩子，默认关闭，绝不写密钥/明文]
    等待 4000~5000ms 随机延迟
    抛出 Error("解密失败")   // 不区分密钥错 / 文件被改
```

## 4. 测试向量清单与验收标准（SPEC §5 阶段一、§6）

| 向量集 | 来源 | 数量 | 验收 |
| --- | --- | --- | --- |
| `sha256_vectors.json` | node:crypto / OpenSSL | 14 | **全部通过** ✅ |
| `hmac_vectors.json` | node:crypto / OpenSSL（RFC 4231 用例） | 9 | **全部通过** ✅ |
| `pbkdf2_vectors.json` | node:crypto / OpenSSL（含 RFC 7914 §11 用例） | 8 | **全部通过** ✅ |
| `aes_vectors.json` | node:crypto / OpenSSL（FIPS 197 用例） | 6 | **全部通过** ✅ |
| `ctr_vectors.json` | node:crypto / OpenSSL（SP 800-38A F.5.x 用例） | 6 | **全部通过** ✅ |

合格线（SPEC §6 阶段一验收）：SHA-256 / HMAC / PBKDF2 / AES / AES-CTR 五套向量**各自全部通过**才算阶段一完成。
**当前状态：阶段一已完成（5/5 套，68 项断言全绿）**，入口 `pnpm test:selfcrypto`。

附加自洽性测试（本项目自加，非 SPEC 要求）：分片 `update` 与一次 `update` 等价（跨 55/56/63/64/65 边界）、`digest()` 可重复调用且返回副本、结束后再 `update` 报错、非 `Uint8Array` 输入被拒。

### 为什么向量可信

期望值**不是手抄的**：`tools/gen_vectors.js` 用 `node:crypto`（OpenSSL，与本项目自研实现相互独立）算出后写入 JSON，
再由自研实现去比对。手抄向量一旦打错一位，测试就会去迁就错误值——生成器消除了这个风险。
生成器与测试共用 `materialize()`（`tests/unit/_helpers.js`），避免两处实现分叉。

运行：`node tests/unit/test_sha256.js` 或 `pnpm test:selfcrypto`；改向量请重跑 `node tools/gen_vectors.js`。

## 5. 字节级文件格式表（阶段二 · 已落地）

文件布局：

```
[头部 97 字节] [规则块 RULES_LEN 字节] [密文载荷 PAYLOAD_LEN 字节] [整体 MAC 32 字节]
```

头部字段（全部大端，SPEC §3「字段长度前缀统一大端」）：

| 偏移 | 长度 | 字段 | 说明 |
| --- | --- | --- | --- |
| 0 | 8 | MAGIC | `DA 7A 9F 3C 00 FF 1B 8E` |
| 8 | 1 | VERSION | `0x01` |
| 9 | 1 | FLAGS | bit0=内容经压缩；bit1=有口令保护；**bit2=CTR 使用完整 16 字节 nonce**（见 D39）；其余位必须为 0 |
| 10 | 2 | RESERVED | 普通保留位，必须为 0（非零即拒绝解析）。**与国密 SM4 的 FK 无关** —— 后者是 GB/T 32907-2016 的算法内置常量，不占用文件字段（见 D3） |
| 12 | 4 | TIMESTAMP | Unix 秒 |
| 16 | 16 | BOOT_NONCE | 引导随机数（nonce 唯一性来源之一） |
| 32 | 4 | RULES_LEN | 规则块字节数 |
| 36 | 4 | CHUNK_SIZE | 分块大小（默认 1048576） |
| 40 | 1 | SEGMENTS | 段数（默认 3） |
| 41 | 1 | SPLIT_MODE | 0 = 按字节交错 |
| 42 | 3 | SEGMENT_ORDER | 三份的排列顺序（默认 `02 00 01`） |
| 45 | 32 | SALT_RANDOM | 随机盐 |
| 77 | 16 | KEY_CHECK | 不解密即校验密钥 |
| 93 | 4 | PAYLOAD_LEN | 密文载荷字节数 |

设计取向：**段数 / 拆分方式 / 排列顺序 / 分块大小都记在文件里**，解密端一律以文件自述为准、不信任何隐式默认——这样日后改默认值不会让旧文件解不开。MAC 放在**文件末尾**，覆盖"它之前的全部字节"（encrypt-then-MAC），计算时无需跳过中间字段。

规则块与元数据共用同一套二进制 KV 帧（SPEC §7 禁止 UTF-8 文本格式，故不用 JSON）：

```
KV := u32 count, entry × count
entry := u8 keyLen, key(keyLen, ASCII), u8 type, u32 valueLen, value
type := 0=bytes 1=uint64 2=utf8
```

解码要求**整块被消费完**（尾部多余字节即报错），键名限 ASCII `[A-Za-z0-9_.-]{1,64}`，重复键/未知类型/未知元数据键一律拒绝。

### 决策记录（SPEC 未定义、由本项目决定；可被用户否决）

| # | 决定 | 依据 / 理由 |
| --- | --- | --- |
| D1 | MAGIC 采用 SPEC 建议值 `DA 7A 9F 3C 00 FF 1B 8E` | SPEC §3 已给建议值 |
| D2 | 规则块用**自定义二进制**而非 JSON | §7 禁止 UTF-8 文本格式；JSON 键序/空白会产生非规范字节（简单路线已踩过 meta 键序进 AAD 的坑） |
| D3 | 文件头偏移 10 的 2 字节是**普通保留位 `RESERVED`**（强制为 0，非零即拒绝解析） | 原文此处名为 `RESERVED_FK`，但 **"FK" 已由用户确认为国密 SM4 标准（GB/T 32907-2016）的系统参数** —— 算法内置常量、16 字节、不落文件，与这 2 字节无关 → **正名以免混淆**。**已定案（2026-10-06）** |
| D4 | 整体 MAC 覆盖**除末尾 MAC 自身外的全部字节**，encrypt-then-MAC | 覆盖面最大、实现最不易漏；先验后解 |
| D5 | 结构性参数（段数/拆分/顺序/分块）写入头部 | 自描述 → 日后改默认不破旧文件 |
| D6 | PBKDF2 用 **HMAC-SHA256** 向量而非 RFC 6070 | §5 写的 RFC 6070 是 HMAC-**SHA1** 向量集，而 §7 禁止自研 SHA-1（只允许 SHA-256/HMAC/PBKDF2/AES/CTR）。改用 RFC 7914 §11 的 PBKDF2-HMAC-SHA256 用例 + OpenSSL 交叉验证。**已由用户确认维持（2026-10-06）**：PBKDF2 的骨架（迭代循环 / 块索引 / 逐块异或链 / 末块截断）与所用哈希无关，SHA-256 向量验的是同一个结构，故不必为跑一组向量而引入已不安全的 SHA-1 |

D1–D34 中**唯二需要用户确认的 D3 与 D6，已于 2026-10-06 定案**（见上表）；其余为用户授权"直接做"范围内的默认取值，均可被否决。

## 5.1 阶段二：文件加解密（已落地）

`file/encrypt.js` 与 `file/decrypt.js` 实现完整流程，`tests/unit/test_file_crypto.js` 做往返 + **与 OpenSSL 双向交叉验证**。

六步加密流程（SPEC 只说"六步"、未逐条列出，此处为 **D7** 定义，可被否决）：

| 步 | 动作 |
| --- | --- |
| 1 | 生成随机材料：SALT(32)、BOOT_NONCE(16)、主密钥 K(16)（调用方也可自带 K） |
| 2 | 派生子密钥：`encKey`/`macKey`/`keyCheck`（HMAC-SHA256 + 域分隔标签，见 `crypto/kdf.js`） |
| 3 | 组装明文载荷：`u32(metaLen) ‖ 元数据 KV ‖ 文件内容` —— **元数据一并加密**，文件名不出现在明文里 |
| 4 | 分块 AES-CTR：每块 1 MiB；块 i 的计数器 = `BOOT_NONCE`（**完整 128 位**）+ `i × 每块计数器数`（计数器空间不重叠，见 D39） |
| 5 | 段拆分与重排：按字节交错拆成 3 份，再按头部记录的 `SEGMENT_ORDER` 排列（**纯格式特性，不提供机密性**，见 §8.3） |
| 6 | 整体 MAC：`HMAC(macKey, 头部 ‖ 规则块 ‖ 载荷)`，追加到文件末尾（encrypt-then-MAC） |

解密顺序（严格对称、红线优先）：解析结构 → **校验整体 MAC** → **校验 KEY_CHECK** → 还原段顺序 → 分块解密 → 拆出元数据与内容。
（**先 MAC 后 KEY_CHECK** 是 2026-10-06 的修改，理由见 D40 —— 原顺序会让统一延迟在大文件上失效。）
任何失败都走 `common/fail.js`：对外只有「解密失败」一种文案 + 4~5 秒统一延迟，内部原因只进诊断钩子。

补充决策（**D8–D10**）：

| # | 决定 | 理由 |
| --- | --- | --- |
| D8 | 主密钥 16 字节（AES-128-CTR），三个子密钥用 HMAC + 固定标签派生 | 只用 SPEC §7 允许的原语；域分隔避免同一密钥在不同用途下产生相关性 |
| D9 | 元数据放在**加密载荷内部**（`u32 长度前缀 + KV + 内容`） | 原文件名/备注属于敏感信息，不应明文出现在文件头 |
| D10 | 段拆分用**长度感知**的切分（各份长度由总量与下标公式决定），不是等分 | 载荷按 order 重排后各份边界不再等分；按 `index % 段数` 硬切会切错（此 bug 已由交叉验证抓出并修复） |
| D39 | CTR 计数器改用**完整 16 字节** BOOT_NONCE 作 128 位初值，并用 flags 的 bit2 标记 | 原写法只取 nonce 前 8 字节、后 8 字节放块偏移，块 0 时后 8 字节恒为全零 → 有效 nonce 只有 **64 位**，白丢一半随机性。**实测**：两个只在后 8 字节不同的 nonce 产出**逐字节完全相同**的密文。新写法把 16 字节当 128 位整数再按块累加（含进位）。用 flag 位而非升 VERSION：旧文件（未置位）仍按旧方式解开，**向后兼容**（由交叉验证 D/E 与"v1 旧格式仍能解开"三条测试覆盖） |
| D40 | 解密顺序改为**先整体 MAC、后 KEY_CHECK**，并新增 `padToUniformDuration` 按**总耗时**补齐延迟 | 原顺序下「密钥错」只需一次 HMAC（微秒级）就返回，而「文件被改」必须算完整个文件的 MAC（纯 JS HMAC 实测 **40 MB/s → 1 GB 约 25 秒**）。两条路径耗时差几十秒，"事后各加 4~5 秒延迟"根本掩盖不住 → 统一延迟在大文件上形同虚设。现在两条路径都要先付出完整 MAC 的代价，延迟再按总耗时补齐。**实测（1 MiB）**：错误密钥 31ms vs 篡改 24ms，已是同一量级 |

### 阶段二被测试抓出来的两个真 bug（均已修 + 已加回归）

1. **TypedArray.prototype.map 返回 TypedArray**：`order.map(...)` 把 Uint8Array 元素强转成数字，`concatBytes` 收到非字节串直接抛错。
2. **重排后的段边界**：解密侧曾用 `interleaveSplit(重排后的载荷)` 去还原，按 `index % 3` 硬切导致内容全错——**由与 OpenSSL 的交叉验证首次暴露**，现已改为按 `shareLengths` 计算的长度切片。

## 5.2 阶段三：图片水印（已落地）

四个模块与 SPEC §5 阶段三逐条对应：

| 模块 | 职责 |
| --- | --- |
| `watermark/lsb.js` | LSB 嵌入与提取、位置序列规划、容量校验（决策 D11–D13） |
| `watermark/watermark_crypto.js` | 私有信息的加解密（决策 D15）：`nonce(16) ‖ AES-CTR 密文 ‖ HMAC(32)` |
| `watermark/visible.js` | 有形水印：**两种 mode** —— `corner`（角落/居中单个）与 `tile`（全图平铺斜向重复，D35）；样式计算是纯函数、绘制走 Canvas |
| `watermark/extract.js` | 公开提取与私有提取、定长公开头（决策 D16）、SPEC §4 模块 B/C2 的接口 |

三层结构（**D16**）：`[公开头 80 字节] [公开层] [私有层]`。公开头写在与密钥无关的**常量位置**上，
解决"要读种子就得先知道位置"的鸡生蛋问题；公开层位置由头里的 publicSeed 决定（无需密钥）；
私有层位置 = `HMAC(WK, 公开头字节)`（SPEC §9：规则文件 + WK 共同决定），并**跳过前两层占用的槽位**。

补充决策：

| # | 决定 | 理由 |
| --- | --- | --- |
| D11 | 图片用 `{data: Uint8Array, width, height}`（RGBA）表示，通道顺序 R,G,B，**不动 alpha** | 与浏览器 ImageData 同形但在 Node 可测；不动 alpha 避免影响不透明度语义 |
| D12 | 位置序列 = `(start + k × step) mod N`，step 与 N 互质；种子经 HMAC-SHA256 计数器模式派生 | 前 N 项互不重复且 **O(1) 内存**——大图 N 可达数千万，物化置换表会吃掉数百 MB |
| D13 | 私有层种子 = `HMAC(WK, "xq/v1/wm-private" ‖ 规则块)`，并跳过公开层槽位 | 满足 SPEC §9「规则文件 + WK 共同定义」，且三层永不互相覆盖 |
| D14 | 每层载荷 = `u32 长度 ‖ 内容`，比特 MSB 优先写入 LSB | 长度显式声明，坏数据报错而不静默截断 |
| D15 | 私有信息用 WK 派生的子密钥做 AES-CTR + HMAC，失败走统一失败 | 复用既有原语，无新算法 |
| D16 | 公开头用**定长 80 字节结构**而非 KV | 提取时无需先知道长度即可读出；保留字段非零即拒绝 |
| D17 | 有形水印只用系统字体栈，不内嵌字体文件 | 避免体积与字体授权问题 |
| D18 | 字号**只按 SPEC 的 1%~2% 计算并做区间校正**，不加最小字号下限；同时用 `legible` 字段如实标注是否看得清 | 加了最小字号会在小图上违反 SPEC 比例；看不清是其自身后果，应告知而非偷偷改比例 |

### SPEC §6 阶段三验收 → 测试对照

| 验收标准 | 对应测试 |
| --- | --- |
| 图片嵌入水印后肉眼正常 | 「嵌入后肉眼正常：逐通道最大差值 ≤ 1，且平均差值极小」 |
| 公开提取无需密钥可读 | 「公开提取：不需要密钥即可读出」 |
| 私有提取需要 WK 可读 | 「私有提取：提供正确 WK 可读」 |
| 错误 WK 统一失败 | 「私有提取：错误 WK → 统一失败（而不是给出乱码）」 |
| 有形水印不仔细看看不见 | 「有形水印样式：字号/透明度/边距都落在 SPEC 区间内」+ 默认取区间低端；**真浏览器验证**：1254×807 图上角落模式实际参数 13px / 15% / 3px（13÷1254 = 1.04%），仅 797 个像素被改动且全部落在右下角 |
| 有形水印可全图覆盖（用户追加） | 平铺模式同样守 SPEC 的字号/透明度区间；真浏览器验证**四个象限各约 4 万像素被改动**（总计 159949，四象限 40143/39969/39626/40211 均衡），角度 -30°、450 条如实可报 |

### 阶段三自检发现并修掉的问题

- **错误 WK 会泄漏失败位置**：WK 不对时位置序列本身就是错的，会先撞上"长度字段非法"而抛出结构错误，
  与 §7「禁止提示解密失败的具体原因」冲突 → 已把私有层整段收敛到统一失败。
- **四舍五入把字号挤出 SPEC 下限**：1920×1% = 19.2 → 19 → 占比 0.0099 < 0.01 → 已加区间校正。

### 阶段三已知缺口（如实标注，未做）

| 缺口 | 说明 |
| --- | --- |
| LSB 是**脆弱水印** | 对 JPEG 有损压缩、缩放、重采样、裁剪都不鲁棒；这是 LSB 的固有性质，不是实现缺陷。未做鲁棒性测试与纠错编码 |
| ~~有形水印的 Canvas 绘制未在真浏览器验证~~ | **已闭环（2026-10-04）**：烟雾测试在真浏览器里跑通 `drawVisibleWatermark`，并量化了"可见层 vs LSB 层"的像素影响（见阶段五验收对照） |
| 未做"水印与文件加密共用规则文件"的端到端联调 | 编码已共用（同一套 KV 帧），但尚未把水印规则写进 `.xuqian` 的规则块做联调 |

## 5.3 阶段四：AI 检测（已落地）

| 模块 | 职责 |
| --- | --- |
| `ai/metadata_scan.js` | 自己遍历容器：**JPEG** 的 APP1(EXIF)/APP1(XMP)/APP13(IPTC)/JUMBF(C2PA)、**PNG** 的 tEXt/iTXt/zTXt、**WebP** 的 RIFF 块（EXIF/XMP）、**HEIC/AVIF** 的 `ftyp` 品牌识别 + **标记扫描**；匹配 24 个 AI 工具签名 |
| `ai/frequency.js` | **三种变换**：8×8 **DCT**（块内高频占比、网格 blockiness、平滑度）+ 2D **FFT**（基数-2，径向功率谱、谱斜率、谱峰占比）+ **Haar DWT** 2 级（LL/LH/HL/HH 子带能量） |
| `ai/noise.js` | LSB 平面熵/偏置/翻转率（**SPEC §6「能检测 LSB 异常」**）、拉普拉斯残差强度 |
| `ai/color.js` | 饱和度、三通道相关系数、亮度直方图锯齿度 |
| `ai/edge.js` | Sobel 梯度均值/密度、细节比、边缘弥散度 |
| `ai/report.js` | 模块 D `detectAIWatermark` 与模块 E `detectAIGenerated` 共用上面五个分析，各自加权求和 |
| `ai/helpers.js` | **额外新增**（D19）：灰度/分块/DCT/Sobel 等共用计算，避免六处各写一遍 |

补充决策：

| # | 决定 | 理由 |
| --- | --- | --- |
| D19 | 新增 `ai/helpers.js` 放共用计算 | 六个模块都要灰度化/分块/卷积，重复实现必然分叉 |
| ~~D20~~ | ~~只实现 DCT，不实现 FFT/DWT~~ | **已作废（2026-10-04）**：三种变换现已全部实现（见 D37）。当时的原则仍然算数——"宁可缺，也不写一个假装在用的空壳" |
| D37 | FFT/DWT 都放在 `frequency.js`（SPEC 就是划给它的），且都**限制在 256×256 的定长裁剪**上 | 大照片整幅做 DWT 会产生约 96MB 中间数组；定长裁剪把开销钉死，也让结果与图片大小无关。FFT 用加窗裁剪（抑制边界泄漏），DWT 用**不加窗**的同一裁剪（加窗会改信号、算错子带能量） |
| D21 | 高频定义为 DCT 系数 `u+v ≥ 8`（8×8 共 64 个系数） | JPEG 类痕迹集中在 8×8 网格；该界限是经验值（未标定，见 D23） |
| D22 | 不做"假装是 PRNU"的计算 | 真 PRNU 需要多张同源图相关分析；单图只给残差强度这类弱指标 |
| D23 | 权重与阈值取经验初始值，报告恒带 `calibrated:false` + 免责声明；措辞只用"线索/疑似" | SPEC §9 第 8 项本身未定；未标定的检测绝不能包装成结论 |
| D24 | 元数据工具签名单独列为 `evidence`（可直接核实），其余为统计推断 | 两者证据强度不同，混在一起会误导 |

### SPEC §6 阶段四验收 → 测试对照

| 验收标准 | 对应测试 |
| --- | --- |
| 能读取元数据 | 「读取 JPEG 元数据：EXIF 标签 + XMP + C2PA 都能识别」「读取 PNG 文本块并识别 AI 签名」 |
| 能检测 LSB 异常 | 「LSB 异常：低位恒定的图被判为异常，低位随机的图不判异常」 |
| 能输出检测报告 | 「报告：权重合计为 1，各信号贡献之和等于总分，且恒带未标定声明」「verdict 按阈值分档」 |
| 能给出 AI 生成置信度 | 「模块 E：带 AI 工具签名的图给出更高可能性，干净图更低」 |

模块 D 还额外具备一项**可核实**的能力：直接读出本项目写入的 LSB 水印（测试「嵌入本项目水印的图能被检出，且证据里带水印文本」）。

### 阶段四自检发现的问题

- **用 1 像素棋盘测 Sobel 会退化**：棋盘的对角邻居同色，gx/gy 相消，响应接近 0。
  这是 Sobel 算子的真实性质，不是实现缺陷 —— 已把它固化成断言，避免以后误判。
- **"平均 Sobel 幅度"不是"边缘强度"的单调量**：线性渐变处处有响应，阶跃只在边缘有响应，
  两者比均值会得出反直觉结论。测试改为比较**响应弥散度**（`edgeStd/edgeMean`）。
- **汇总入口抓错行**：`run-all.js` 原来用"包含合计"匹配汇总行，被某条测试名（"权重合计为 1"）命中 →
  已改为严格匹配汇总行格式。

### 阶段四已知缺口

| 缺口 | 说明 |
| --- | --- |
| FFT / DWT | **已实现**（D37）：2D FFT + Haar DWT 2 级，配合 8×8 DCT 一起进频域分；正确性由"逆变换往返 / Parseval 能量守恒 / **与朴素 DFT 逐点对照**"验证 |
| 权重与阈值未标定 | 经验初始值；报告恒带 `calibrated:false` 与免责声明，不能当结论（D23） |
| PRNU 只到残差强度 | 真 PRNU 需要多张同源图做相关分析（D22） |
| ~~容器支持有限~~ **部分闭环** | JPEG / PNG / **WebP** 按容器结构解析；**HEIC / AVIF** 只做标记扫描（未做 ISOBMFF 盒树解析） |
| 检测能力本身不可靠 | "AI 生成检测"是公认的开放问题，本实现只提供线索；**不得用于任何需要结论的场合** |

## 5.4 阶段五：界面（已落地）

**对 SPEC 的第二处偏差（D25）**：SPEC §2/§5 假设的是原生 JS 的 `src/ui/{main,file_page,watermark_page,decrypt_page,ai_page}.js`。
用户已明确「不重做界面」，因此用现有 React 栈实现**同样的页面划分**，落在 `src/components/selfcrypto/`：

| 组件 | 对应 SPEC 页面 |
| --- | --- |
| `SelfHome.tsx` | main（五个入口） |
| `SelfFilePage.tsx` | file_page |
| `SelfDecryptPage.tsx` | decrypt_page |
| `SelfWatermarkPage.tsx` | watermark_page |
| `SelfAiPage.tsx` | ai_page |
| `SelfStatusPage.tsx` | 额外：算法与状态（原开始页里的自研面板迁到这里） |
| `SelfShell.tsx` / `browser.ts` | 页面外壳与浏览器粘合（文件↔字节↔图片↔下载↔统一失败文案） |

路由用 store 里的 `selfTab`（`home/file/decrypt/watermark/ai/status`），与简单路线的页签完全独立。

| # | 决定 | 理由 |
| --- | --- | --- |
| D25 | 界面用 React 实现 SPEC 的页面划分，而非新增原生 JS 的 src/ui | 用户已定「不重做界面，两者均兼顾」；两套 UI 会让人力与一致性双输 |
| D26 | 自研模块保持纯 JS，界面是 TS；开 `allowJs` 让 TS **从实现推断**类型，不手写 `.d.ts` | 手写声明会随时间漂移。配套三条经验：①**JSDoc 的 `@returns` 会被 TS 采信**（把 `outputImage` 写成 `object` 就会让界面报类型错）；②JS 参数**不要给 `= null` 默认值**（推断出的参数类型会收窄成只剩 `null`）；③`extractWatermark` 因此改为不给默认值、内部用 `if (!keyWK)` 处理 |
| D27 | 界面失败提示统一走 `browser.ts` 的 `describeFailure()` | 内核失败已归一为「解密失败」；其它异常（无文件/容量不足/无水印）也收敛成同一口径，与 SPEC §5 阶段五「所有失败统一提示」一致 |

### SPEC §6 阶段五验收 → 浏览器烟雾测试对照（13 项，全部真实上传文件）

| 验收标准 | 对应检查 |
| --- | --- |
| 主界面五个入口 | 「自研路线主页有五个入口（验收：主界面五个入口）」 |
| 每个页面独立可用 | 「自研路线「file/decrypt/watermark/ai/status」页可独立打开且元素齐备」×5 |
| 所有失败统一提示 | 「自研解密页失败提示统一为「解密失败」且不泄漏失败原因」 |

另有 4 条**真实链路**（不是只看 DOM 存在）：

1. 加密页上传真实文件 → 真的产出 128 位密钥 + `self-plain.bin.xuqian` 出现在下载目录
2. 解密页对非密文文件 + 合法格式密钥 → 页面出现**内容恰好等于「解密失败」**的叶子节点，且全文无任何失败原因泄漏
3. 水印页对真实 PNG 嵌入 → 给出 WK 且 `watermarked.png` 落盘；对未嵌水印的图提取 → 明确提示「未找到可识别的水印」
4. AI 检测页 → 输出报告两栏（生成可能性 + 水印检出），且报告写明「未标定 / 不能作为结论」

### 阶段五已知缺口
| 缺口 | 说明 |
| --- | --- |
| ~~有形水印未接入界面~~ **已闭环（2026-10-04）** | 水印页新增「同时加有形水印」开关 + 文字 + 位置（右下/左下/右上/左上/居中）+ **预览画布**；预览与下载走同一条绘制路径、用嵌入时冻结的参数（避免"改了参数预览变了但文件没变"的误导）；并如实报出实际字号/透明度/边距，图太小导致按比例算出的字号看不清时明确标注 |
| 界面里没有水印鲁棒性提示 | LSB 是脆弱水印，界面未就"压缩/缩放会毁掉水印"给出警告 |
| 大图性能未测 | AI 检测在 1254×807 的截图上可跑通；更大的照片未做耗时测量 |

## 5.5 阶段六：存储与部署（已落地）

SPEC 阶段六原文：「纯前端方案写 indexeddb.js 存密文。带后端方案写 file_io.js 和本地服务。配置本地静态服务器。打包 dist 目录。」
验收：「本地服务器能启动。浏览器能访问。数据存本地。」

| SPEC 要求 | 落地 |
| --- | --- |
| `storage/indexeddb.js` 存密文 | ✅ `src/selfcrypto/storage/indexeddb.js` + 界面接入（加密页可存库、解密页可从库选）+ **整库导出/导入备份**（D36） |
| `storage/file_io.js`（带后端方案） | ❌ **有意不做**（D28）：部署形态已定纯前端无后端 |
| 配置本地静态服务器 | ✅ `start-xuqian.bat`（dev 5188，一键启动并开浏览器）+ `vite preview`（dist 5189），阶段六自检里实起过一次 |
| 打包 dist 目录 | ✅ `pnpm build` → `dist/`，烟雾测试含 `dist/index.html` 存在性断言 |
| `third` 目录留空 | ✅ 建目录 + README 说明；并把约束写成机械校验的测试（D29） |

| # | 决定 | 理由 |
| --- | --- | --- |
| D28 | 只做 `indexeddb.js`，不做 `file_io.js` | 用户已定「先本地部署」且纯前端；引入本地服务会多一个需审计的进程，与"不接触明文和密钥"的承诺之间多一个攻击面。SPEC 已给定后端方案的边界（只存密文与元数据），将来要补也不难 |
| D29 | 落库字段用**白名单**（`id/name/bytes/size/savedAt/version/note`），递归拒绝任何密钥类字段；并把「零第三方 import」「无网络调用」「不用 localStorage/sessionStorage」写成三条**机械校验测试** | 文档里的约束会腐化，测试不会。"绝不落库密钥"必须是结构上做不到，而不是靠自觉 |
| D30 | 旧验收项「IndexedDB 未被使用（验收 17）」**改判据**为「IndexedDB 中无密钥、也无密钥类字段」 | 与 SPEC 阶段六直接冲突：阶段六要求用 IndexedDB 存密文。改判据后**更强**——原来只查"库存在与否"，现在直接翻库内容找密钥 |
| D31 | `encryptFile` / `decryptFile` 增加**可选**第三参数 `{ onProgress }`（SPEC §4 只规定了两个参数） | 纯增量、不传时行为与原来逐字节一致（有测试固化）；大文件需要真实进度，而"没有进度"比"假进度"更诚实 |
| D32 | 自研路线的加密/解密放进 **Web Worker**；主线程仅回退执行 | G11：同步加密在约 2MB/s 下会让 100MB 冻结约 50 秒且无法取消。放 Worker 后界面不卡、且 `terminate()` 就是**彻底取消**（连内存里的密钥一起释放） |
| D33 | 进度**分阶段**上报（`setup`/`cipher`/`split`/`mac`/`keycheck`），只有 `cipher` 阶段显示百分比 | 只有分块变换真有"已处理/总量"；把分块进度冒充整个文件进度就是伪造进度 |
| D34 | 主密钥在 Worker 里**用完立即清零**，且清零放在 await 之后的 `finally` | 起初写成"包一层同步 helper"，那会在 Promise 还没 settle 时就清零密钥（已修） |
| D36 | 本地密文库支持**整库导出/导入**：自定义二进制归档（magic `XQLIB`+版本、逐条 `nameLen/name/dataLen/data/version/savedAt`），导出时同样过"无密钥字段"白名单，解析要求**整块消费完** | 密文库存在浏览器里，**用户清一次浏览器数据就全没了**；有备份才能自救。刻意不用 base64/JSON：保持密文是原始字节，也避免文本化 |
| D35 | 有形水印做成**可扩展的 mode**：`corner`（角落/居中单个）与 `tile`（**全图平铺斜向重复**，用户新增需求）。平铺参数：角度默认 **-30°**（夹在 [-45,45]）、横向间距 = 字号×8、纵向 = 字号×4、奇数行错开半个间距 | 用户原话「可全图覆盖（传统水印一样斜着一排排的）等」——那个"等"意味着以后可能还有别的样式，所以按 mode 扩展而不是硬编码两种。**字号与透明度仍守 SPEC §3 的区间**（不因为是新模式就破例），间距与角度 SPEC 未定故记为决策 |
| D38 | 统一失败延迟的随机源由 `Math.random` 改为 CSPRNG（复用 `crypto/random.js` 的 `randomInt`） | SPEC §7 要求"随机数只用系统 CSPRNG"，`Math.random` 严格读法下属违规。延迟量本身不是密钥材料，但**不给约束留例外**更省心。此改动顺带暴露并修复了 `randomUint32()` 只返回 1 个字节的潜伏 bug（见上「踩过的坑」） |

### SPEC §6 阶段六验收 → 证据

| 验收标准 | 证据 |
| --- | --- |
| 本地服务器能启动 | `vite preview --port 5189` 实起一次，HTTP **200**、`Content-Type: text/html`、页面含 `id="root"`、引用 `/assets/index-*.js` |
| 浏览器能访问 | 烟雾测试全程用本机 Edge headless 访问 `http://127.0.0.1:5188/`（119 项全过） |
| 数据存本地 | 「刷新后本地密文库仍有记录」「可从本地密文库直接选用密文」「删除后本地密文库为空」三项真实浏览器断言（**跨刷新**才是真持久化的凭据） |
| （红线）库里没有密钥 | 「落库记录只含密文与展示字段，无任何密钥字段」+ 上述改判据后的「IndexedDB 中无密钥、也无密钥类字段」 |

### 阶段六已知缺口

| 缺口 | 说明 |
| --- | --- |
| 存储配额未主动管理 | 只有 `storageEstimate()` 可查用量，未做"配额不足"的提示与清理策略 |
| 未做加密备份/导出 | 本地密文库没有"整库导出/导入"，浏览器清数据即丢失（密文丢失但密钥在手也解不开别的副本） |
| `file_io.js` 未实现 | 见 D28：属带后端方案，本项目不做 |
| 局域网共享未验证 | SPEC 提到"局域网共享绑 0.0.0.0"，本项目按纯本机使用，未做该场景验证 |

## 5.6 阶段七：测试与验收

SPEC 阶段七原文：「跑全部标准测试向量。跑交叉验证。跑大文件分块测试。跑异常中断测试。跑统一失败延迟测试。跑水印提取测试。跑 AI 检测报告测试。」
验收：「全部测试通过。无遗留待定项。」

| SPEC 要求 | 对应套件 | 断言数 |
| --- | --- | --- |
| （阶段零）随机数封装 | `test_random`（randomBytes / randomUint32 / randomInt，含"`randomUint32` 退化成 8 位"与"`randomBytes` 超 65536 字节"两条回归） | 9 |
| 跑全部标准测试向量 | `test_sha256` / `test_hmac` / `test_pbkdf2` / `test_aes` / `test_ctr`（向量由 OpenSSL 独立生成） | 18/14/10/12/14 |
| 跑交叉验证 | `test_file_crypto`（自研加密 → OpenSSL 解密，OpenSSL 加密 → 自研解密，含新旧两种计数器写法） | 21 |
| 跑大文件分块测试 | `test_large_file`（12 MB/12 块、1 块 ±1 字节、24 块计数器不重叠、完整 nonce 回归） | 8 |
| 跑异常中断测试 | `test_interrupt`（17 个位置截断横扫、追加垃圾、全零、全随机、7 种头部篡改） | 8 |
| 跑统一失败延迟测试 | `test_uniform_delay`（**实测**两次真实失败的耗时，并验证等时化） | 8 |
| 跑水印提取测试 | `test_watermark` | 29 |
| 跑 AI 检测报告测试 | `test_ai_detect`（含 FFT/DWT 正确性） | 45 |
| （附加）格式层 / 存储与 SPEC 结构自检 / 大文件进度回调 | `test_format` / `test_storage` / `test_progress` | 13 / 19 / 6 |

合计 **15 套、234 项断言**，`pnpm test:selfcrypto` 全绿；另有浏览器烟雾 **119 项**、站点原有单测 98 项。
（2026-10-06：由 227 增至 234，新增 7 项都是为上面 D39/D40 与 `randomBytes` 分片配的回归。）

### 实测数据（不是估算）

| 指标 | 实测值 |
| --- | --- |
| 错误密钥失败耗时 | **4023 ms** |
| 文件被篡改失败耗时 | **4118 ms** |
| 延迟抽样 400 次的分布 | 全部落在 4000~5000ms，均值≈4500，跨度 >700 |
| 12 MB 加密 | 7620 ms |
| 12 MB 解密 | 9119 ms |
| **纯 JS AES-CTR 吞吐** | 实测 **1.8~2.0 MB/s 单向**（浏览器真加密 3MB：1.82 MB/s；Node `pnpm bench` 4MB：1.99 MB/s；1 GB 约需 8~9 分钟） |

最后一行是**真实可用性限制**，已在界面上如实提示（选超过 2MB 的文件时显示"约 1.8–2 MB/s + 预计秒数"）。
这不是缺陷而是取舍：自研路线要求算法自己实现，就用不了平台加速。

### 关于验收条款「无遗留待定项」

原先这条**无法断言**，原因有两处：一处 SPEC 未定义（`FK`），一处是替用户做的取舍（PBKDF2 向量）。**两者已于 2026-10-06 定案**，故 SPEC §9 的待确认参数**已无遗留**：

| # | 项 | 性质 |
| --- | --- | --- |
| ~~D3~~ | ~~FK 在 SPEC 全文只有名字、没有任何定义~~ | **已定案**：`FK` = 国密 SM4 标准（GB/T 32907-2016）的系统参数，与文件格式无关；文件头偏移 10 的 2 字节正名为普通保留位 `RESERVED`（强制为 0、非零即拒绝解析） |
| ~~D6~~ | ~~§5 要 RFC 6070（HMAC-**SHA1** 向量）而 §7 禁止自研 SHA-1~~ | **已定案**：用户确认**维持** PBKDF2-HMAC-SHA256 向量（RFC 7914 §11 + OpenSSL 交叉），不引入 SHA-1 |

> 注意区分：下表 G2 / G3 / G5 / G7 是**有意保留的已知缺口**（能力边界，已在文档与界面如实标注），与"SPEC 参数未定"性质不同，不计入待定项。
| ~~G1~~ | ~~FFT / DWT 未实现（只做 8×8 DCT）~~ | **已闭环（2026-10-04）**：2D FFT（径向谱/谱斜率/谱峰占比）+ Haar DWT 2 级（子带能量）已实现并纳入频域分；16 项断言含"与朴素 DFT 逐点一致" |
| G2 | AI 检测权重与阈值未标定 | 已知缺口（报告恒带 `calibrated:false`） |
| G3 | PRNU 只到残差强度 | 已知缺口 |
| ~~G4~~ | ~~元数据扫描只支持 JPEG / PNG~~ | **部分闭环（2026-10-04）**：新增 **WebP**（RIFF 块结构解析 EXIF/XMP，含"EXIF 块直接放 TIFF"这类无前缀形态）+ **HEIC/AVIF**（按 `ftyp` 品牌识别，只做**标记扫描**，结果里如实标 `markerScan: true` 并写明"扫不到 ≠ 一定没有"）。未做 ISOBMFF 盒树解析 |
| G5 | LSB 是脆弱水印（压缩/缩放即毁） | 固有性质 |
| ~~G6~~ | ~~有形水印 `drawVisibleWatermark` 未接入界面~~ | **已闭环（2026-10-04）**：已接入界面（开关 + 文字 + 位置 + 预览画布）并在真浏览器量化验证 |
| G7 | `storage/file_io.js` 未实现（带后端方案） | 有意不做（D28） |
| G8 | 存储配额未管理 | 已知缺口（**整库导出/导入已补**，见 D36；配额告警与自动清理仍未做） |
| G9 | 大文件约 2 MB/s 单向 | 已知限制（自研实现的固有取舍） |
| ~~G11~~ | ~~大文件加密期间页面会卡住、无法取消~~ | **已闭环（2026-10-04）**：加密/解密搬进 Web Worker（构建出独立 `self.worker` chunk），分阶段真实进度 + 取消按钮；真浏览器验证：3MB 文件加密期间主线程定时器仍在触发（6 次采样、4 个不同进度值、单调递增到 100%），界面不卡 |
| G10 | 局域网共享（绑 0.0.0.0）未验证 | 未测场景 |

因此本阶段的诚实结论是：**「全部测试通过」成立；「无遗留待定项」不成立**，
上述条目里 D3 必须由用户裁定，其余都是已记录在案的已知缺口或有意取舍（G6 已于 2026-10-04 闭环）。

## 6. 与「简单加密」路线的关系




两条路线**相互独立**：格式不同、密钥派生不同、失败处理各走各的；文件后缀都是 `.xuqian`，靠 MAGIC 与 VERSION 区分。
开始页将提供二选一入口（用户要求：1. 简单加密 2. 自研加密，各带说明）。

## 7. 禁止事项自检（SPEC §7）

已落实的约束：不引入任何第三方库（`src/selfcrypto/` 零 `import` 外部包）、随机数只用 CSPRNG、
常数时间比较 MAC、失败不提示具体原因、失败不输出部分明文、统一延迟 4~5 秒。

逐条对照（2026-10-06 更新，原"尚未涉及"一节已过时——阶段二至七均已落地）：

| 禁止项 | 落实方式 |
| --- | --- |
| nonce 复用 | 每次加密新生成 BOOT_NONCE；CTR 按块推进计数器，块间区间不重叠（`test_large_file` 覆盖前 24 块）；D39 起 nonce 空间用满 128 位 |
| MAC 未验证就解密 | 先校验整体 MAC，**通过了才动密文**；且 MAC 排在 KEY_CHECK 之前（D40） |
| 密钥入日志 | 失败的内部诊断钩子默认关闭，且只接收不含密钥/明文的字符串 |
| 服务器端存明文密钥 | 纯前端，无服务器 |
| 生成恢复码 / 密钥托管 | 未实现（也不打算实现） |
| UTF-8 存密文 | 规则块与元数据用自定义二进制 KV 帧；密文是原始字节 |
| 未审计上线 | 见 §8 —— 全部已知边界已如实列出 |

## 8. 已知安全边界与取舍（2026-10-06 补记）

以下条目是**能力边界或有意取舍，不是待修缺陷** —— 但必须写明。
理由是这个项目自己立的原则：**"文档里承诺了、实际不成立"比"没写"更危险**。

### 8.1 纯 JS AES 存在查表型 cache-timing 侧信道

`crypto/aes.js` 的字节代换是查表实现（`subByte = (b) => SBOX[b]`），索引同时依赖密钥与数据。
这是密码学实现的经典时序攻击面（Bernstein 2005 的 AES cache-timing、Osvik–Shamir–Tromer 的 cache 攻击、
2017 年的 CacheBleed）。

- 在"本地单机浏览器 + 攻击者若能同机则有更大手段"的威胁模型下，这个侧信道没有额外价值；
- 在**共享 CPU**（云桌面、多租户虚拟机）上它是真实的。

**必须说清的细节**（否则"查表型 AES"这个说法容易被过度概括，读者无法自己判断风险大小）：

- 本实现的表**只有 256 字节的 S 盒**（约 4 条缓存行），**没有**经典软件 AES 常用的 1 KB T 表
  （`T0..T3` 那种把 SubBytes + ShiftRows + MixColumns 合并成 4 张表的做法）。
  查表型 cache-timing 攻击通常依赖"在大量缓存行之间分辨命中"，表越小越难做；
  但**不能因此说它不存在**，上面第 2 条结论不变。
- `mixColumns` **是常数时间的**：用固定 8 次迭代的 `gfMul`，没有数据相关分支，也不查表。
  这正是它只有约 2 MB/s 的原因之一 —— **慢是常数时间的代价，不是实现粗糙**。
- 所以本路线准确的描述是"**除 S 盒查表之外都是常数时间**"，而不是"没有任何常数时间实现"。

**不做常数时间化的原因**：位切片（bitslicing）或每次现算 `gfInv` 会慢一到两个数量级，
对本就只有约 2 MB/s 的实现不现实。
**结论**：这是自研路线的固有代价。**对侧信道敏感的场景请用「简单加密」路线**
（走 WebCrypto，实现为常数时间且有硬件加速）。

### 8.2 KEY_CHECK 是一个明文的密钥验证预言机

`KEY_CHECK` 明文写在文件头偏移 77（`HMAC(K, salt‖"xq/v1/check")[0..16]`），
因此**只拿到 97 字节文件头**的攻击者就能对任意密钥候选自行算出该值来判断对错 ——
不需要文件主体，也不需要触碰任何解密函数。

- 对**随机 128 位主密钥**：无实质影响（不可能穷举）；
- 若将来接入**口令模式**（PBKDF2）：它会把攻击者单次尝试的成本从"完整解密"降到"一次 HMAC"，
  那时真正的防线只剩 PBKDF2 的迭代次数本身。

保留它的理由是用户体验（密钥错时立刻告知）。界面的「自检密钥」（`checkKey`）
**不走统一失败与延迟** —— 它是一个显式查询接口，不属于失败路径。
解密主路径（`decryptFile`）不依赖它做判断：那里先验整体 MAC（见 D40）。

### 8.3 段拆分与重排没有安全收益

加密第 5 步把密文按字节交错拆成 3 份、再按 `SEGMENT_ORDER` 重排。
但 `SEGMENT_ORDER` / `SEGMENTS` / `SPLIT_MODE` / `CHUNK_SIZE` **全部明文写在头部**，
所以它是一个**完全公开、可逆的字节置换，不提供任何机密性**。

代价却是实打实的：逐字节写 3 个数组（cache 不友好的随机写模式）、
1 GB 文件要多分配 3 份再拼接、解密端还要再复制一轮；README 自述的 D10 那个真 bug 也正是这一步引入的。

本文档**不声称它有任何安全收益**；保留它是为了满足 SPEC 的"分层"要求。
若该要求被解除，删掉这一步是纯收益（见 `docs/SELFCRYPTO-REVIEW.md` C3）。

### 8.4 PBKDF2 已通过全部向量，但**未接入加密流程**

`crypto/pbkdf2.js` 的 10/10 向量全部通过，`common/constants.js` 定义了 `ITER = 600000`，
`file/format.js` 定义了 `FLAG_PASSPHRASE` —— 但**全项目没有任何一处调用** `pbkdf2Sha256`；
`encryptFile` 的主密钥来源只有"随机 16 字节"或"调用方自带"。

**结论：自研路线不提供口令加密。** 主密钥就是唯一凭据，**丢失即永久不可恢复**（没有可回忆的第二条路径）。
`FLAG_PASSPHRASE` 目前是一个"已预留但恒为 0"的标志位。
是否接上口令模式属**产品决策**，见 `docs/SELFCRYPTO-REVIEW.md` B1（尚未决定）。

### 8.5 其他如实标注

| 项 | 说明 |
| --- | --- |
| 明文的创建时间戳 | 头部偏移 12 的 4 字节 Unix 秒是明文（在 MAC 覆盖内，防篡改但不防读取）。元数据（文件名等）已加密，但**加密时间可从头部直接读出** |
| `RESERVED` 扩展位已锁死 | 偏移 10 的 2 字节"非零即拒绝"，等于宣告该扩展位永远只能为 0；将来要加字段只能升 `VERSION` |
| 主密钥 128 位 | `MASTER_KEY_LEN = 16`（AES-128-CTR）。长期归档可考虑 256 位，但需连带动 `expandKey` 的 `nk` 分支与全部向量；当前值由 SPEC 决定（D8） |
| 纯 JS 性能 | 实测约 1.8~2.0 MB/s 单向，1 GB 约需 8~9 分钟。这是"算法自己实现"的固有取舍，界面已如实提示 |

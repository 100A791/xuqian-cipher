# 自研加密（selfcrypto）代码审查意见

> 审查日期：2026-10-06 · 审查对象：`src/selfcrypto/`（约 4400 行）
> 性质：**只提意见，未改动任何一行自研算法代码**。所有结论均基于实读源码 + 可复现的实测，不采信既有文档的自述。
> 复现方式：本文「实测证据」一节的每个数字都可用一个临时 `.mjs` 脚本调用项目自身模块重跑。

---

## 0. 结论摘要

整体评价：**这是一份远超业余水平的实现**。域分隔的子密钥派生、encrypt-then-MAC、常数时间比较、统一失败出口、SBOX 由数学定义程序生成而非手抄、测试向量由 OpenSSL 独立生成而非手抄——这些取舍都对。

但审查发现了 **2 个可复现的真实缺陷、1 处关键能力缺口**，以及 **3 处"宣称的安全属性与实际不符"**。

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| A · 真实缺陷（建议修） | 2 | BOOT_NONCE 一半熵被丢弃；`randomBytes` 超限直接抛异常 |
| B · 能力缺口 | 1 | PBKDF2 通过全部向量却从未接入流程，自研路线没有口令模式 |
| C · 宣称与实测不符 | 3 | 统一延迟大文件失效；`checkKey` 旁路延迟；段拆分无收益 |
| D · 固有边界（建议如实标注） | 4 | SBOX cache-timing；128 位主密钥；明文时间戳；RESERVED 锁死 |
| E · 吹毛求疵 | 3 | `randomInt` 死循环边界；命名；`verifyHmac` 提前返回 |

---

## 0.5 处理状态（2026-10-06 更新）

用户确认的处理顺序是：**先修安全类 → 再修实际与宣传不符 → 最后收尾**。
下表是逐条落实结果。

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| A1 | ✅ **已修** | `blockCounter` 改为完整 128 位 nonce 计数器（新增 `addToCounter`）；新增 `FLAG_FULL_NONCE_COUNTER`（bit2）标记，**旧文件仍可解**。回归：`test_large_file`「完整 nonce」+ 交叉验证 D/E + 「v1 旧格式仍能解开」 |
| A2 | ✅ **已修** | `randomBytes` 分片填充（每片 ≤ 65536）。回归：`test_random` |
| B1 | ⏸ **待决策** | PBKDF2 仍未接入 —— 属**产品决策**。已先**在文档中明确宣告**"不提供口令加密"，见 `selfcrypto/README.md` §8.4 |
| C1 | ✅ **已修** | 解密顺序改为**先整体 MAC、后 KEY_CHECK**；新增 `padToUniformDuration` 按总耗时补齐延迟。回归：`test_uniform_delay`「等时化」 |
| C2 | ✅ **已标注** | `checkKey` 的定位与取舍写入代码注释 + `README.md` §8.2 + `SECURITY.md`。KEY_CHECK 字段本身保留（SPEC 要求） |
| C3 | ✅ **已标注** | `README.md` §8.3 与 §5.1 第 5 步明确标注"不提供机密性" |
| D1 | ✅ **已标注** | `README.md` §8.1 + `SECURITY.md`（这一条**原本完全缺失**） |
| D2 | ⏸ **待决策** | 主密钥 128 位：已列入 `README.md` §8.5 |
| D3 | ✅ **已标注** | `README.md` §8.5（明文时间戳） |
| D4 | ✅ **已标注** | `README.md` §8.5（RESERVED 扩展位锁死） |
| E1 | ✅ **已修** | `randomInt` 加 span 上界校验 + 回归测试 |
| E2 | ✅ **已修** | `encryptPayload` 加注释说明"加密/解密共用同一函数" |
| E3 | ✅ **已标注** | `verifyHmac` 注明"仅测试使用，生产请用 `timingSafeEqual`" |
| §6 切片 | ✅ **已修** | `parseHeader` 改用 `copyRange()` 显式复制；`splitFile` 明确写 `subarray()` 表达视图意图；`metadata.js` 解出的取值改显式复制；`bytes.js` 的规矩表述精确化 |

**新增测试**：+7 项（随机数 +2、文件加解密 +3、大文件 +1、统一延迟 +1）；自研路线断言数 **227 → 234**（套件数仍为 15）。

**未改动**：`sha256.js` / `hmac.js` / `pbkdf2.js` / `aes.js` / `ctr.js` 的算法实现本身、`ai/`、`watermark/`、简单路线（`src/crypto/`）。

**两处仍需你决定（未擅自更改）**：

1. **B1**：要不要给自研路线接上口令模式（PBKDF2）？
   - 接上 → 用户多一层"可回忆的凭据"，但纯 JS 600k 迭代需实测标定，且 KEY_CHECK 会成为口令验证器；
   - 不接 → 保持现状，但已明确宣告"密钥丢失即永久不可恢复"。
2. **D2**：主密钥是否升到 256 位（AES-256-CTR）？需连带动 `expandKey` 的 `nk` 分支与全部向量。

---

## 1. A 级 · 真实缺陷

### A1. `BOOT_NONCE` 只有前 8 字节参与加密，一半随机性被丢弃

**位置**：`src/selfcrypto/file/encrypt.js:33-39`

```js
export function blockCounter(bootNonce, chunkIndex) {
  const counter = new Uint8Array(16)
  counter.set(bootNonce.subarray(0, 8), 0)                              // ← 只用了前 8 字节
  counter.set(writeUint64BE(BigInt(chunkIndex) * BigInt(BLOCKS_PER_CHUNK)), 8)
  return counter
}
```

后 8 字节被 `u64(块偏移)` **完全覆盖**，而块 0 的偏移是 0 → 后 8 字节恒为全零。文件头里那 16 字节 `BOOT_NONCE`（偏移 16）中有 8 字节是死数据。

**实测证据**（构造两个前 8 字节相同、后 8 字节完全不同的 BOOT_NONCE）：

```
n1 = 0102030405060708 0909090909090909
n2 = 0102030405060708 0707070707070707
c1 = 369d931342ed4bcb7c15f20fbca81a4ef3e6227e4a728acf3599d4c42fde870d...
c2 = 369d931342ed4bcb7c15f20fbca81a4ef3e6227e4a728acf3599d4c42fde870d...
→ 密文逐字节相同：true
```

块计数器实际取值：

```
块 0 = 0102030405060708 0000000000000000   ← 后半被全零覆盖
块 1 = 0102030405060708 0000000000010000   ← 0x10000 = 65536 块计数器
→ 有效 nonce 空间 = 8 字节 = 64 位
```

**影响**：CTR 的 nonce 空间从 2^128 降为 **2^64**。在"同一主密钥加密多个文件"（`encryptFile` 支持调用方自带 `masterKey`）时，两个文件的 nonce 前缀碰撞即导致**密钥流复用**——而密钥流复用对 CTR 是灾难性的（异或两段密文可消去密钥流）。生日界为 2^32 ≈ 43 亿个文件。

对个人本地工具，这个概率可以忽略；但**这是白送的 64 位熵，丢掉它没有任何理由**。

**建议修法**：把 16 字节 nonce 当 128 位整数，块 i 的起点 = `nonce + i × 65536`（128 位大端加法）。`ctr.js` 里已有 `incrementCounter` 实现了这个加法，直接复用即可，改动约 5 行。

**旁证**：同一项目的 `watermark/watermark_crypto.js:47` 用的是**完整 16 字节** nonce（`aesCtr(encKey, nonce, plainBytes)`），做法是对的。同一个代码库里两处不一致，说明这是文件格式层的疏漏而非有意设计。

---

### A2. `randomBytes` 超过 65536 字节直接抛异常

**位置**：`src/selfcrypto/crypto/random.js:9-14`

```js
export function randomBytes(length) {
  if (!Number.isInteger(length) || length < 0) throw new RangeError('randomBytes 长度非法')
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)      // ← WebCrypto 单次上限 65536 字节
  return out
}
```

**实测证据**：

| 调用 | 结果 |
| --- | --- |
| `randomBytes(16)` | 成功 |
| `randomBytes(65536)` | 成功 |
| `randomBytes(65537)` | **抛错** `QuotaExceededError: The requested length exceeds 65,536 bytes` |
| `randomBytes(1048576)` | **抛错** 同上 |

**影响**：目前全部调用点都 ≤32 字节（SALT 32 / BOOT_NONCE 16 / 主密钥 16），所以没有暴露。但它是**公开导出的通用工具函数**，任何将来想用它生成大块随机数据（如一次生成大文件的一次性填充）的代码都会直接崩。而且抛出的 `QuotaExceededError` 是 `DOMException`：

1. 与函数内其它校验风格不一致（那些抛 `RangeError`）；
2. 消息容易被误读成"磁盘配额不足"，排错方向完全错。

**建议修法**：分片填充。

```js
const CHUNK = 65536
for (let i = 0; i < length; i += CHUNK) {
  crypto.getRandomValues(out.subarray(i, Math.min(i + CHUNK, length)))
}
```

**建议配套**：加一条断言 `randomBytes(65537).length === 65537` 的回归测试——项目对同类"潜伏 bug"（`randomUint32` 退化成 8 位）已有加回归测试的传统。

---

## 2. B 级 · 能力缺口

### B1. PBKDF2 通过了全部向量，却从未接入加密流程

**证据**：全项目搜索 `pbkdf2Sha256` / `pbkdf2Default` / `ITER`，**除 `pbkdf2.js` 自身与其向量测试外没有任何调用点**。而 `encryptFile` 的主密钥来源只有两条：

```js
const keyK = options.masterKey ? copyBytes(...) : randomBytes(MASTER_KEY_LEN)   // encrypt.js:133
```

`format.js:54` 定义了 `FLAG_PASSPHRASE = 0b0000_0010`，`FLAG_KNOWN_MASK` 也认它，但**没有任何代码会设置这一位**（`flags` 一律来自 `options.flags ?? 0`，界面不传）。

**后果**：自研路线**只能靠 128 位随机密钥**。用户必须原样保管那 32 个 hex 字符；密钥文件一丢，数据**永久不可恢复**——因为没有可回忆的口令作为第二条路径。而 SPEC 阶段一要求实现 PBKDF2 的意图，几乎可以肯定就是"用口令保护密钥"。

这同时解释了为什么 `constants.js:19` 的 `ITER = 600000` 从未被性能质疑过：**它跑不到**。

**两条路，建议二选一（并同步更新文档）**：

| 选项 | 内容 | 代价 |
| --- | --- | --- |
| ① 接上 | 口令 → `pbkdf2Default(pwd, salt)` → K，置 `FLAG_PASSPHRASE`；密钥文件里只存盐与校验值 | 纯 JS 600k 迭代会**非常慢**（见下），需实测标定合理的 ITER；且 KEY_CHECK 会变成口令验证器（见 C2） |
| ② 明确宣告 | 在 README/SECURITY 写明"本路线不提供口令加密，密钥即唯一凭据，丢失不可恢复"；并把 `pbkdf2.js` 标注为"仅通过向量、未接入流程" | 用户少一层保障，但至少不会误以为有口令保护 |

**补充实测（若选 ①）**：纯 JS SHA-256 的吞吐远低于 WebCrypto。600000 次迭代 × 2 次压缩 × 64 字节 ≈ 76.8 MB 哈希量，按本项目实测的 40 MB/s 量级推算约 **2 秒**（未含 HMAC 的额外开销，实际更慢）。这个量级尚可接受，但必须实测确认，不能靠推算。

---

## 3. C 级 · 宣称的安全属性与实测不符

### C1. 「统一延迟」在文件超过约 160 MB 时失效

**宣称**（README 与 SPEC §7 反复强调）：失败一律走 `common/fail.js`，先等 4~5 秒随机延迟，使「密钥错」与「文件被改」**在时间上不可区分**。

**问题**：解密顺序是先验 KEY_CHECK、再验整体 MAC（`decrypt.js:67-82`）。

```js
// ① 校验密钥（KEY_CHECK）—— 只需 1 次 HMAC，微秒级
if (!timingSafeEqual(deriveKeyCheck(masterKey, header.salt), header.keyCheck)) return fail('key-check-mismatch')
// ② 校验整体 MAC —— 必须读完整个文件
const expectedMac = hmacSha256(macKey, concatBytes(macHeaderBytes(...), rules, payload))
```

于是两条路径的真实耗时：

| 场景 | 计算量 | 加上延迟后总耗时 |
| --- | --- | --- |
| 密钥错 | 1 次 HMAC（~40 字节） | ≈ 4.0~5.0 秒 |
| 密钥对、文件被改 | 完整文件 HMAC | 4~5 秒 **+ 文件 MAC 时间** |

**实测证据**（纯 JS HMAC-SHA256，即整体 MAC 所用的原语）：

```
8 MB 用时 199 ms → 40.10 MB/s
推算 1 GB 的整体 MAC 校验 ≈ 25.5 秒
推算 4 GB 的整体 MAC 校验 ≈ 102.1 秒
```

**阈值**：MAC 耗时超过延迟窗口下界（4 秒）对应约 **160 MB** 的文件。超过之后，两类失败的耗时差以「几十秒到上百秒」计，统一延迟被完全淹没。

**这是本审查中最重要的发现之一**：一个被文档当作核心安全特性来承诺的属性，在常见文件尺寸下并不成立。

**建议修法**：把「固定延迟」改成「**目标总时长**」。失败时记录流程起始时刻，sleep 到总耗时落入 4~5 秒的随机目标；若实际耗时已超过目标，则补一个随机抖动后返回。这样"密钥错"与"MAC 错"的**总时长**才真的一致，而不是"额外附加的延迟"一致。

**附注（威胁评估要诚实）**：这个时间差泄露的信息是"密钥是否正确"。而由于 KEY_CHECK 明文在文件头里，攻击者拿到文件后**本来就能自己算**（见 C2），无需测时间。所以该侧信道的**增量**价值有限——但"宣称成立与否"是独立的问题，不能因为增量小而忽略。

---

### C2. `checkKey` 是一个零延迟的密钥验证预言机，且已从界面可达

**位置**：`decrypt.js:27-31` 导出 `checkKey`，`src/components/selfcrypto/SelfDecryptPage.tsx:187` 直接调用：

```js
setResult({ name: '', size: 0, keyOk: checkKey(source.bytes, key) })
```

`checkKey` **只做一次 HMAC、不抛统一失败、不带任何延迟**。同一个问题（"这个密钥对吗？"）在自研路线内部有两个接口，一个带 4~5 秒延迟（`decryptFile`），一个零延迟（`checkKey`）——后者把前者想建立的"不可区分"直接旁路了。

更有意义的是**离线维度**：`KEY_CHECK` 是明文写在文件头偏移 77 的 16 字节，且其定义 `HMAC(K, salt ‖ "xq/v1/check")` 只需要头部（salt + keyCheck）就能验证。也就是说**攻击者只拿 97 字节的文件头，就能对任意密钥候选做一次 HMAC 来判定对错，完全不需要文件主体、也不需要触碰解密流程**。

**影响分级**：

- 对**随机 128 位主密钥**：无实质影响（不可能穷举）。
- 若将来接上**口令模式**（B1 选项 ①）：KEY_CHECK 立刻变成**口令验证器**，会让"统一失败"形同虚设——攻击者可以对每个口令候选只跑一次 HMAC（甚至不需要跑 PBKDF2，因为……不，仍需 K 才能算 HMAC，所以 PBKDF2 仍是唯一防线）。准确说：它提供的是一个**廉价的确认步骤**，把攻击者的成本从"完整解密"降到"一次 HMAC"。

**建议**：把 KEY_CHECK 的定位写清楚——**它是用户体验优化（快速告诉用户密钥错了），代价是提供一个明文可验证的预言机**。若能接受，就在 SECURITY.md 里如实标注这条取舍；若不接受，就把它移到 MAC 校验之后，或干脆去掉（代价是密钥错时用户要多等一次完整文件 MAC）。

---

### C3. 段拆分与重排（`interleaveSplit` + `reorderShares`）没有安全收益，只有代价

**位置**：`encrypt.js:47-94`，加密第 5 步。

这步把密文按字节交错拆成 3 份，再按 `SEGMENT_ORDER` 重新拼接。但：

- `SEGMENT_ORDER` **明文写在文件头偏移 42**（3 字节）；
- `SEGMENTS`（偏移 40）、`SPLIT_MODE`（偏移 41）、`CHUNK_SIZE`（偏移 36）同样明文。

也就是说，这是一个**完全公开、可逆的字节置换**。攻击者照着头部就能还原，**零混淆价值**。

代价却是实打实的：

1. **性能/内存**：`shares[j][cursor[j]++] = bytes[i]` 是逐字节写入 3 个不同 TypedArray 的随机写模式，cache 极不友好；1 GB 文件要额外分配 3 个共 1 GB 的份再拼接出 1 GB 的 payload。
2. **复杂度即 bug 来源**：README 自述的 D10 真 bug（"重排后的段边界"切错）正是这一步引入的，而且是**由与 OpenSSL 的交叉验证才抓出来的**。
3. **解密端还要再复制一轮**（`unreorderShares` 里三次 `new Uint8Array(len)` + `set`）。

**公平地说**：README 没有声称它有安全收益（这点是诚实的）。但既然它只是格式特性，就有两条改进路：

| 选项 | 内容 |
| --- | --- |
| ① 标注 | 在 FORMAT.md / README 明确写"段拆分是格式特性，**不提供任何机密性**，仅用于……"（若确有工程用途，如"避免单块连续损坏导致全文件不可用"之类，要写明） |
| ② 去掉 | 直接删除这一步，`payload = ciphertext`。省一次 O(n) 分配与两轮拷贝，并消掉一整类 bug |

如果 SPEC 的"分层"要求是硬约束，选 ①；否则 ② 在纯技术上是净收益。

---

## 4. D 级 · 算法固有边界（建议如实标注，不建议硬修）

### D1. 纯 JS AES 的 SBOX 查表存在 cache-timing 侧信道

**位置**：`src/selfcrypto/crypto/aes.js:50`

```js
const subByte = (b) => SBOX[b]      // 索引同时依赖密钥与数据
```

这是密码学实现的经典时序攻击面（Bernstein 2005 的 AES cache-timing、Osvik–Shamir–Tromer 的 cache 攻击、2017 年的 CacheBleed）。

**为什么建议标注而非修**：

- 在"本地单机浏览器 + 攻击者若能同机就有更大手段"的威胁模型下，这个侧信道没有额外价值。
- 在**共享 CPU**（云桌面、多租户虚拟机）上它是真实的。
- 常数时间替代方案（位切片 bitslicing、或每次现算 `gfInv`）会慢一到两个数量级；对一个已经只有约 2 MB/s 的实现并不现实。

**建议**：在 SECURITY.md 里补一条已知边界——"自研路线使用查表型 AES，存在 cache-timing 侧信道；对侧信道敏感的场景请使用简单路线（WebCrypto 有硬件加速且常数时间）"。这正是这个项目一贯的诚实风格，而目前这一条是**缺失的**。

### D2. 主密钥 128 位（AES-128-CTR）

`kdf.js:20` `MASTER_KEY_LEN = 16`。AES-128 不是"弱"，但长期归档通常建议 256 位。AES-256 只多 4 轮，对纯 JS 实现约慢 40%。这是 SPEC 定的（D8），若改需连带动 `expandKey` 的 `nk` 分支与全部向量。**仅列出供决策，不催**。

### D3. 明文的 TIMESTAMP 泄露加密时间

头部偏移 12 的 4 字节 Unix 秒是明文。它在 MAC 覆盖范围内（防篡改）但不防读取。元数据（文件名等）已经加密了，而时间戳仍暴露"这文件何时加密的"。

若要收紧，可把时间戳挪进加密元数据；但注意这与简单路线的"时间戳附加盐"设计耦合（那边需要它明文参与 HKDF 的 `info`），两条路线要一起考虑。

### D4. `RESERVED` 非零即拒绝 —— 扩展位已被锁死

`format.js:167-168`：`RESERVED != 0` 直接抛 `RESERVED_FIELD_UNSUPPORTED`，等于宣告这 2 字节**永远只能为 0**，将来想加字段只能升 `VERSION`。

在 v1 这是可接受的（清晰优于灵活，符合项目一贯的"不明确即拒绝"）。仅提醒：这是一个**已被主动锁死的扩展位**，如果预期格式还会有演进，值得在 FORMAT.md 里写明这条约束的由来。

---

## 5. E 级 · 吹毛求疵

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| E1 | `crypto/random.js:25-34` | `randomInt` 未校验 `span` 上界：若 `span > 2^32` 则 `limit = 0`，`value < 0` 永不成立 → **死循环**。当前调用方（4000~5000ms）不会触发，但它是导出函数 | 加一行 `if (span > 0x100000000) throw new RangeError(...)` |
| E2 | `file/decrypt.js:88` | 解密时调用 `encryptPayload(...)`（CTR 对称故正确），但审计者读到"解密调用了 encrypt"会卡一下 | 重命名为 `ctrTransform`，或在该行加一句注释 |
| E3 | `crypto/hmac.js:49` | `verifyHmac` 在长度不符时提前 `return false`，不是常数时间（虽然长度不敏感）；且解密主路径用的是 `compare.js` 的 `timingSafeEqual`，此函数实际只被测试使用 | 统一到 `timingSafeEqual`，或标注"仅测试用" |

---

## 6. 一处「文档声明与代码不符」

`common/bytes.js:7-9` 明确立规：

> **一律用 `new Uint8Array(x)` 复制，不要用 `x.slice()`**。Node 的 `Buffer.prototype.slice` 其实是 subarray（共享内存的视图）……

README:91 也声称：

> 现已全部改为 `new Uint8Array(x)` 显式复制

但实际仍有 **9 处 `.slice()` 在格式/元数据层**：

| 文件 | 行号 |
| --- | --- |
| `file/format.js` | 174, 179, 180, 181, 227, 228, 229, 231 |
| `file/metadata.js` | 134 |

对 Node `Buffer` 入参，这些返回的是**共享内存的视图**而非副本。**当前不会出错**（这些字段只被读取，不被就地改写），但：

1. 这是同一类坑的复发点（`aes.js` 已经踩过一次）；
2. 它让"文档声明"与代码事实不符——而"文档会腐化，测试不会"正是这个项目自己写下的原则。

**建议**：要么把这 9 处改成显式复制，要么把 README 那句话改成准确表述（例如："算法层已全部改为显式复制；格式层有意使用视图以避免大文件多一次拷贝"——如果是刻意为之的话）。**两种都行，但不该维持现状的模糊。**

---

## 7. 未审查 / 未验证的部分（诚实边界）

- **`sha256.js` / `pbkdf2.js` 的实现细节**：本文只依赖"各套向量全部通过"这一事实，未逐行审阅。考虑到向量由 OpenSSL 独立生成（`tools/gen_vectors.js`），这个信心是有依据的。
- **FIPS 197 / SP 800-38A 之外的边界用例**：未构造畸形输入做 fuzz。
- **侧信道未做实测**：D1 的 cache-timing 是**理论分析**，没有在本机测量。仅凭源码可判定其存在（查表索引依赖密钥），但未量化。
- **`ai/` 与 `watermark/` 的算法质量**：本次聚焦密码学与格式层，AI 检测的权重标定、LSB 水印的鲁棒性不在本次范围内（且 README 已如实标注为已知缺口）。
- **简单路线（`src/crypto/`）**：未在本次范围内。

---

## 8. 建议的处理顺序

如果要动手，建议按此顺序（投入产出比递减）：

1. **A2**（`randomBytes` 分片）—— 5 行 + 1 条回归测试，纯收益。
2. **A1**（BOOT_NONCE 用满 16 字节）—— 约 5 行，消除一处密钥流复用隐患。注意：**改动会破坏格式兼容**，需要升 `VERSION` 或把"计数器构造方式"记进头部（后者更符合本项目"结构性选择写进文件"的既有取向）。
3. **B1**（PBKDF2 接不接）—— 这是**产品决策**，不是纯技术问题，建议先定方向。
4. **C1**（统一延迟改成目标总时长）—— 中等改动，但它修复的是一条**已经在文档里承诺过的安全属性**。
5. **C2 / C3 / 第 6 节** —— 主要是文档与标注工作，成本低但能消除"宣称与事实的落差"。
6. **D 级** —— 补进 SECURITY.md 的已知边界，零风险。

---

*本文仅为审查意见，没有对 `src/selfcrypto/` 做任何修改。以上每条都可独立验证或独立否决。*

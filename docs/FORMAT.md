# `.XUQIAN` 与 `.XUQIANKEY` 格式规范（v1）

本文档与代码一一对应，实现见 [`src/crypto/container.ts`](../src/crypto/container.ts)
与 [`src/crypto/keyfile.ts`](../src/crypto/keyfile.ts)。

所有多字节整数均为**大端序（Big-Endian）**，所有 base64 均为**标准 base64（含 `=` 填充）**。

---

## 一、密钥体系

### 1.1 主密钥

| 项 | 值 |
| --- | --- |
| 长度 | 128 位（16 字节） |
| 生成 | `crypto.getRandomValues` |
| Hex 表示 | 32 个字符（小写） |
| Base64 表示 | 24 个字符（16 字节 = 128 位，base64 恰好 24 字符含 `==`） |
| 指纹 | `SHA-256(主密钥)` 的前 **8 字节**，以大写 Hex 展示（16 字符） |

主密钥是唯一的解密凭证，**不被写入 `.XUQIAN` 文件的任何位置**。

### 1.2 子密钥派生（HKDF-SHA256）

每一层使用独立随机 16 字节 salt，通过 HKDF 派生该层子密钥：

```
info  = "XUQIAN/v1/subkey|" + layerIndex + "|" + algoId + "|" + keyLength + "|" + kdfTag
subkey_k = HKDF-SHA256(IKM = 主密钥, salt = salt_k, info = info_k, L = keyLength(algo))
```

- `layerIndex` 从 0 开始
- `algoId` 例如 `AES-128-GCM`
- `kdfTag` 例如 `aes128gcm`
- 因此**更换算法或调整层顺序都会产生完全不同的子密钥**

### 1.3 nonce 派生（分块与多块）

每层有一个独立的 16 字节 **nonce 种子**（`layer.n`）。第 k 层、第 c 个分块的 nonce：

```
info  = "XUQIAN/v1/nonce|" + layerIndex + "|" + chunkIndex + "|" + nonceLength
nonce = HKDF-SHA256(IKM = layer.n, salt = 主密钥, info = info, L = nonceLength(algo))
```

- `nonceLength`：AES-*/ChaCha20/SM4 为 12 字节，XChaCha20 为 24 字节
- 主密钥参与 salt，保证不同文件、不同层、不同块之间的 nonce 互不相同（**绝不复用**）

---

## 二、`.XUQIAN` 文件格式

### 2.1 总体布局

```
┌──────────────────────── 文件头（明文，可读，不含密钥） ────────────────────────┐
│ magic(6) │ ver(1) │ flags(1) │ chunkSize(4) │ chunkCount(4) │ layerCount(1) │
│ headerLen(4) │ headerJson(headerLen)                                        │
├──────────────────────── 块区（chunkCount 个块首尾相接） ──────────────────────┤
│ block_0 │ block_1 │ … │ block_{cc-1}                                          │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 文件头字段

| 偏移 | 长度 | 字段 | 说明 |
| --- | --- | --- | --- |
| 0 | 6 | `magic` | ASCII `XUQIAN` |
| 6 | 1 | `version` | 当前为 `1` |
| 7 | 1 | `flags` | bit1 = `0x02` 表示容器内明文经过 gzip |
| 8 | 4 | `chunkSize` | 每块占用文件字节数的上限（默认 67108864 = 64 MiB） |
| 12 | 4 | `chunkCount` | 块数量（最小 1；空文件也是 1 块） |
| 16 | 1 | `layerCount` | 加密层数 1~10 |
| 17 | 4 | `headerLen` | 紧随其后的 `headerJson` 字节数 |
| 21 | N | `headerJson` | UTF-8 JSON（见下） |

`headerLen` 位于固定偏移 17，因此解析头部不需要先知道 JSON 长度。

### 2.3 `headerJson` 结构

```jsonc
{
  "v": 1,
  "flags": 0,
  "cs": 67108864,          // chunkSize
  "cc": 1,                 // chunkCount
  "lc": 3,                 // layerCount
  "layers": [              // 顺序 = 加密顺序；解密必须逆序
    { "a": "AES-256-GCM",         "s": "<base64 16B salt>", "n": "<base64 16B nonce 种子>" },
    { "a": "CHACHA20-POLY1305",   "s": "...",               "n": "..." },
    { "a": "SM4-GCM",             "s": "...",               "n": "..." }
  ],
  "meta": {
    "n":  "report.pdf",     // 原始文件名（解密后还原）
    "m":  "application/pdf", // 原始 MIME
    "s":  624,              // 容器内明文字节数（含声明；分块布局依赖它）
    "os": 3000,             // 原始字节数（仅在 gzip 时与 s 不同）
    "h":  "614FA9…C0E4",    // 容器内明文（声明 + 内容）的 SHA-256（大写 Hex）
    "t":  1730000000000,    // 创建时间（epoch ms）
    "k":  "bytes",          // bytes | text
    "c":  "备注文本",         // 用户备注（可选）
    "nl": 485,              // 明文声明区里声明的字节数（须与文件偏移 7 处一致）
    "nh": "D808AAB4…4C2F", // 明文声明的 SHA-256（大写 Hex）：删改声明即解密失败
    "exp": 1730100000000    // 到期提醒时间（可选，纯提示）
  },
  "crc": 79261993           // 头部 CRC32（覆盖除 crc 外的全部字段）
}
```

**这些字段全部参与 AEAD 的 AAD**，因此任何篡改（甚至只改一个文件名字符）都会导致解密失败。
头部另有 CRC32 用于快速定位"头部被改"的情况。

#### 磁盘排布与"什么进认证"（重要，已实验验证）

AAD 与 CRC 都由 `canonicalHeader()` 计算，而它**重建**一个固定字段顺序的对象
（`{v, flags, cs, cc, lc, layers:[{a,s,n}], meta}`）。由此得出三条硬结论：

| 改动 | 是否影响 AAD/CRC | 说明 |
| --- | --- | --- |
| **空白排版**（缩进、换行） | **不影响** | 解析后重新规范化，排版纯属可读性 |
| **顶层键顺序** | **不影响** | 顶层是重建的，多余顶层字段也会被丢弃 |
| `layers` 内的多余字段 | **不影响** | layers 逐项重建为 `{a,s,n}` |
| **`meta` 内部的键顺序** | **影响** | `meta` 按引用直接序列化；重排即换 AAD |
| `meta` 内的任何增删改 | **影响** | 同上 |

因此本实现把磁盘头部写成**人可读排布**：缩进 2 空格、`meta` 提到顶层最前、
`meta.no`（加密声明）再排 `meta` 最前。用任意文本编辑器打开 `.XUQIAN`，
紧跟 6 字节魔数与 15 字节定长字段之后，就能直接读到完整声明与元信息：

```
[明文声明前导区 11+N 字节] ‖ XUQIAN<6+15 字节定长字段>{
  "meta": {
    "nl": 485,              ← 与偏移 7 处记录的一致
    "nh": "D808AAB4…4C2F",  ← 明文声明的 SHA-256
    "n": "photo.jpg",
    ...
  },
  "v": 1, "flags": 0, "cs": ..., "cc": ..., "lc": 1,
  "layers": [ { "a": "AES-128-GCM", "s": "...", "n": "..." } ],
  "crc": 945194560
}
```

> 重新实现者注意：**不要为了美观重排 `meta` 的键**——那会改变 AAD，
> 使已存在的文件无法解密。想调整声明位置，只能在自己产出的新文件里决定写入顺序。
> 本项目的 `meta` 写作顺序是 `no, nl, n, m, k, t, c, exp, os`（`s`/`h` 由引擎追加在末尾）。


### 2.3.1 加密声明（明文前导区）

**顺序是「先加密内容，再把声明以明文写在文件最前面」**；解密时**先去声明、再解容器**：

```
.XUQIAN 文件 = [明文声明前导区] ‖ [加密容器]

明文声明前导区（全部明文，不需要密钥）:
  offset 0   "XUQIAN"        6 字节（与容器同一个魔数）
  offset 6   0x02            1 字节标记：2 = 存在明文声明前导区（容器自身 version 为 1，故可区分）
  offset 7   声明字节数        4 字节大端（上限 4096）
  offset 11  声明正文（UTF-8）  N 字节
  offset 11+N  加密容器开始
```

加密容器本身（`2.1` 起描述的布局）**不含声明**：其明文字节就是原文件内容（或 gzip 后的内容）。

性质与约束：

| 项目 | 说明 |
| --- | --- |
| 位置 | 文件**最开头**，明文，任何人可直接读到 |
| 长度依据 | 头部 `nl`（声明字节数），须与偏移 7 的值、与声明实际 UTF-8 字节数三者一致 |
| 完整性 | 头部 `nh` = 声明正文的 SHA-256（大写 Hex），写入**加密**头部并参与 AAD |
| 篡改检测 | 解密第一步就比对 `nh`：声明被改写 → 报「声明已被改动」；声明区被整体删除 → 报「声明区已被删除」。两者都**拒绝解密** |
| 解密顺序 | ① 读前导区拿声明与容器偏移 → ② 从偏移处解析加密头部 → ③ 校验 `nh`/`nl` → ④ 从偏移处解密 |
| 向后兼容 | 偏移 6 为 1（或无前导区）＝旧格式：声明曾在**加密内容内部**（`meta.no` 存文本、`meta.nl` 存长度），解密后再剥离。两条路径按该标记字节区分 |
| 不可去除 | 不是"工具不给选项"，而是**密码学强制**：删掉或改写明文声明都会导致解密失败 |
| 诚实的边界 | 持有密钥者用**别的工具**重新加密，理论上仍可产出不带声明的文件；本工具只能保证"本工具产出的文件一定带声明" |

默认声明文本（中文界面 485 字节；英文界面另有一份）：

```
XUQIAN 认证加密文件 ｜ 由 XUQIAN 加密站（许七安密匣）在本地浏览器生成，文件与密钥从未上传。
以下内容是加密的：没有密钥无法读取，也无法伪造或选择性篡改；任何字节改动都会导致解密失败。
这段声明是明文，写在密文的最开头；它被记入加密头部的哈希，删掉或改写它同样会导致解密失败。
密钥不在本文件内，需由发送方另行提供；密钥丢失无法恢复。
```

> 为什么声明不做成"明文写在文件后"或"只放在头部字段里"：
> 放在最前面是为了收件人**打开文件第一屏就看到**；做成独立前导区（而不是复用头部 JSON 字段）
> 是为了让"删掉声明"这件事能被检测到——头部 JSON 里若只存文本，删掉它只会让头部变短而无法判断
> "本来该有"。现在头部只存**哈希**，缺失即报错。


算法 ID 的取值集合：

| 算法 ID | 子密钥长度 | nonce 长度 | tag 长度 | 实现 |
| --- | --- | --- | --- | --- |
| `AES-128-GCM` | 16 | 12 | 16 | WebCrypto（后备 `@noble/ciphers`） |
| `AES-256-GCM` | 32 | 12 | 16 | WebCrypto（后备 `@noble/ciphers`） |
| `CHACHA20-POLY1305` | 32 | 12 | 16 | `@noble/ciphers` |
| `XCHACHA20-POLY1305` | 32 | 24 | 16 | `@noble/ciphers` |
| `SM4-GCM` | 16 | 12 | 16 | 本项目 GB/T 32907 + SP 800-38D 实现 |

### 2.4 AAD 构造

```
AAD = magic(6) || version(1) || flags(1) || chunkSize(4) || chunkCount(4) || layerCount(1)
      || algByte[layerCount] || headerLen(4) || canonicalHeader
```

- `algByte`：算法稳定编号（`AES-128-GCM`=0, `AES-256-GCM`=1, `CHACHA20-POLY1305`=2,
  `XCHACHA20-POLY1305`=3, `SM4-GCM`=4），**顺序不可调整**
- `canonicalHeader`：`JSON.stringify` 出的规范化头部（字段顺序固定，`crc` 被排除）

### 2.5 单块布局（关键）

设 `L` = 层数，`pj` = 该块明文长度，`T` = 16（tag 长度）。

```
headLen = pj + L×T            // 第 L−1 层（最外层）的完整 AEAD 输出长度
blockTotal = pj + (2L−1)×T    // 该块在文件中占用的字节数

块内布局：
[ 第 L−1 层完整输出: 密文(pj+(L−1)T) + tag_{L−1}(T) ][ tag_0 ][ tag_1 ] … [ tag_{L−2} ]
```

**为什么是这个布局**：AEAD 每次加密都把 16 字节 tag 追加到输出末尾。
第 k 层的输入长度为 `pj + k×T`，输出为 `pj + (k+1)×T`，因此**每一层的 tag 都内嵌在
"下一层输入"的末尾**。容器只需额外保存第 `0…L−2` 层的 tag，第 `L−1` 层的 tag 已经在
head 的末尾。

### 2.6 加密流程

```
输入：容器内明文 P（可能已 gzip），主密钥 K，层数组 algos[0..L-1]

1. 为每层生成 salt_k、nonceSeed_k，并派生 subkey_k
2. 构造 headerJson（含 meta.s = |P|、meta.h = SHA256(P)），计算 AAD
3. 按 (chunkSize − L×T) 把 P 切成块
4. 对每个块：
     current = plaintext_chunk
     for k in 0..L-1:
         sealed = AEAD_seal(subkey_k, nonce(k), current, AAD)   // 长度 = |current| + 16
         tag_k  = sealed 最后 16 字节
         current = sealed
     // current 即第 L−1 层完整输出，长度 headLen
     block[0 .. headLen)        = current
     for k in 0..L-2:
         block[headLen + k×16 .. +16) = tag_k
5. 文件 = 序列化头部 || 各块
```

### 2.7 解密流程

```
输入：.XUQIAN 文件字节，主密钥 K

1. 解析头部（校验 CRC32），若 meta.s 缺失则无法确定布局 → 报错
2. 用 (meta.s, chunkSize, L) 重建完全相同的分块布局（planChunks）
3. 对每个块：
     payload = block[0 .. headLen−16)              // 第 L−1 层的密文主体
     for k = L−1 down to 0:
         tagPos  = (k == L−1) ? headLen−16 : headLen + k×T
         tag     = block[tagPos .. tagPos+16)
         inputLen= pj + k×T
         sealed  = payload[0 .. inputLen) || tag
         out     = AEAD_open(subkey_k, nonce(k), sealed, AAD)
         payload = out
     得到该块明文
4. 拼接所有块 → 得到容器明文 P
5. **剥离声明**：`content = P[meta.nl:]`（无 `nl` 但有 `no` 时用 `no` 的 UTF-8 字节数推导；
   两者都没有则视为旧文件、不剥离）。若 `no` 同时存在，会校验 `P[0..nl)` 与 `no` 的 UTF-8 完全一致
6. 若 flags 含 gzip 则解压 `content` → 得到原始文件
```

哈希校验（`meta.h`）在**剥离声明与解压之前**完成：它覆盖的是完整的容器明文 P（声明 + 内容）。

任何 `AEAD_open` 失败都会被统一映射为 `AUTH_FAILED`，对用户表现为
**"密钥错误或文件损坏"**，绝不区分具体层或原因。

---

## 三、`.XUQIANKEY` 密钥文件格式

JSON 文本文件，`Content-Type: application/json`。

### 3.1 未设置密码

```json
{
  "format": "XUQIANKEY",
  "version": 1,
  "protected": false,
  "keyHex": "b7ba755ec104afcf47d86ab4183627a5",
  "keyB64": "t7p1XsEEr89H2Gq0GDYnpQ==",
  "fingerprint": "6C0375D6A5ACD4D7",
  "layers": ["AES-128-GCM"],
  "createdAt": 1730000000000,
  "chunkSize": 67108864,
  "gzip": false,
  "note": "可选备注",
  "warning": "此文件等同于你的 128 位主密钥……",
  "checksum": "3F2A9C1B7E4D5081"
}
```

`checksum` = `SHA-256("keyHex|fingerprint|layers 逗号连接|createdAt")` 的前 8 字节的
大写 Hex，用于检测手改/损坏。

### 3.2 密码保护

```json
{
  "format": "XUQIANKEY",
  "version": 1,
  "protected": true,
  "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000, "salt": "<base64 16B>" },
  "cipher": "AES-256-GCM",
  "nonce": "<base64 12B>",
  "sealed": "<base64>",
  "fingerprint": "6C0375D6A5ACD4D7"
}
```

- `KFK = PBKDF2-SHA256(密码, salt, 600000 次迭代, 32 字节)`
- `sealed = AES-256-GCM(KFK, nonce, UTF8(明文密钥文件 JSON), AAD = "XUQIANKEY")`
- `fingerprint` 保留在明文头，方便用户在不知道密码的情况下确认"这是哪把密钥"

密码错误与文件损坏统一报 `KEYFILE_PASSWORD_WRONG`。

---

## 四、Shamir 分片文本格式

```
XUQIAN-SHARE-<x>of<total>-<threshold>-<base64(y)>
```

- `x`：分片编号，1~255
- `total`：总分片数
- `threshold`：门限 M（至少 M 份可恢复）
- `y`：该分片的字节（长度与主密钥相同，16 字节），标准 base64

底层为 GF(2^8)（生成元 `0x03`，约化多项式 `x^8+x^4+x^3+x+1`，与 AES 同款）
上的 Shamir 多项式插值：对主密钥的每个字节独立构造 `M−1` 次多项式 `f`，
满足 `f(0) = 该字节`，分片 `x` 保存 `f(x)`。恢复时用拉格朗日插值求 `f(0)`。

---

## 五、兼容性说明

- **前向兼容**：`headerJson` 中新增字段会自动纳入 AAD，旧版本遇到未知字段会因 CRC/AAD
  不匹配而报"格式不正确"。因此**新增字段必须提升 `version`**。
- **算法扩展**：新增算法必须同时扩展 `ALG_BYTE` 编号表（追加，不可重排）。
- **tag 长度**：当前实现假设所有算法 tag 均为 16 字节；若引入不同 tag 长度的算法，
  需要把单块布局改为显式记录各层 tag 长度。
- **分块上限**：`chunkCount` 为 uint32，配合 64 MiB 分块可支持约 256 PiB，
  实际受浏览器内存限制。
- 本格式未使用 ZIP64 或任何外部容器，`.XUQIAN` 是自描述的单文件格式。

---

## 六、格式自检速查

| 检查项 | 期望 |
| --- | --- |
| 文件前 6 字节 | `58 55 51 49 41 4E`（`XUQIAN`） |
| 第 7 字节 | `01` |
| 第 8 字节 | `00` 或 `02`（gzip） |
| 偏移 17 起的 4 字节 | 合理的 headerLen（通常 200~600） |
| 偏移 21 起 | 可读 JSON，含 `layers` 与 `meta` |
| JSON 中是否含密钥 | **绝对不含**（自动化测试会断言） |
| 文件总大小 | `21 + headerLen + Σ(plainSize_i + (2L−1)×16)` |

# 密钥一次性展示与销毁机制（实现详解 + 零残留验证方法）

本文件回答需求文档第九节第 8、9 条：

> 8. 密钥一次性展示与销毁机制的实现代码
> 9. 确认关闭弹窗后无密钥残留的测试方法

---

## 一、总体设计

主密钥的**权威副本**只存在一个地方：加密 Worker 的模块作用域变量里。

```
主线程 (React)                            Worker (crypto.worker.ts)
─────────────────────────                 ──────────────────────────
点击「开始加密」
  └─ client.generateKey() ─────────────►  masterKey = MasterKey.generate()
                                          （Uint8Array(16)，CSPRNG 生成）
加密过程中使用 ─────────────────────────►  deriveSubkey / deriveNonce / AEAD
  ◄──────────── 密文 + 指纹
client.viewKey() ──────────────────────►  hex / base64 / fingerprint（一次性文本视图）
  └─ store.openKeyModal({ view })          ← 主线程只拿到字符串快照
弹出 KeyModal（默认选中 Hex）
...
点击「我已复制，关闭并销毁」
  └─ client.destroyKeySync() ───────────►  masterKey.destroy()  → fill(0) 覆写
                                          masterKey = null
  └─ store.closeKeyModal()                  （#keyPresent = false）
    → view = null，弹窗卸载
```

关键点：Worker 一旦把哈希/密文算完，主线程就再也无法"重新读取"主密钥 ——
只能通过 `key-view` 请求一次文本视图。`key-destroy` 之后该请求永远失败。

---

## 二、核心代码位置

| 职责 | 文件 | 关键符号 |
| --- | --- | --- |
| 主密钥容器与覆写 | `src/crypto/keys.ts` | `MasterKey`、`destroy()`、`fingerprint()`、`deriveSubkey()` |
| 内存擦除工具 | `src/crypto/zeroize.ts` | `zeroize()`、`SecureText` |
| Worker 侧密钥生命周期 | `src/worker/crypto.worker.ts` | `masterKey`、`requireKey()`、`destroyKey()`、`handle()` |
| 主线程客户端 | `src/worker/client.ts` | `generateKey()`、`viewKey()`、`destroyKeySync()`、`destroyKey()` |
| 弹窗 UI 与关闭流程 | `src/components/KeyModal.tsx` | `finalizeClose()`、`requestClose()`、`useEffect`（复位） |
| 状态清空 | `src/app/store.ts` | `openKeyModal()`、`closeKeyModal()` |

### 2.1 `MasterKey.destroy()`（可靠覆写）

```ts
destroy(): void {
  zeroize(this.#bytes)          // bytes.fill(0)
  this.#bytes = new Uint8Array(0)
  this.#destroyed = true
}
```

之后任何 `view()/clone()/deriveSubkey()/deriveNonce()/fingerprint()` 都会抛
`KEY_DESTROYED`，由 Worker 统一映射为 `KEY_NOT_AVAILABLE`。

### 2.2 Worker 侧销毁

```ts
function destroyKey(): void {
  if (masterKey) {
    masterKey.destroy()
    masterKey = null
  }
}

case 'key-destroy': {
  destroyKey()
  return { id: request.id, op: 'key-destroy', ok: true, destroyed: true }
}
```

### 2.3 主线程销毁（不阻塞 UI）

```ts
destroyKeySync(): void {          // fire-and-forget，消息按序处理
  this.#keyPresent = false
  this.#worker?.postMessage({ id: ++this.#seq, op: 'key-destroy' })
}

async destroyKey(): Promise<void> {  // 可等待版本
  this.#keyPresent = false
  if (!this.#worker) return
  try { await this.#call({ ...op: 'key-destroy' }, 'key-destroy') } catch {}
}
```

`destroyKeySync()` 立即发出命令，因此**不存在"UI 卡在等待 Worker 回包"的风险**
（Worker 消息按序处理，这条 destroy 一定先于后续任何请求生效）。

### 2.4 弹窗关闭流程

```ts
const finalizeClose = () => {
  if (destroyedRef.current) return      // 幂等
  destroyedRef.current = true
  setShares([])                         // 清空分片
  setPassword(''); setPassword2('')     // 清空密码
  setError(null); setConfirming(false)
  cryptoClient.destroyKeySync()         // ① 命令 Worker 覆写主密钥
  closeKeyModal()                       // ② view = null，弹窗卸载
  logEvent('keyDestroy', '...', 'warn') // ③ 只记录不含密钥的日志
  void cryptoClient.destroyKey()        // ④ 再确认一次（不阻塞）
}

const requestClose = () => {
  const latest = useApp.getState().keyModal    // 读最新状态，避免过期闭包
  if (latest.copiedHex || latest.copiedBase64 || latest.downloaded) finalizeClose()
  else setConfirming(true)                      // 未备份 → 二次确认
}
```

**三个曾经被自动化测试抓到的真实缺陷**（现已修复，并在冒烟测试中回归）：

1. `requestClose` 原先读取渲染快照里的 `safeToClose`。用户点完"复制"立刻点"关闭"时，
   快照仍是旧值 → 错误地弹出二次确认。修复：改为从 store 实时读取。
2. `destroyedRef` 原先从不复位。同一会话中**第二次**加密后，`finalizeClose()` 会因
   `destroyedRef.current === true` 直接返回，导致弹窗**永远关不掉**。
   修复：弹窗打开时在 `useEffect` 中复位该标记。
3. **解密页"明明填了密钥却报没有可用密钥"**（用户实测反馈"老是解密失败"）。
   根因是**过期闭包快照 + 异步文件读取的时序竞争**：

   `runDecryption` 从渲染闭包里读 `keyFileText` / `keyInput`，而用户选完
   `.XUQIANKEY`（`File.text()` 是异步的）或粘贴密钥后**立刻**点「开始解密」时，
   这些 state 还没来得及参与渲染，闭包里仍是空字符串 → 直接抛 `KEY_NOT_AVAILABLE`。

   修复（`src/components/DecryptTab.tsx`）：

   - 保存选中的 **`File` 对象**而不是它的文本，解密前按需 `await` 读取
     （`resolveKeyFileText()`），彻底消除"还没读完"的时序问题；
   - 密钥输入框 / 密码框在提交时**直接读 DOM 当前值**（`readLiveInputs()`），
     不依赖任何 state 快照，也覆盖浏览器自动填充不触发 `onChange` 的情况；
   - 密钥文件读取期间显示「正在读取密钥文件…」并暂时禁用「开始解密」，给出明确反馈；
   - 在冒烟测试中固化为**最坏时序回归项**：上传 `.XUQIANKEY` 后不等待、不重渲染，
     立刻填密码并点解密，必须成功解密且字节一致。

   验证方式（可复现）：把密钥文件与密文准备好后，用
   `pnpm test:smoke` 观察「上传 .XUQIANKEY 后立刻解密也能成功（时序回归）」这一项。

### 2.5 关闭后没有"再次查看"的入口

- store 中 `keyModal.view` 被置为 `null`，弹窗组件直接 `return null`
- 没有"最近使用的密钥"列表，没有历史记录，没有任何持久化
- 想再次获得密钥，唯一办法是**用原文件重新加密一次**（会生成全新密钥）

### 2.6 刷新/关闭页面

```ts
window.addEventListener('pagehide', () => cryptoClient.destroyKeySync())
window.addEventListener('beforeunload', () => cryptoClient.destroyKeySync())
```

即使这两次消息因页面卸载而未送达，浏览器也会销毁整个 Worker 及其全部内存，
且没有任何持久化数据可供恢复。

---

## 三、零残留验证方法

### 方法 A：自动化（推荐，已实现）

```bash
pnpm dev            # 终端 1
pnpm test:smoke     # 终端 2
```

`scripts/smoke.mjs` 会真实地走完"加密 → 拿到密钥 → 关闭弹窗 → 刷新"，
然后用页面内脚本检查全部存储位置：

```js
const dump = (store) => {
  let out = ''
  for (let i = 0; i < store.length; i++) out += store.key(i) + '=' + store.getItem(store.key(i)) + '\n'
  return out
}
const haystack = [dump(localStorage), dump(sessionStorage), document.cookie, location.href].join('\n')
const leaked = haystack.toLowerCase().includes(keyHex.toLowerCase()) || haystack.includes(keyBase64)
```

对应断言（合计 8 项，全部通过）：

| 检查 | 期望 |
| --- | --- |
| `localStorage` | 不含密钥 Hex / Base64 |
| `sessionStorage` | 不含密钥 Hex / Base64 |
| `document.cookie` | 不含密钥 |
| `location.href` | 不含密钥 |
| `indexedDB.databases()` | 为空（本应用从不打开数据库） |
| 关闭后页面文本 | 不含密钥 |
| **刷新后** localStorage + sessionStorage | 不含密钥 |
| 刷新后页面文本 | 不含密钥 |

另外还会断言"关闭弹窗后 `viewKey()` 已不可用"这条语义路径（弹窗 DOM 消失即
`#xq-key-title` 选择器查不到）。

### 方法 B：手工 DevTools 检查

1. 打开 `http://127.0.0.1:5188/`，加密任意文本，记下弹窗中的 Hex
2. 打开 DevTools → **Application**
   - Local Storage → 查找 32 位 Hex 串 → 应**找不到**
   - Session Storage → 同上
   - Cookies → 同上
   - IndexedDB → 应为空（没有任何数据库）
   - Cache Storage → 应为空
3. Console 执行：

   ```js
   // 把 <HEX> 换成你的密钥
   const key = '<HEX>'.toLowerCase()
   const dump = (s) => { let o=''; for (let i=0;i<s.length;i++) o += s.key(i)+'='+s.getItem(s.key(i))+'\n'; return o }
   const all = [dump(localStorage), dump(sessionStorage), document.cookie, location.href].join('\n').toLowerCase()
   console.log('残留:', all.includes(key))   // 期望 false
   ```

4. 在 Network 面板勾选 **Preserve log**，全流程操作一遍 → 应**没有任何请求**
   （除页面自身的 HTML/JS/CSS 静态资源）
5. 刷新页面（F5）→ 重复第 3 步 → 仍应为 `false`
6. 在 Sources 面板搜索密钥 Hex → 只应在你刚复制的瞬间出现，关闭弹窗后不应再命中

### 方法 C：内存观察（进阶）

1. DevTools → Memory → 拍摄 Heap Snapshot
2. 加密并关闭弹窗
3. 再拍一次 Heap Snapshot
4. 搜索密钥 Hex 字符串 → 可能仍能命中（**这是 JavaScript 字符串不可擦除的固有现象**，
   见 **§四「诚实披露」**），但对应对象应已被标记为可回收；
   触发一次 GC（Performance 面板的垃圾桶按钮）后命中数应显著下降。

### 方法 D：代码审计（静态检查）

```bash
# 确认密钥从不进入持久化 API
rg -n "localStorage|sessionStorage|indexedDB|document\.cookie" src/
# 期望：仅出现在 app/store.ts（主题/语言/日志）与 i18n/utils 中，且都与密钥无关

# 确认没有任何"找回密钥"的实现
rg -n "recover|restoreKey|history" src/crypto src/worker
# 期望：无匹配（Shamir 的 combineShares 是显式的用户操作，不涉及历史存储）
```

---

## 四、诚实披露：不可擦除的部分

| 数据 | 能否可靠擦除 | 说明 |
| --- | --- | --- |
| Worker 内的 `Uint8Array` 主密钥 | ✅ 可以 | `fill(0)` 覆写，立即生效 |
| 派生子密钥（`Uint8Array`） | ✅ 可以 | 每层用完即 `zeroize` |
| salt / nonce / nonce 种子 | ✅ 可以 | 加密结束与销毁时一并覆写 |
| Hex / Base64 文本（`string`） | ❌ 不可以 | JavaScript 字符串不可变，只能等 GC |
| React state 中的 `view` 对象 | ⚠️ 引用可断 | 置 `null` 后可回收，但底层字符串同上 |
| 剪贴板内容 | ⚠️ 尽力而为 | 需要页面聚焦；可在设置中开启 10 秒清理 |
| 已下载的 `.XUQIANKEY` 文件 | ❌ 由用户负责 | 网站无法删除你磁盘上的文件 |

因此本项目的准确表述是：

> **主密钥的权威副本（TypedArray）在关闭弹窗时被立即覆写销毁；
> 用于展示的文本副本只在弹窗打开期间存在，关闭后网站不再持有其引用，
> 只能依赖 JavaScript 垃圾回收（这是语言限制，任何纯前端方案都无法规避）。**

我们在 UI 与文档中都不会声称"内存被彻底清零"。

---

## 五、相关单测

`src/crypto/container.test.ts` 中的「主密钥销毁后再使用会抛错」用例：

```ts
const mk = MasterKey.generate()
const enc = await encryptContainer(data, mk, { layers: ['AES-128-GCM'] })
mk.destroy()
expect(mk.destroyed).toBe(true)
await expect(decryptContainer(concatBytes(...enc.pieces), mk)).rejects.toThrow('KEY_DESTROYED')
expect(() => mk.deriveSubkey('AES-128-GCM', 0, new Uint8Array(16))).toThrow('KEY_DESTROYED')
```

这保证了"销毁后无法再用该密钥做任何事"这一底层语义。

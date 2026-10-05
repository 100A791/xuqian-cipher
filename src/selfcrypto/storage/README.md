# storage —— 本地存储

SPEC §2：`storage 存放本地存储：indexeddb.js、file_io.js`。

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `indexeddb.js` | **已实现** | 纯前端方案：把**密文**存进浏览器 IndexedDB（SPEC §5 阶段六） |
| `file_io.js` | **未实现（有意）** | 属 SPEC 的「**带后端方案**」：用 Node/Go/Python 起本地服务、SQLite 存元数据、密文落本地目录 |

为什么不做 `file_io.js`：本项目的部署形态已由用户定为**纯前端、无后端**（「先本地部署」，且整个产品的卖点就是
"文件与密钥从未上传、不经过任何服务器"）。引入本地服务会立刻带来两件事：
① 多一个"服务器端"，与"不接触明文和密钥"的承诺之间多出一个需要审计的攻击面；
② 用户实际上要自己起两个进程，反而更难用。

如果将来确实需要（例如要支持几十 GB 的大文件流式落盘），再按 SPEC 的后端方案补 `file_io.js`；
届时 SPEC 已经给定了边界：**只存密文和元数据，不接触明文和密钥**。

## indexeddb.js 的三条红线

1. 只允许落库这些字段：`id / name / bytes / size / savedAt / version / note`（**白名单**，
   任何 `key / passKey / masterKey / passphrase / secret / WK` 字段都会被拒绝写入，嵌套的也查）。
2. 落库的是 `Uint8Array` 原始字节，不做 base64、不文本化（SPEC §7：禁止用 UTF-8 文本格式存储密文文件）。
3. 不做任何网络请求；不在 `localStorage` / `sessionStorage` 里放任何东西（有测试机械校验）。

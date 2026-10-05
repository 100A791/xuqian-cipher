# ui —— 这个目录按 SPEC 应放原生 JS 页面，本项目改用 React 实现

SPEC §2 写的是：`ui 存放界面：main.js、file_page.js、watermark_page.js、decrypt_page.js、ai_page.js`。

**实际实现（决策 D25）**：用户明确要求「不重做界面，两者均兼顾」，所以界面沿用项目已有的 React 栈，
页面划分与 SPEC 一一对应，落在 `src/components/selfcrypto/`：

| SPEC 文件 | 本项目实现 |
| --- | --- |
| `main.js`（主界面与路由） | `src/components/selfcrypto/SelfHome.tsx` + store 里的 `selfTab` 路由 |
| `file_page.js` | `src/components/selfcrypto/SelfFilePage.tsx` |
| `decrypt_page.js` | `src/components/selfcrypto/SelfDecryptPage.tsx` |
| `watermark_page.js` | `src/components/selfcrypto/SelfWatermarkPage.tsx` |
| `ai_page.js` | `src/components/selfcrypto/SelfAiPage.tsx` |
| （SPEC 未列） | `SelfStatusPage.tsx`（算法与状态）、`SelfShell.tsx`（外壳）、`browser.ts`（浏览器粘合） |

为什么不写两份界面：同一个产品里维护"原生 JS 版 + React 版"两套 UI，只会让人力与一致性双败；
而且 SPEC 的原生 JS 方案本身就假定了 `src/ui` 是唯一的界面层，与本项目既有的界面冲突。

保留这个目录（而不是删掉），是为了让这处偏差**在它该在的位置**可见，而不是只在别处的文档里提一句。

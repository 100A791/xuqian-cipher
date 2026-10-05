# third —— 这个目录**故意留空**

SPEC §2 的目录结构里写明：「**third** 存放不存在的第三方库，留空，禁止引入」。

留着它，是为了让这条约束**在目录结构上可见**：自研路线的所有代码（`crypto/`、`common/`、`file/`、`watermark/`、`ai/`、`storage/`）
都只用平台自带能力（`crypto.getRandomValues`、`TextEncoder`、`DataView`、Canvas、Blob、IndexedDB），
不 import 任何第三方包。

核对方式（应当输出 0）：

```bash
node -e "const fs=require('fs'),p=require('path');let n=0;(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())w(f);else if(/\.js$/.test(e.name)&&/(from|import)\s+'[^.]/.test(fs.readFileSync(f,'utf8'))){n++;console.log(f)}}})('src/selfcrypto');console.log('外部包 import:',n,'处')"
```

`pnpm test:selfcrypto` 也会跑这条自检。

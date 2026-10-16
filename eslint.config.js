/**
 * ESLint 扁平配置。
 *
 * 设计取舍（写给后来者，避免"规则为什么这么少"的困惑）：
 *
 * 1. **不引入格式化规则**。格式交给 Prettier（见 .prettierrc.json）。
 *    两套工具都管格式时会互相打架，也会让 `pnpm lint --fix` 产生大段噪音 diff。
 * 2. **规则刻意保守**：只打开"真会变成 bug"的那几条（未使用变量、hooks 依赖、
 *    可疑语法、未定义变量），不做风格洁癖。
 * 3. **react-hooks 只显式写两条经典规则**，不用插件的预设对象：
 *    该插件跨大版本的预设导出结构改动过（`configs.recommended` 与
 *    `configs['recommended-latest']` 并存过），显式列出可以避免升级后配置静默失效。
 * 4. **`src/selfcrypto/**` 是刻意零第三方依赖的纯 JS**，同样纳入检查，
 *    但使用的是浏览器全局（它有 IndexedDB / Canvas 代码）。
 * 5. TS 文件关掉 `no-undef`：类型系统已经负责这件事，交给 ESLint 只会产生误报。
 */
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: ['dist/**', 'public/**', 'node_modules/**', 'certs/**', 'coverage/**', '**/*.XUQIAN', '**/*.XUQIANKEY'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // React / 浏览器代码
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-undef': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // 自研加密路线的纯 JS（浏览器环境）
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker },
    },
  },

  // Node 侧：测试 / 脚本 / 命令行工具 / 配置文件
  {
    files: ['scripts/**/*.{mjs,js}', 'tests/**/*.js', 'tools/**/*.js', 'cli/**/*.{ts,mjs}', '*.{js,mjs,ts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
)

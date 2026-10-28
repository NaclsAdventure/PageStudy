# Vite + React + TypeScript 骨架

## 目录

```text
project/
  public/
    manifest.json
    icons/
  src/
    background/index.ts
    content/index.ts
    sidepanel/
      main.tsx
      App.tsx
      styles.css
    options/
      main.tsx
      App.tsx
      styles.css
    shared/
      types.ts
      messages.ts
      settings.ts
      storage.ts
  sidepanel.html
  options.html
  vite.config.ts
  vite.content.config.ts
  vite.background.config.ts
  tsconfig.json
  package.json
```

## package.json 脚本

```json
{
  "scripts": {
    "dev": "vite",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "vite build && vite build --config vite.content.config.ts && vite build --config vite.background.config.ts"
  }
}
```

构建顺序很重要：页面构建使用 `emptyOutDir: true`，content/background 随后使用 `emptyOutDir: false`，避免后一次构建清掉前一次产物。

## 页面构建

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: fromRoot('./sidepanel.html'),
        options: fromRoot('./options.html'),
      },
    },
  },
});
```

HTML 根文件由 Vite 处理；`public/manifest.json` 和图标会原样复制到 `dist/`。

## content script：单文件 IIFE

```ts
// vite.content.config.ts
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: fromRoot('./src/content/index.ts'),
      formats: ['iife'],
      name: 'PageStudyContent',
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
```

content script 不能依赖动态 chunk；入口里的所有依赖必须打进 `content.js`。

## background service worker：单文件 IIFE

```ts
// vite.background.config.ts
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: fromRoot('./src/background/index.ts'),
      formats: ['iife'],
      name: 'PageStudyBackground',
      fileName: () => 'background.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
```

## manifest 最小模板

```json
{
  "manifest_version": 3,
  "name": "My Extension",
  "version": "0.1.0",
  "minimum_chrome_version": "116",
  "permissions": ["storage", "sidePanel"],
  "host_permissions": ["https://example.com/*"],
  "background": { "service_worker": "background.js" },
  "action": { "default_title": "打开侧栏" },
  "side_panel": { "default_path": "sidepanel.html" },
  "options_ui": { "page": "options.html", "open_in_tab": true },
  "content_scripts": [
    {
      "matches": ["https://example.com/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

只在需要时申请 `contextMenus`、`tabs`、`scripting`、`downloads` 等权限；侧栏点击图标打开行为按 116+ 设计。

## tsconfig 关键项

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "types": ["chrome", "node"]
  }
}
```

## 安装与加载

```powershell
npm install
npm run build
```

在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式，选择 `dist` 目录加载。改代码后重新构建，再在扩展管理页点刷新。

## 验证边界

- `npm run build` 通过只说明打包成功，不说明扩展能加载。
- `dist/manifest.json` 必须存在且入口路径与构建产物一致。
- 先加载空壳，再逐面增加功能；每次构建都刷新扩展，避免加载旧 bundle。

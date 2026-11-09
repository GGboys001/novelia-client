export interface NoveliaRuntime {
  apiBase: string;
  authBase: string;
  echAvailable?: boolean;
}

/**
 * Tauri 外壳会在页面脚本执行前注入该运行时配置；
 * 纯浏览器环境下为 undefined，继续使用同源 /api/ 与构建期认证地址。
 */
export const noveliaRuntime: NoveliaRuntime | undefined = (
  globalThis as { __NOVELIA_RUNTIME__?: NoveliaRuntime }
).__NOVELIA_RUNTIME__;

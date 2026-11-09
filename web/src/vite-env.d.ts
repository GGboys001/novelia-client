/// <reference types="vite/client" />

declare const __API_BASE__: string;
declare const __AUTH_URL__: string;
declare const __FORUM_API_BASE__: string;
declare const __ECH_AVAILABLE__: boolean;

declare const __BUILD_TIME__: string;
declare const __COMMIT_SHA__: string;
declare const __APP_VERSION__: string;

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

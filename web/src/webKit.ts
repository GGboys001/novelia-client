import { createWebKit } from '@novelia/web-kit';

import { siteUrls } from '@/config';
import { noveliaRuntime } from '@/runtime';

// 独立于应用入口，供 API 和状态模块共享，避免循环依赖。
export const webKit = createWebKit({
  auth: {
    app: 'n',
    url: noveliaRuntime?.authBase ?? __AUTH_URL__,
  },
  brand: '小说',
  repository: {
    url: siteUrls.repository,
    buildTime: __BUILD_TIME__,
    commitSha: __COMMIT_SHA__,
  },
});

import { createForumApi } from '@novelia/web-kit';

import { noveliaRuntime } from '@/runtime';
import { webKit } from '@/webKit';

// 评论由论坛服务提供。客户端里经本地代理转发，避免 WebView 页面来源
// （tauri.localhost）被论坛的 CORS 策略拦截；浏览器版仍直连官方域名。
const forumApiBase = noveliaRuntime?.forumApiBase ?? __FORUM_API_BASE__;
const client = webKit.createClient(forumApiBase, { timeout: 60_000 });

export const CommentApi = createForumApi({
  client,
  url: forumApiBase,
  type: 'novel',
});

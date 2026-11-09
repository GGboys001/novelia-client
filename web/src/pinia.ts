import { createPinia, setActivePinia } from 'pinia';

// 路由页面改为静态导入后，repos 模块会在入口执行前调用 useQueryCache()。
// 先创建并激活实例，保证模块级 store 访问与 app.use(pinia) 使用同一个 Pinia。
export const pinia = createPinia();
setActivePinia(pinia);

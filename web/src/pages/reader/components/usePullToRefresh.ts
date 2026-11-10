import { onBeforeUnmount, onMounted, ref } from 'vue';

export interface PullToRefreshOptions {
  /** 阻尼后触发刷新的距离，默认 60。 */
  threshold?: number;
  /** 返回 false 时忽略手势，用于目录、设置等弹窗打开期间禁止刷新。 */
  enabled?: () => boolean;
}

/**
 * 弹窗、抽屉等浮层内部的下拉属于浮层自身滚动，不能当成页面刷新。
 * 浮层由 Portal 渲染，与触发元素的 DOM 层级无关，因此按容器选择器判断。
 */
export const PULL_REFRESH_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[data-pull-refresh-ignore]',
].join(',');

/** 触摸目标是否位于浮层内。鸭子类型判断，避免依赖 DOM 全局。 */
export function isInsideOverlay(target: unknown): boolean {
  const closest = (target as { closest?: unknown } | null | undefined)?.closest;
  if (typeof closest !== 'function') return false;
  return (closest as (selector: string) => unknown).call(
    target,
    PULL_REFRESH_OVERLAY_SELECTOR,
  ) !== null;
}

/**
 * 阅读页的顶部下拉刷新。
 *
 * Android WebView 没有原生的下拉刷新，这里在页面滚动到顶部时接管向下的
 * 触摸手势：拖动距离带阻尼，松手超过阈值就触发刷新。
 *
 * 浮层打开时页面被锁定滚动，`window.scrollY` 恒为 0，若继续接管手势，
 * 在目录里向下翻看更早的章节就会误触发整页刷新，因此浮层内的手势一律忽略。
 */
export function usePullToRefresh(
  onRefresh: () => void,
  options: PullToRefreshOptions = {},
) {
  const threshold = options.threshold ?? 60;
  const distance = ref(0);
  const refreshing = ref(false);
  let startY: number | null = null;
  let active = false;

  const isEnabled = () => options.enabled?.() ?? true;

  const reset = () => {
    startY = null;
    active = false;
    distance.value = 0;
  };

  const onTouchStart = (event: TouchEvent) => {
    if (refreshing.value || event.touches.length !== 1) return;
    if (!isEnabled() || isInsideOverlay(event.target)) return;
    if (window.scrollY > 0) return;
    startY = event.touches[0].clientY;
    active = true;
    distance.value = 0;
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!active || startY === null || refreshing.value) return;
    const delta = event.touches[0].clientY - startY;
    if (delta <= 0) {
      distance.value = 0;
      return;
    }
    // 手势途中打开了浮层，或手指已移到浮层上，都不再接管。
    if (!isEnabled() || window.scrollY > 0 || isInsideOverlay(event.target)) {
      reset();
      return;
    }
    // 顶部继续往下拉时阻止默认的回弹/滚动，交给刷新手势。
    if (delta > 6 && event.cancelable) event.preventDefault();
    distance.value = Math.min(delta * 0.5, threshold * 1.6);
  };

  const onTouchEnd = () => {
    if (!active) return;
    const triggered = distance.value >= threshold && isEnabled();
    reset();
    if (!triggered || refreshing.value) return;
    refreshing.value = true;
    onRefresh();
    // 正常情况下页面会整页重载；若刷新被阻止，也要把状态复位。
    window.setTimeout(() => {
      refreshing.value = false;
    }, 1000);
  };

  onMounted(() => {
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', onTouchEnd);
  });

  return { distance, refreshing, threshold };
}

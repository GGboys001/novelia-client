import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 阅读页的顶部下拉刷新。
 *
 * Android WebView 没有原生的下拉刷新，这里在页面滚动到顶部时接管向下的
 * 触摸手势：拖动距离带阻尼，松手超过阈值就触发刷新。
 */
export function usePullToRefresh(onRefresh: () => void, threshold = 60) {
  const distance = ref(0);
  const refreshing = ref(false);
  let startY: number | null = null;
  let active = false;

  const reset = () => {
    startY = null;
    active = false;
    distance.value = 0;
  };

  const onTouchStart = (event: TouchEvent) => {
    if (refreshing.value || event.touches.length !== 1) return;
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
    if (window.scrollY > 0) {
      reset();
      return;
    }
    // 顶部继续往下拉时阻止默认的回弹/滚动，交给刷新手势。
    if (delta > 6 && event.cancelable) event.preventDefault();
    distance.value = Math.min(delta * 0.5, threshold * 1.6);
  };

  const onTouchEnd = () => {
    if (!active) return;
    const triggered = distance.value >= threshold;
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

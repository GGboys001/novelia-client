<script lang="ts" setup>
import { createReusableTemplate, onKeyDown } from '@vueuse/core';
import { XError } from '@novelia/web-kit';

import { ReadHistoryApi } from '@/api';
import { GenericNovelId } from '@/model/Common';
import type { TranslatorId } from '@/model/Translator';
import { ReadPositionRepo } from '@/repos';
import {
  useLocalVolumeStore,
  useReaderSettingStore,
  useWhoamiStore,
} from '@/stores';
import { checkIsMobile } from '@/util';
import type { Result } from '@/util/result';
import type { ReaderChapter } from './ReaderStore';
import { useReaderStore } from './ReaderStore';
import ReaderLayoutDesktop from './components/ReaderLayoutDesktop.vue';
import ReaderLayoutMobile from './components/ReaderLayoutMobile.vue';
import ReaderSkeleton from './components/ReaderSkeleton.vue';
import { usePullToRefresh } from './components/usePullToRefresh';
import { useScrollDetector } from './components/useScrollDetector';
import { RefreshOutlined } from '@vicons/material';

const [DefineChapterLink, ReuseChapterLink] = createReusableTemplate<{
  label: string;
  id: string | undefined;
}>();

const route = useRoute();
const router = useRouter();
const isMobile = checkIsMobile();

const whoamiStore = useWhoamiStore();
const { whoami } = storeToRefs(whoamiStore);

const readerSettingStore = useReaderSettingStore();
const { readerSetting } = storeToRefs(readerSettingStore);

const gnid = ((): GenericNovelId => {
  const path = route.path;
  const params = route.params;
  if (path.startsWith('/novel')) {
    const providerId = params.providerId as string;
    const novelId = params.novelId as string;
    return GenericNovelId.web(providerId, novelId);
  } else {
    const volumeId = params.novelId as string;
    return GenericNovelId.local(volumeId);
  }
})();

const store = useReaderStore(gnid);

const targetChapterId = ref('');
const currentChapterId = ref('');
const chapterResult = shallowRef<Result<ReaderChapter>>();
const chapterList = ref<
  { chapterId: string; result?: Result<ReaderChapter> }[]
>([]);
const currentChapter = computed(() =>
  chapterResult.value?.ok ? chapterResult.value.value : undefined,
);
const loadedChapters = computed(() =>
  chapterList.value.map((item) => ({
    chapterId: item.chapterId,
    result: item.result,
    chapter: item.result?.ok ? item.result.value : undefined,
  })),
);
const loadingBar = useLoadingBar();

const novelUrl = (() => {
  if (gnid.type === 'web') {
    return `/novel/${gnid.providerId}/${gnid.novelId}`;
  }
})();

const updateChapter = (
  chapterId: string,
  result: Result<ReaderChapter>,
  replace = false,
) => {
  if (result.ok) {
    document.title = result.value.novelTitleJp
      ? `${result.value.titleJp} | ${result.value.novelTitleJp}`
      : result.value.titleJp;
    if (gnid.type === 'web' && whoami.value.isSignedIn) {
      ReadHistoryApi.updateReadHistoryWeb(
        gnid.providerId,
        gnid.novelId,
        chapterId,
      );
    } else if (gnid.type === 'local') {
      useLocalVolumeStore().then((it) => it.updateReadAt(gnid.volumeId));
    }
    if (result.value.nextId) {
      store.preloadChapter(result.value.nextId);
    }
  }

  let prefix: string;
  if (gnid.type === 'web') {
    prefix = `/novel/${gnid.providerId}/${gnid.novelId}`;
  } else if (gnid.type === 'wenku') {
    throw '不支持文库';
  } else {
    prefix = `/workspace/reader/${encodeURIComponent(gnid.volumeId)}`;
  }
  currentChapterId.value = chapterId;

  if (replace) {
    router.replace(`${prefix}/${chapterId}`);
  } else {
    router.push(`${prefix}/${chapterId}`);
  }
};

const navToChapter = async (chapterId: string) => {
  targetChapterId.value = chapterId;

  const { type, promiseOrValue } = store.loadChapter(chapterId);

  if (type === 'async') {
    loadingBar.start();
  }

  const result = await promiseOrValue;
  if (chapterId !== targetChapterId.value) {
    return;
  }

  if (result.ok) {
    loadingBar.finish();
  } else {
    loadingBar.error();
  }

  chapterResult.value = result;
  chapterList.value = [{ chapterId, result }];

  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });

  if (currentChapterId.value !== chapterId) {
    updateChapter(chapterId, result);
  }
};

const scrollToReadPosition = async () => {
  const readPosition = ReadPositionRepo.getPosition(gnid);
  if (readPosition && readPosition.chapterId === route.params.chapterId) {
    // hacky: 等待段落显示完成
    await nextTick();
    await nextTick();
    window.scrollTo({ top: readPosition.scrollY });
  }
};

watch(chapterResult, scrollToReadPosition, { once: true });
watch(
  () => readerSetting.value.pageTurnMode,
  async () => {
    await navToChapter(currentChapterId.value);
    scrollToReadPosition();
  },
);

watch(
  route,
  (route) => {
    const urlChapterId = route.params.chapterId as string;
    if (urlChapterId === targetChapterId.value) {
      return;
    }
    // 滚动模式下 URL 只是滚动切换章节后的同步结果，章节已经在列表里时
    // 不能重新走 navToChapter：那会清空列表并滚回顶部，表现为闪回上一章。
    if (
      readerSetting.value.pageTurnMode === 'scroll' &&
      chapterList.value.some((it) => it.chapterId === urlChapterId && it.result)
    ) {
      targetChapterId.value = urlChapterId;
      return;
    }
    chapterResult.value = undefined;
    navToChapter(urlChapterId);
  },
  {
    immediate: true,
  },
);

useScrollDetector((payload) => {
  ReadPositionRepo.addPosition(gnid, {
    chapterId: payload.chapterId,
    scrollY: payload.y,
  });

  if (readerSetting.value.pageTurnMode === 'scroll') {
    // 预加载下一章
    if (
      payload.percent > 0.8 &&
      chapterResult.value?.ok &&
      chapterResult.value.value.nextId
    ) {
      const id = chapterResult.value.value.nextId;
      if (chapterList.value.every((it) => it.chapterId !== id)) {
        chapterList.value.push({ chapterId: id });

        (async () => {
          const result = await store.loadChapter(id).promiseOrValue;
          const chapter = chapterList.value.find((it) => it.chapterId === id)!;
          chapter.result = result;
        })();
      }
    }

    if (payload.chapterId !== currentChapterId.value) {
      // 更新标题/章节/链接
      const chapter = chapterList.value.find(
        (it) => it.chapterId === payload.chapterId,
      );
      if (!chapter || !chapter.result) return;

      const chapterId = payload.chapterId;
      currentChapterId.value = chapterId;
      targetChapterId.value = chapterId;
      chapterResult.value = chapter.result;
      updateChapter(chapterId, chapter.result, true);
    }
  }
});

onKeyDown(['ArrowLeft'], (e) => {
  if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) {
    return;
  }
  if (showSettingModal.value || showCatalogModal.value) {
    return;
  }
  if (chapterResult.value?.ok && chapterResult.value.value.prevId) {
    navToChapter(chapterResult.value.value.prevId);
    e.preventDefault();
  }
});
onKeyDown(['ArrowRight'], (e) => {
  if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) {
    return;
  }
  if (showSettingModal.value || showCatalogModal.value) {
    return;
  }
  if (chapterResult.value?.ok && chapterResult.value.value.nextId) {
    navToChapter(chapterResult.value.value.nextId);
    e.preventDefault();
  }
});

onKeyDown(['1', '2', '3'], (e) => {
  if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) {
    return;
  }
  if (showSettingModal.value || showCatalogModal.value) {
    return;
  }
  const setting = readerSetting.value;
  const translatorIds = <TranslatorId[]>['youdao', 'gpt', 'sakura'];
  const translatorId = translatorIds[parseInt(e.key, 10) - 1];
  if (setting.translationsMode === 'parallel') {
    if (setting.translations.includes(translatorId)) {
      setting.translations = setting.translations.filter(
        (it) => it !== translatorId,
      );
    } else {
      setting.translations.push(translatorId);
    }
  } else {
    setting.translations = [translatorId];
  }
  e.preventDefault();
});

const showSettingModal = ref(false);
const showCatalogModal = ref(false);

// 整页重载可重置滚动翻页的累积状态，和浏览器下拉刷新一致。
const refreshReader = () => {
  window.location.reload();
};
const {
  distance: pullDistance,
  refreshing: pullRefreshing,
  threshold: pullThreshold,
} = usePullToRefresh(refreshReader);

onKeyDown(['Enter'], (e) => {
  if (showSettingModal.value) {
    return;
  }
  showCatalogModal.value = !showCatalogModal.value;
  e.preventDefault();
});
</script>

<template>
  <DefineChapterLink v-slot="{ id, label }">
    <c-button
      :disabled="id === undefined"
      :lable="label"
      quaternary
      :focusable="false"
      :type="id ? 'primary' : 'default'"
      @action.stop="
        () => {
          navToChapter(id!);
        }
      "
    />
  </DefineChapterLink>

  <div
    class="pull-refresh"
    :class="{ 'is-active': pullDistance > 0 || pullRefreshing }"
    :style="{
      transform: `translate(-50%, ${Math.min(pullDistance, 96)}px)`,
    }"
    aria-hidden="true"
  >
    <n-icon
      :component="RefreshOutlined"
      :size="16"
      :class="{ 'is-spinning': pullRefreshing }"
    />
    <span>
      {{
        pullRefreshing
          ? '刷新中…'
          : pullDistance >= pullThreshold
            ? '松开刷新'
            : '下拉刷新'
      }}
    </span>
  </div>

  <div class="content">
    <template v-if="!chapterResult">
      <ReaderSkeleton v-if="chapterList.length === 0" />
      <div v-else role="status" class="py-6 text-center text-sm text-muted">
        <span class="sr-only">正在加载章节…</span>
        <span aria-hidden="true">正在加载章节…</span>
      </div>
    </template>
    <XError
      v-else-if="!chapterResult.ok"
      title="加载错误"
      :description="chapterResult.error.message"
    />
    <component
      v-else-if="currentChapter"
      :is="isMobile ? ReaderLayoutMobile : ReaderLayoutDesktop"
      :novel-url="novelUrl"
      :chapter="currentChapter"
      @nav="navToChapter"
      @require-catalog-modal="showCatalogModal = true"
      @require-setting-modal="showSettingModal = true"
    >
      <template v-if="readerSetting.pageTurnMode === 'page'">
        <reader-content
          :gnid="gnid"
          :chapter-id="currentChapter.chapterId"
          :chapter="currentChapter"
        />
        <n-divider />
        <n-flex align="center" justify="space-between" style="width: 100%">
          <ReuseChapterLink :id="currentChapter.prevId" label="上一章" />
          <ReuseChapterLink :id="currentChapter.nextId" label="下一章" />
        </n-flex>
      </template>
      <template
        v-else
        v-for="(item, idx) in loadedChapters"
        :key="item.chapterId"
      >
        <template v-if="!item.result">
          <div role="status" class="py-6 text-center text-sm text-muted">
            <span class="sr-only">正在加载下一章…</span>
            <span aria-hidden="true">正在加载下一章…</span>
          </div>
        </template>
        <XError
          v-else-if="!item.result.ok"
          title="加载错误"
          :description="item.result.error.message"
        />
        <template v-else-if="item.chapter">
          <n-divider v-if="idx > 0 && loadedChapters.length > 0" />
          <reader-content
            :gnid="gnid"
            :chapter-id="item.chapter.chapterId"
            :chapter="item.chapter"
          />

          <template v-if="!item.chapter.nextId">
            <div style="text-align: center; margin: 48px 0">暂无更多章节</div>
          </template>
        </template>
      </template>
    </component>

    <reader-setting-modal v-model:open="showSettingModal" />

    <catalog-modal
      v-model:show="showCatalogModal"
      :gnid="gnid"
      :chapter-id="currentChapterId"
    />
  </div>
</template>

<style scoped>
.pull-refresh {
  position: fixed;
  top: calc(var(--novelia-inset-top, 0px) + 10px);
  left: 50%;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--color-surface);
  color: var(--color-muted);
  box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
  font-size: 12px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

.pull-refresh.is-active {
  opacity: 1;
}

.pull-refresh .is-spinning {
  animation: pull-refresh-spin 0.8s linear infinite;
}

@keyframes pull-refresh-spin {
  to {
    transform: rotate(360deg);
  }
}

.content {
  max-width: v-bind('`${readerSetting.pageWidth}px`');
  margin: 0 auto;
  padding-left: v-bind("isMobile? '12px' : '24px'");
  padding-right: v-bind("isMobile? '12px' : '84px'");
  padding-bottom: 92px;
}
</style>

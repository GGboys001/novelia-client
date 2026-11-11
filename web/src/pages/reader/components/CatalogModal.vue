<script lang="ts" setup>
import {
  KeyboardArrowDownRound,
  KeyboardArrowUpRound,
  SortOutlined,
} from '@vicons/material';
import { XDialog, XError, XSkeleton } from '@novelia/web-kit';

import type { GenericNovelId } from '@/model/Common';
import type { ReadableTocItem } from '@/pages/novel/components/common';
import { useTocExpansion } from '@/pages/novel/components/UseTocExpansion';
import { useIsWideScreen } from '@/pages/util';
import { WebNovelRepo } from '@/repos';
import { useLocalVolumeStore, useSettingStore } from '@/stores';
import { loadLocalToc } from '@/stores/local/LocalToc';
import type { Result } from '@/util/result';
import { Err, Ok, runCatching } from '@/util/result';

const props = defineProps<{
  show: boolean;
  gnid: GenericNovelId;
  chapterId: string;
}>();

const emit = defineEmits<{
  'update:show': [boolean];
  /** 本地小说整篇加载时，点击目录跳转到对应章节。 */
  jump: [string];
}>();

type TocItem = ReadableTocItem & {
  key: number;
};

const chapterFallbackTitle = (chapterId: string) =>
  chapterId
    .split('/')
    .pop()
    ?.replace(/\.[^.]+$/, '') || chapterId;

const onLocalTocClick = (item: TocItem) => {
  if (!item.chapterId) return;
  emit('update:show', false);
  emit('jump', item.chapterId);
};

const tocResult = shallowRef<Result<TocItem[]>>();

const tocData = computed(() =>
  tocResult.value?.ok ? tocResult.value.value : undefined,
);

const tocNumber = computed(() => {
  return tocData.value?.filter((it) => it.chapterId !== undefined).length;
});

const settingStore = useSettingStore();
const { setting } = storeToRefs(settingStore);

const sortReverse = computed(() => setting.value.tocSortReverse);

/** 本地目录按设置里的正序/倒序展示。 */
const localTocData = computed(() => {
  const data = tocData.value;
  if (!data) return undefined;
  return sortReverse.value ? [...data].reverse() : data;
});

const isWideScreen = useIsWideScreen();

const defaultTocExpanded = computed(() => setting.value.tocExpandAll);

const { expandedNames, hasSeparators, isAnyExpanded, toggleAll, tocSections } =
  useTocExpansion(
    tocData,
    defaultTocExpanded,
    computed(() => props.chapterId),
  );

watch(
  () => props.show,
  async (show) => {
    if (show) {
      if (tocResult.value?.ok !== true) {
        const getWebToc = async (providerId: string, novelId: string) => {
          const { data: novel } = await WebNovelRepo.useWebNovel(
            providerId,
            novelId,
          ).refresh();
          if (novel) {
            let order = 0;
            const tocItems = novel.toc.map((it, index) => {
              const tocItem = <TocItem>{
                ...it,
                key: index,
                order: it.chapterId ? order : undefined,
              };
              if (it.chapterId) order += 1;
              return tocItem;
            });
            return Ok(tocItems);
          } else {
            return Err('载入失败');
          }
        };

        const getLocalToc = async (volumeId: string) => {
          const repo = await useLocalVolumeStore();
          const volume = await repo.getVolume(volumeId);
          if (volume === undefined) throw Error('小说不存在');

          const toc = await loadLocalToc(volume);
          const items: TocItem[] = [];
          toc.forEach((it, index) => {
            const title = it.title?.trim();
            // 没有标题的封面/插图页不放进目录，避免显示 p-001 之类的文件名。
            if (!title) return;
            items.push(<TocItem>{
              titleJp: title,
              chapterId: it.chapterId,
              // 本地卷没有分卷分隔行，全部按章节渲染，否则会被当成目录分组。
              order: items.length,
              key: index,
            });
          });
          // TXT/SRT 没有章节名，退回按章节序号展示。
          if (items.length === 0) {
            return toc.map(
              (it, index) =>
                <TocItem>{
                  titleJp: chapterFallbackTitle(it.chapterId),
                  chapterId: it.chapterId,
                  order: index,
                  key: index,
                },
            );
          }
          return items;
        };

        const gnid = props.gnid;
        if (gnid.type === 'web') {
          tocResult.value = await getWebToc(gnid.providerId, gnid.novelId);
        } else if (gnid.type === 'wenku') {
          throw '不支持文库';
        } else {
          tocResult.value = await runCatching(getLocalToc(gnid.volumeId));
        }
      }
    }
  },
);

const currentKey = computed(() => {
  return tocData.value?.find((it) => it.chapterId === props.chapterId)?.key;
});

const onTocItemClick = (item: ReadableTocItem) => {
  if (item.chapterId !== undefined) {
    emit('update:show', false);
  }
};
</script>

<template>
  <XDialog
    :open="show"
    @update:open="$emit('update:show', $event)"
    class="w-[600px]"
    style="min-height: 30vh; max-height: 80vh"
  >
    <template #title>
      <div class="pr-2" style="display: flex; align-items: baseline">
        <span>目录</span>
        <n-text
          v-if="tocNumber !== undefined"
          depth="3"
          style="font-size: 12px; margin-left: 12px"
        >
          共{{ tocNumber }}章
        </n-text>
        <div style="flex: 1" />
        <c-button
          v-if="hasSeparators"
          :label="isAnyExpanded ? '折叠' : '展开'"
          :icon="isAnyExpanded ? KeyboardArrowUpRound : KeyboardArrowDownRound"
          quaternary
          size="small"
          :round="false"
          @action="toggleAll"
          style="margin-right: 8px"
        />
        <c-button
          :label="setting.tocSortReverse ? '倒序' : '正序'"
          :icon="SortOutlined"
          quaternary
          size="small"
          :round="false"
          @action="setting.tocSortReverse = !setting.tocSortReverse"
        />
      </div>
    </template>

    <template v-if="!tocResult">
      <div role="status">
        <span class="sr-only">正在加载章节目录…</span>
        <div aria-hidden="true" class="divide-y divide-divider">
          <div v-for="index in 8" :key="index" class="py-3">
            <XSkeleton class="h-5" :class="index % 3 ? 'w-4/5' : 'w-3/5'" />
            <XSkeleton class="mt-2 h-4 w-1/2" />
          </div>
        </div>
      </div>
    </template>
    <XError
      v-else-if="!tocResult.ok"
      title="加载错误"
      :description="tocResult.error.message"
    />
    <template v-else>
      <ChapterTocList
        v-if="gnid.type === 'web' && tocSections"
        :toc-sections="tocSections"
        v-model:expanded-names="expandedNames"
        :last-read-chapter-id="chapterId"
        :default-scroll-key="currentKey"
        :provider-id="gnid.providerId"
        :novel-id="gnid.novelId"
        :sort-reverse="sortReverse"
        :mode="{
          narrow: !isWideScreen,
          modal: true,
          collapse: false,
        }"
        @item-click="onTocItemClick"
      />
      <n-scrollbar
        v-else-if="gnid.type === 'local' && localTocData"
        trigger="none"
        style="max-height: 60vh"
      >
        <n-empty v-if="localTocData.length === 0" description="没有章节" />
        <div v-else class="local-toc-list">
          <div
            v-for="item in localTocData"
            :key="item.key"
            class="local-toc-item"
            @click="onLocalTocClick(item)"
          >
            {{ item.titleJp }}
          </div>
        </div>
      </n-scrollbar>
    </template>
  </XDialog>
</template>

<style scoped>
.local-toc-list {
  display: flex;
  flex-direction: column;
}
.local-toc-item {
  padding: 10px 12px;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
}
.local-toc-item:hover {
  background: rgba(128, 128, 128, 0.12);
}
</style>

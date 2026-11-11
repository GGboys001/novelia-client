<script lang="ts" setup>
import type { WebNovelChapterDto } from '@/model/WebNovel';
import {
  FormatListBulletedOutlined,
  LibraryBooksOutlined,
  TuneOutlined,
  ArrowUpwardOutlined,
  ArrowDownwardOutlined,
  ArrowBackOutlined,
} from '@vicons/material';

defineProps<{
  novelUrl?: string;
  chapter: WebNovelChapterDto;
}>();

const emit = defineEmits<{
  nav: [string];
  requireCatalogModal: [];
  requireSettingModal: [];
}>();

const router = useRouter();

// 本地小说没有详情页，返回按钮直接退出阅读回到本地书架。
const exitReader = () => {
  router.push('/favorite/local');
};
</script>

<template>
  <n-flex :wrap="false">
    <div style="flex: auto">
      <slot />
    </div>

    <div style="flex: 0 0 0">
      <n-flex size="large" vertical style="position: fixed; bottom: 20px">
        <side-button
          v-if="novelUrl"
          :disabled="!chapter.prevId"
          text="上一章"
          :icon="ArrowUpwardOutlined"
          @click="emit('nav', chapter.prevId!)"
        />
        <side-button
          v-if="novelUrl"
          :disabled="!chapter.nextId"
          text="下一章"
          :icon="ArrowDownwardOutlined"
          @click="emit('nav', chapter.nextId!)"
        />
        <side-button
          v-if="novelUrl"
          text="详情"
          :icon="LibraryBooksOutlined"
          @click="router.push(novelUrl)"
        />
        <side-button
          v-else
          text="返回"
          :icon="ArrowBackOutlined"
          @click="exitReader"
        />
        <side-button
          text="目录"
          :icon="FormatListBulletedOutlined"
          @click="emit('requireCatalogModal')"
        />
        <side-button
          text="设置"
          :icon="TuneOutlined"
          @click="emit('requireSettingModal')"
        />
      </n-flex>
    </div>
  </n-flex>
</template>

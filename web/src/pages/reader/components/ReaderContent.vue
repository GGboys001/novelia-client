<script lang="ts" setup>
import { useOsTheme } from 'naive-ui';

import type { GenericNovelId } from '@/model/Common';
import type { ReaderChapter } from '../ReaderStore';
import { useReaderSettingStore } from '@/stores';
import { buildParagraphs } from './BuildParagraphs';
import { WebUtil } from '@/util/web';
import { forumPostUrls } from '@/config';

const props = defineProps<{
  gnid: GenericNovelId;
  chapterId: string;
  chapter: ReaderChapter;
}>();

const osThemeRef = useOsTheme();

const paragraphs = computed(() => buildParagraphs(props.gnid, props.chapter));

/**
 * 章节标题按原文段落下标定位。单语模式会跳过另一种语言的段落，
 * 因此把标题挂到该章节第一条实际渲染的段落上，保证标题不会丢失。
 */
const titleAt = computed(() => {
  const map = new Map<number, { title: string; paragraphIndex: number }>();
  const ranges = props.chapter.chapterRanges;
  if (!ranges?.length) return map;
  let rangeIndex = 0;
  const list = paragraphs.value;
  for (let i = 0; i < list.length; i++) {
    const currentIndex = list[i]?.paragraphIndex ?? i;
    while (
      rangeIndex < ranges.length &&
      ranges[rangeIndex].paragraphIndex <= currentIndex
    ) {
      map.set(i, ranges[rangeIndex]);
      rangeIndex++;
    }
  }
  return map;
});

/** 段落实际对应的原文下标，用于目录跳转和阅读进度。 */
const rawIndex = (index: number) =>
  paragraphs.value[index]?.paragraphIndex ?? index;

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();

/** 章节正文首段本身就是标题时，不再重复渲染分节标题。 */
const showSectionTitle = (index: number) => {
  const range = titleAt.value.get(index);
  if (!range?.title) return false;
  const paragraph = paragraphs.value[index];
  return !(
    paragraph &&
    'text' in paragraph &&
    normalizeText(paragraph.text) === normalizeText(range.title)
  );
};

const readerSettingStore = useReaderSettingStore();
const { readerSetting } = storeToRefs(readerSettingStore);

const emptyHint = computed(() => {
  if (props.gnid.type !== 'web') return undefined;
  if (props.chapter.paragraphs.length === 0)
    return '本章没有原文，可能是源站章节无法访问，或需要更新目录/使用浏览器爬虫抓取。';
  const missing = paragraphs.value.filter(
    (p) => p && 'missing' in p && p.missing,
  ).length;
  if (missing > 0 && missing === readerSetting.value.translations.length)
    return '本站不会自动翻译，需要用户在小说页面生成翻译后才能阅读。你也可以在阅读设置中切换显示的翻译。';
  return undefined;
});

const fontColor = computed(() => {
  const theme = readerSetting.value.theme;
  if (theme.mode === 'custom') {
    return theme.fontColor;
  } else {
    let specificTheme: 'light' | 'dark' = 'light';
    if (theme.mode !== 'system') {
      specificTheme = theme.mode;
    } else if (osThemeRef.value) {
      specificTheme = osThemeRef.value;
    }
    return specificTheme === 'light' ? '#000000' : '#FFFFFF';
  }
});

const underlineColor = computed(() => `${fontColor.value}80`);

const textUnderlineOffset = computed(() => {
  const fontSize = readerSetting.value.fontSize;
  const offset = Math.round(fontSize / 4);
  return `${offset}px`;
});

const chapterHref = computed(() => {
  const chapterId = props.chapterId;
  const gnid = props.gnid;
  if (gnid.type === 'web') {
    return WebUtil.buildChapterUrl(gnid.providerId, gnid.novelId, chapterId);
  } else if (gnid.type === 'wenku') {
    throw '不支持文库';
  } else {
    return '/workspace';
  }
});
</script>

<template>
  <div class="chapter" data-chapter :data-id="chapterId">
    <n-h4 class="chapter-title">
      <n-a :href="chapterHref">{{ chapter.titleJp }}</n-a>
      <br />
      <n-text depth="3">{{ chapter.titleZh }}</n-text>
      <br />
    </n-h4>
    <n-divider />

    <n-alert v-if="emptyHint" type="info" :show-icon="false">
      {{ emptyHint }}详见
      <n-a
        :href="forumPostUrls.usageGuide"
        target="_blank"
        rel="noopener noreferrer"
      >
        使用教程
      </n-a>
      。
    </n-alert>

    <div class="chapter-content">
      <template
        v-for="(p, index) of paragraphs"
        :key="`${chapter.prevId}/${index}`"
      >
        <h3
          v-if="showSectionTitle(index)"
          class="chapter-section-title"
          :data-paragraph-index="titleAt.get(index)!.paragraphIndex"
        >
          {{ titleAt.get(index)!.title }}
        </h3>
        <n-p
          v-if="p && 'text' in p"
          :aria-hidden="!p.needSpeak"
          :data-paragraph-index="rawIndex(index)"
        >
          <span
            v-if="readerSetting.enableSourceLabel && p.source"
            class="source"
          >
            {{ p.source }}
          </span>
          <span v-if="p.indent">
            {{ p.indent }}
          </span>
          <span :class="[p.secondary ? 'second' : 'first', 'text-content']">
            {{ p.text }}
          </span>
        </n-p>
        <br v-else-if="!p" />
        <details
          v-else-if="readerSetting.foldImages"
          :data-paragraph-index="rawIndex(index)"
        >
          <summary class="fold-image">插图（点击展开）</summary>
          <img
            :src="p.imageUrl"
            :alt="p.imageUrl"
            style="max-width: 100%; object-fit: scale-down"
            loading="lazy"
          />
        </details>
        <img
          v-else
          :src="p.imageUrl"
          :alt="p.imageUrl"
          style="max-width: 100%; object-fit: scale-down"
          loading="lazy"
          :data-paragraph-index="rawIndex(index)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.chapter {
  font-size: v-bind('`${readerSetting.fontSize}px`');
  font-weight: v-bind('readerSetting.fontWeight');
}
.chapter-title {
  display: inline-block;
  padding: 24px 0 0 0;
  margin: 0;
  text-align: center;
  width: 100%;
}
.chapter-content {
  min-height: 65vh;
}
.chapter-section-title {
  margin: 2.4em 0 1.2em;
  font-size: 1.15em;
  font-weight: 600;
  line-height: 1.5;
  text-align: center;
  color: v-bind('fontColor');
}
.chapter-content .fold-image {
  cursor: pointer;
  color: v-bind('fontColor');
  opacity: v-bind('readerSetting.mixJpOpacity');
  margin: v-bind('`${readerSetting.fontSize * readerSetting.lineSpace}px 0`');
}
.chapter-content p {
  color: v-bind('fontColor');
  margin: v-bind('`${readerSetting.fontSize * readerSetting.lineSpace}px 0`');
  font-size: 1em;
}
.chapter-content p .source {
  display: inline-block;
  user-select: none;
  width: 1em;
  text-align: center;
  opacity: 0.4;
  font-size: 0.75em;
  margin-right: 0.5em;
}
.chapter-content p .first {
  opacity: v-bind('readerSetting.mixZhOpacity');
}
.chapter-content p .second {
  opacity: v-bind('readerSetting.mixJpOpacity');
}
.chapter-content p .text-content {
  text-decoration-line: v-bind(
    "readerSetting.textUnderline === 'none' ? 'none' : 'underline'"
  );
  text-decoration-style: v-bind('readerSetting.textUnderline');
  text-decoration-color: v-bind('underlineColor');
  text-decoration-thickness: 1px;
  text-underline-offset: v-bind('textUnderlineOffset');
}
</style>

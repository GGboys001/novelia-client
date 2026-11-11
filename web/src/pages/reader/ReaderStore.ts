import { defineStore } from 'pinia';

import { WebNovelApi } from '@/api';
import { siteUrls } from '@/config';
import { requiresAddonChapterUpdate } from '@/domain/crawler/providerConfig';
import { GenericNovelId } from '@/model/Common';
import { useLocalVolumeStore } from '@/stores';
import { loadLocalToc } from '@/stores/local/LocalToc';
import type { Result } from '@/util/result';
import { Ok, runCatching } from '@/util/result';

export interface ReaderChapterRange {
  chapterId: string;
  title: string;
  /** 该章节第一段在整篇 paragraphs 中的下标。 */
  paragraphIndex: number;
}

export interface ReaderChapter {
  chapterId: string;
  titleJp: string;
  titleZh?: string;
  novelTitleJp?: string;
  novelTitleZh?: string;
  prevId?: string;
  nextId?: string;
  paragraphs: string[];
  /** 本地小说整篇加载时的章节边界，用于目录跳转。 */
  chapterRanges?: ReaderChapterRange[];
  youdaoParagraphs?: string[];
  gptParagraphs?: string[];
  sakuraParagraphs?: string[];
}

interface ReaderChapterState {
  value?: ReaderChapter;
  promise: Promise<Result<ReaderChapter>>;
}

type ReaderStore = {
  chapters: Map<string, ReaderChapterState>;
};

export const useReaderStore = (gnid: GenericNovelId) => {
  return defineStore(`Reader/${GenericNovelId.toString(gnid)}`, {
    state: () =>
      <ReaderStore>{
        chapters: new Map<string, ReaderChapterState>(),
      },
    actions: {
      loadChapter(
        chapterId: string,
      ):
        | { type: 'async'; promiseOrValue: Promise<Result<ReaderChapter>> }
        | { type: 'sync'; promiseOrValue: Result<ReaderChapter> } {
        const state = this.chapters.get(chapterId);
        if (state === undefined) {
          const promise = runCatching(getChapter(gnid, chapterId)).then(
            (result) => {
              if (
                !result.ok &&
                gnid.type === 'web' &&
                requiresAddonChapterUpdate(gnid.providerId) &&
                result.error.message.includes('从源站获取失败')
              ) {
                result.error.message += `\n可尝试使用最新版爬虫插件更新原文后重试（${siteUrls.addonRepository}）`;
              }
              return result;
            },
          );
          const stateNew: ReaderChapterState = { promise };
          this.chapters.set(chapterId, stateNew);
          return {
            type: 'async',
            promiseOrValue: promise.then((result) => {
              if (result.ok) {
                stateNew.value = result.value;
              } else {
                this.chapters.delete(chapterId);
              }
              return result;
            }),
          };
        } else if (state.value === undefined) {
          return { type: 'async', promiseOrValue: state.promise };
        } else {
          return { type: 'sync', promiseOrValue: Ok(state.value) };
        }
      },

      preloadChapter(chapterId: string) {
        // 在阅读器缓存章节大于1时，才进行预加载
        if (this.chapters.size > 1) {
          this.loadChapter(chapterId);
        }
      },
    },
  })();
};

/** 本地卷不按章节切分，整个文件作为一个虚拟章节加载。 */
export const LOCAL_FULL_CHAPTER_ID = 'all';

const getChapter = async (
  gnid: GenericNovelId,
  chapterId: string,
): Promise<ReaderChapter> => {
  if (gnid.type === 'web') {
    const res = await WebNovelApi.getChapter(
      gnid.providerId,
      gnid.novelId,
      chapterId,
      { retry: requiresAddonChapterUpdate(gnid.providerId) ? 0 : undefined },
    );
    return { ...res, chapterId };
  } else if (gnid.type === 'wenku') {
    throw '不支持文库';
  } else {
    const repo = await useLocalVolumeStore();

    const volumeId = gnid.volumeId;
    const volume = await repo.getVolume(volumeId);
    if (volume === undefined) throw Error('小说不存在');

    // 旧数据没有标题/顺序时，从 EPUB 解析一次并写回元数据。
    const toc = await loadLocalToc(volume);

    // 本地小说一次性加载全部章节，作为一整篇连续内容阅读。
    const chapters = await Promise.all(
      toc.map((it) => repo.getChapter(volumeId, it.chapterId)),
    );
    const paragraphs: string[] = [];
    const chapterRanges: ReaderChapterRange[] = [];
    for (let i = 0; i < chapters.length; i++) {
      const paragraphCount = chapters[i]?.paragraphs.length ?? 0;
      if (paragraphCount > 0) {
        chapterRanges.push({
          chapterId: toc[i].chapterId,
          // 没有可用标题时留空，目录再退回文件名，正文不显示分节标题。
          title: toc[i].title?.trim() || '',
          paragraphIndex: paragraphs.length,
        });
        paragraphs.push(...chapters[i]!.paragraphs);
      }
    }

    // 只有所有章节都存在同一译文时，才能按段落对齐拼接。
    const collectTranslation = (key: 'youdao' | 'gpt' | 'sakura') => {
      if (chapters.length === 0) return undefined;
      if (chapters.some((it) => it?.[key] === undefined)) return undefined;
      return chapters.flatMap((it) => it![key]!.paragraphs);
    };

    return <ReaderChapter>{
      chapterId: LOCAL_FULL_CHAPTER_ID,
      titleJp: volumeId.replace(/\.(epub|txt|srt)$/i, ''),
      titleZh: undefined,
      paragraphs,
      chapterRanges,
      youdaoParagraphs: collectTranslation('youdao'),
      gptParagraphs: collectTranslation('gpt'),
      sakuraParagraphs: collectTranslation('sakura'),
    };
  }
};

import type { Glossary } from './Glossary';

export interface ChapterTranslation {
  glossaryId: string;
  glossary: Glossary;
  paragraphs: string[];
}

export interface LocalVolumeMetadata {
  id: string;
  readAt?: number;
  createAt: number;
  /** 目录解析版本；旧数据缺少标题/顺序，需要重新解析一次 EPUB。 */
  tocVersion?: number;
  toc: {
    chapterId: string;
    /** EPUB 目录里的章节标题，旧数据可能为空。 */
    title?: string;
    baidu?: string; // 保留旧本地数据兼容，避免历史百度翻译索引读取后丢失。
    youdao?: string;
    gpt?: string;
    sakura?: string;
  }[];
  glossaryId: string;
  glossary: Glossary;
  favoredId: string;
}

/** 目录结构版本，变更标题提取规则时加一，触发旧数据重新解析。 */
export const LOCAL_TOC_VERSION = 3;

export interface LocalVolumeChapter {
  id: string;
  volumeId: string;
  paragraphs: string[];
  baidu?: ChapterTranslation; // 保留旧本地数据兼容，允许继续读取历史百度翻译内容。
  youdao?: ChapterTranslation;
  gpt?: ChapterTranslation;
  sakura?: ChapterTranslation;
}

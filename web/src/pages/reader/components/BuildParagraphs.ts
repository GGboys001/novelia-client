import type { GenericNovelId } from '@/model/Common';
import type { TranslatorId } from '@/model/Translator';
import type { ReaderSetting } from '@/stores';
import { useReaderSettingStore, useSettingStore } from '@/stores';
import type { ReaderChapter } from '../ReaderStore';

export type ReaderParagraph =
  | {
      /** 原文段落下标，用于目录跳转与阅读进度（单语模式下会跳过部分段落）。 */
      paragraphIndex?: number;
      indent: string;
      text: string;
      source?: string;
      secondary: boolean;
      needSpeak: boolean;
      missing?: boolean;
    }
  | { paragraphIndex?: number; imageUrl: string }
  | undefined;

/** 平假名/片假名，出现即视为日文段落。 */
const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/;
/** 汉字。 */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const detectLanguage = (text: string): 'zh' | 'jp' | 'other' => {
  if (KANA.test(text)) return 'jp';
  if (HAN.test(text)) return 'zh';
  return 'other';
};

/**
 * 本地双语 EPUB（中日/日中版）没有翻译数组，按段落语言区分主文字与辅文字：
 * 主文字使用主透明度，另一种语言使用辅透明度。
 */
const buildBilingualParagraphs = (
  paragraphs: string[],
  setting: ReaderSetting,
): ReaderParagraph[] => {
  const needSpeakJp =
    setting.mode === 'jp' || setting.speakLanguages.includes('jp');
  const needSpeakZh =
    setting.mode === 'zh' || setting.speakLanguages.includes('zh');

  const languages = paragraphs.map((text) =>
    text.startsWith('<图片>') || text.trim().length === 0
      ? 'other'
      : detectLanguage(text),
  );
  const textCount = languages.filter((it) => it !== 'other').length;
  const jpCount = languages.filter((it) => it === 'jp').length;
  const zhCount = languages.filter((it) => it === 'zh').length;
  const threshold = Math.max(3, Math.floor(textCount * 0.03));
  const bilingual = jpCount >= threshold && zhCount >= threshold;

  const primary =
    setting.mode === 'jp-zh' || setting.mode === 'jp' ? 'jp' : 'zh';
  const only =
    setting.mode === 'zh' || setting.mode === 'jp' ? setting.mode : undefined;
  const hasOnly = languages.includes(only as 'zh' | 'jp');
  const hasPrimary = languages.includes(primary);

  const merged: ReaderParagraph[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    if (paragraph.trim().length === 0) {
      merged.push(undefined);
      continue;
    }
    if (paragraph.startsWith('<图片>')) {
      merged.push({ paragraphIndex: i, imageUrl: paragraph.slice(4) });
      continue;
    }

    const lang = languages[i];
    if (only && hasOnly && lang !== 'other' && lang !== only) continue;

    const text = paragraph.trimStart();
    const indent =
      setting.indentSize !== undefined
        ? '　'.repeat(setting.indentSize)
        : paragraph.slice(0, paragraph.length - text.length);
    merged.push({
      paragraphIndex: i,
      indent,
      text,
      secondary:
        bilingual && hasPrimary && lang !== 'other' && lang !== primary,
      needSpeak: lang === 'jp' ? needSpeakJp : needSpeakZh,
    });
  }
  return merged;
};

export const buildParagraphs = (
  gnid: GenericNovelId,
  chapter: ReaderChapter,
): ReaderParagraph[] => {
  const cc = useSettingStore().cc;
  const setting = useReaderSettingStore().readerSetting;

  const hasTranslation = Boolean(
    chapter.youdaoParagraphs ||
      chapter.gptParagraphs ||
      chapter.sakuraParagraphs,
  );

  // 本地小说没有实测翻译时，按语言识别双语正文。
  if (gnid.type === 'local' && !hasTranslation) {
    return buildBilingualParagraphs(chapter.paragraphs, setting);
  }

  const merged: ReaderParagraph[] = [];
  const styles: {
    paragraphs: string[];
    source?: string;
    secondary: boolean;
    needSpeak: boolean;
  }[] = [];
  const needSpeakJp =
    setting.mode === 'jp' || setting.speakLanguages.includes('jp');
  const needSpeakZh =
    setting.mode === 'zh' || setting.speakLanguages.includes('zh');

  if (setting.mode === 'jp') {
    styles.push({
      paragraphs: chapter.paragraphs,
      source: 'J',
      secondary: false,
      needSpeak: needSpeakJp,
    });
  } else {
    if (setting.mode === 'jp-zh') {
      styles.push({
        paragraphs: chapter.paragraphs,
        source: 'J',
        secondary: true,
        needSpeak: needSpeakJp,
      });
    }

    const paragraphsWithLabel = (
      t: TranslatorId,
    ): [string, string[] | undefined] => {
      if (t === 'youdao') {
        return ['有道', chapter.youdaoParagraphs];
      } else if (t === 'gpt') {
        return ['GPT', chapter.gptParagraphs];
      } else {
        return ['Sakura', chapter.sakuraParagraphs];
      }
    };
    if (setting.translationsMode === 'priority') {
      let hasAnyTranslation = false;
      for (const t of setting.translations) {
        const [label, paragraphs] = paragraphsWithLabel(t);
        if (paragraphs) {
          hasAnyTranslation = true;
          styles.push({
            paragraphs: paragraphs.map((it) => cc.toView(it)),
            source: t[0].toUpperCase(),
            secondary: false,
            needSpeak: needSpeakZh,
          });
          break;
        } else {
          merged.push({
            indent: '',
            text: label + '翻译不存在',
            secondary: true,
            needSpeak: true,
            missing: true,
          });
        }
      }
      if (!hasAnyTranslation) {
        return merged;
      }
    } else {
      let i = 0;
      for (const t of setting.translations) {
        const [label, paragraphs] = paragraphsWithLabel(t);
        if (paragraphs) {
          styles.push({
            paragraphs: paragraphs.map((it) => cc.toView(it)),
            source: t[0].toUpperCase(),
            secondary: false,
            needSpeak: needSpeakZh && i === 0,
          });
        } else {
          merged.push({
            indent: '',
            text: label + '翻译不存在',
            secondary: true,
            needSpeak: true,
            missing: true,
          });
        }
        i++;
      }
    }

    if (setting.mode === 'zh-jp') {
      styles.push({
        paragraphs: chapter.paragraphs,
        source: 'J',
        secondary: true,
        needSpeak: needSpeakJp,
      });
    }
  }

  for (let i = 0; i < chapter.paragraphs.length; i++) {
    const curParagraph = chapter.paragraphs[i];
    if (curParagraph.trim().length === 0) {
      merged.push(undefined);
    } else if (curParagraph.startsWith('<图片>')) {
      merged.push({ imageUrl: curParagraph.slice(4) });
    } else {
      let indentLongest: string = '';
      if (setting.indentSize !== undefined) {
        indentLongest = '　'.repeat(setting.indentSize);
      } else {
        for (const style of styles) {
          const paragraphText = style.paragraphs[i];
          const firstCharIndex = paragraphText.search(/\S|$/);
          const indent = paragraphText.slice(0, firstCharIndex);
          if (indentLongest.length < indent.length) {
            indentLongest = indent;
          }
        }
      }

      for (const style of styles) {
        const paragraphText = style.paragraphs[i];
        const text = paragraphText.trimStart();
        merged.push({
          indent: indentLongest,
          text,
          source: style.source,
          secondary: style.secondary,
          needSpeak: style.needSpeak,
        });
      }
    }
  }
  return merged;
};

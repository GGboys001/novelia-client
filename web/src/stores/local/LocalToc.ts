import { LOCAL_TOC_VERSION } from '@/model/LocalVolume';
import type { LocalVolumeMetadata } from '@/model/LocalVolume';
import { Epub } from '@/util/file';

import { useLocalVolumeStore } from './index';

const cache = new Map<string, LocalVolumeMetadata['toc']>();

/**
 * 读取本地卷目录：补齐 EPUB 章节标题，并按 spine 顺序排列。
 *
 * 旧数据的标题/顺序不符合当前规则（可能混入扉页、插图、出版信息），
 * 解析一次 EPUB 后写回 IndexedDB，并用 tocVersion 记录。
 */
export const loadLocalToc = async (volume: LocalVolumeMetadata) => {
  const cached = cache.get(volume.id);
  if (cached) return cached;

  if (volume.tocVersion === LOCAL_TOC_VERSION) {
    cache.set(volume.id, volume.toc);
    return volume.toc;
  }

  try {
    const repo = await useLocalVolumeStore();
    const record = await repo.getFile(volume.id);
    let resolved = volume.toc;
    if (record?.file.name.toLowerCase().endsWith('.epub')) {
      const epub = await Epub.fromFile(record.file);
      const titles = epub.getChapterTitles();
      const order = new Map(
        epub.iterDocInSpine().map((item, index) => [item.href, index]),
      );
      resolved = [...volume.toc]
        .sort(
          (a, b) =>
            (order.get(a.chapterId) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(b.chapterId) ?? Number.MAX_SAFE_INTEGER),
        )
        // 重新解析时不沿用旧标题，避免残留扉页/出版信息等无效标题。
        .map((it) => ({
          ...it,
          title: titles.get(it.chapterId) || '',
        }));
    }
    // 非 EPUB（TXT/SRT）没有章节名可补全，也要记录版本避免反复解析。
    await repo.updateToc(volume.id, resolved);
    cache.set(volume.id, resolved);
    return resolved;
  } catch (error) {
    return volume.toc;
  }
};

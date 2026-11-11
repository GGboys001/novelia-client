import { v4 as uuidv4 } from 'uuid';

import { LOCAL_TOC_VERSION } from '@/model/LocalVolume';
import { parseFile, Srt } from '@/util/file';

import { EpubParserV1 } from './EpubParser';
import type { LocalVolumeDao } from './LocalVolumeDao';

export type LocalVolumeImportPhase = 'parsing' | 'saving';

export const createVolume = async (
  dao: LocalVolumeDao,
  file: File,
  favoredId: string,
  onPhase?: (phase: LocalVolumeImportPhase) => void,
) => {
  const id = file.name;
  if ((await dao.getMetadata(id)) !== undefined) {
    throw Error('小说已经存在');
  }

  const chapters: {
    chapterId: string;
    title?: string;
    paragraphs: string[];
  }[] = [];

  onPhase?.('parsing');
  const myFile = await parseFile(file);

  if (myFile.type === 'txt') {
    const lines = myFile.text.split('\n');
    const chunkSize = 1000;
    for (let i = 0; i < lines.length; i += chunkSize) {
      const paragraphs = lines.slice(i, i + chunkSize);
      chapters.push({ chapterId: i.toString(), paragraphs });
    }
  } else if (myFile.type === 'epub') {
    const chapterTitles = myFile.getChapterTitles();
    // 按 spine（阅读顺序）导入，避免受 manifest 顺序影响。
    for (const item of myFile.iterDocInSpine()) {
      const paragraphs = await EpubParserV1.extractText(item.doc, (src) =>
        myFile.resolveResourceDataUrl(item.href, src),
      );
      // 只保存目录项/正文章节标题，扉页、插图、出版信息等留空。
      const title =
        chapterTitles.get(item.href)?.replace(/\s+/g, ' ').trim() || undefined;
      chapters.push({ chapterId: item.href, title, paragraphs });
    }
  } else if (myFile.type === 'srt') {
    const lines = myFile.subtitles
      .flatMap((it) => it.text)
      .map((it) => Srt.cleanFormat(it));
    chapters.push({ chapterId: '0'.toString(), paragraphs: lines });
  }

  onPhase?.('saving');
  // EPUB 的导航页/封面等没有正文，导入时跳过，避免打开后停在空白章节。
  const readableChapters = chapters.filter((it) =>
    it.paragraphs.some((p) => p.trim().length > 0),
  );
  const finalChapters =
    readableChapters.length > 0 ? readableChapters : chapters;
  for (const { chapterId, paragraphs } of finalChapters) {
    await dao.createChapter({
      id: `${id}/${chapterId}`,
      volumeId: id,
      paragraphs,
    });
  }
  await dao.createMetadata({
    id,
    createAt: Date.now(),
    tocVersion: LOCAL_TOC_VERSION,
    toc: finalChapters.map((it) => ({
      chapterId: it.chapterId,
      // 没有标题时写空字符串，表示已经解析过、无需再从 EPUB 补全。
      title: it.title ?? '',
    })),
    glossaryId: uuidv4(),
    glossary: {},
    favoredId,
  });
  await dao.createFile(id, file);
};

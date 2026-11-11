import { BaseFile } from './base';
import { StandardNovel } from './standard';

const MIMETYPE_PATH = 'mimetype';
const MIMETYPE_TEMPLATE = 'application/epub+zip';

const CONTAINER_PATH = 'META-INF/container.xml';
const CONTAINER_TEMPLATE = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const getEl = (doc: Document, tagName: string) =>
  doc.getElementsByTagName(tagName).item(0);

const normalizeTitle = (value: string | null | undefined) =>
  (value ?? '').replace(/\s+/g, ' ').trim();

const compactTitle = (value: string) => value.replace(/\s+/g, '');

/** 出版/版权信息等页面不应当作章节标题。 */
const PUBLICATION_TITLE =
  /装订|装丁|発行|发行|印刷|出版|ISBN|定価|定价|Copyright|©/i;

/** 判断正文首段是否像章节标题（编号、第X章或常见章节名）。 */
const isChapterTitle = (title: string) => {
  const compact = compactTitle(title);
  return (
    /^第[0-9０-９一二三四五六七八九十百千零〇两]+[章回节節话話卷部篇]/.test(
      compact,
    ) ||
    /^[0-9０-９]+/.test(compact) ||
    /^(序章|序說|序说|序|プロローグ|エピローグ|终章|終章|尾声|尾聲|后记|後記|あとがき|目次|目錄|目录|幕间|幕間|闲话|閑話|番外)/.test(
      compact,
    )
  );
};

/** 奥付及其之后的内容是版权/出版信息，不再生成章节标题。 */
const isColophonTitle = (title: string) =>
  /^(奥付|版权页|版權頁|colophon)$/i.test(compactTitle(title));

/**
 * 从正文文档中提取章节标题：优先 h1～h3，其次首个短段落。
 *
 * 部分 EPUB 的 nav 只包含封面/奥付，章节标题写在正文第一段
 * （如「1　序章」），此时需要从正文补全。
 */
export const extractDocumentTitle = (doc: Document) => {
  const looksLikeTitle = (text: string) =>
    text.length > 0 && text.length <= 40 && !text.includes('。');

  for (const el of Array.from(doc.querySelectorAll('h1, h2, h3'))) {
    const text = normalizeTitle(el.textContent);
    if (looksLikeTitle(text)) return text;
  }
  for (const el of Array.from(doc.body?.querySelectorAll('p') ?? [])) {
    const text = normalizeTitle(el.textContent);
    if (!text) continue;
    return looksLikeTitle(text) ? text : undefined;
  }
  return undefined;
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const MIME = {
  IMAGE: [
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/svg+xml',
    'image/webp',
  ],
  CSS: ['text/css'],
};

type EpubItemBase = {
  id: string;
  href: string;
  mediaType: string;
  overlay: string | null;
  properties: string[] | null;
  fallback: string | null;
};
type EpubItemDoc = EpubItemBase & { doc: Document };
type EpubItemBlob = EpubItemBase & { blob: Blob };
type EpubItem = EpubItemDoc | EpubItemBlob;

interface EpubItemref {
  idref: string;
  linear: string | null;
  properties: string[] | null;
}

interface EpubNavItem {
  text: string;
  href?: string;
  children: EpubNavItem[];
}

export class Epub extends BaseFile {
  type = 'epub' as const;
  packagePath: string = '';
  navigationPath: string | undefined;
  ncxPath: string | undefined;
  packageDoc!: Document;
  items = new Map<string, EpubItem>();
  itemrefs: EpubItemref[] = [];
  navItems: EpubNavItem[] = [];

  private resolve(root: string, rpath: string) {
    const rootUrl = new URL(root, 'file://book');
    const newURL = new URL(rpath, rootUrl);
    return decodeURIComponent(newURL.pathname.substring(1));
  }

  /** 把文档内的相对资源（如插图）解析为内嵌 data URL，便于本地持久化。 */
  async resolveResourceDataUrl(
    fromHref: string,
    src: string,
  ): Promise<string | undefined> {
    const value = src.trim();
    if (!value) return undefined;
    if (value.startsWith('data:')) return value;
    // http(s) 等外链图片不内嵌，避免离线阅读时依赖网络。
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;

    const docPath = this.resolve(this.packagePath, fromHref);
    const targetPath = this.resolve(docPath, value.split('#')[0]);
    for (const item of this.items.values()) {
      if (!('blob' in item)) continue;
      if (this.resolve(this.packagePath, item.href) !== targetPath) continue;
      return await blobToDataUrl(item.blob);
    }
    return undefined;
  }

  // 目录中的链接相对于目录文件，转换为与 manifest href 一致的相对于 package 的路径
  private toPackageHref(docPath: string, href: string) {
    if (!href) return href;
    const path = this.resolve(docPath, href);
    const packageDir = this.packagePath.slice(
      0,
      this.packagePath.lastIndexOf('/') + 1,
    );
    return path.startsWith(packageDir) ? path.slice(packageDir.length) : path;
  }

  private updateHref(oldHref: string, newHref: string) {
    // TODO
  }

  // ==============================
  // 读取文件内容
  // ==============================

  private parseProperties(attr: string | null) {
    if (!attr) return null;
    return attr.split(' ').filter((prop) => prop);
  }

  private parseContainer(doc: Document) {
    const rootfile = getEl(doc, 'rootfile');
    if (!rootfile) throw new Error('Container does not have rootfile');
    const packagePath = rootfile.getAttribute('full-path');
    if (!packagePath) throw new Error('Container does not have package path');
    this.packagePath = packagePath;
  }

  private parsePackage(doc: Document) {
    const metadata = getEl(doc, 'metadata');
    if (!metadata) throw new Error('Package does not have metadata');
    const manifest = getEl(doc, 'manifest');
    if (!manifest) throw new Error('Package does not have manifest');
    const spine = getEl(doc, 'spine');
    if (!spine) throw new Error('Package does not have spine');

    this.packageDoc = doc;
    this.parseManifest(manifest);
    this.parseSpine(spine);
  }

  private parseManifest(el: Element) {
    for (const itemEl of Array.from(el.getElementsByTagName('item'))) {
      const id = itemEl.getAttribute('id');
      if (!id) throw new Error('Manifest item does not have id');
      const href = itemEl.getAttribute('href');
      if (!href) throw new Error('Manifest item does not have href');
      const mediaType = itemEl.getAttribute('media-type');
      if (!mediaType) throw new Error('Manifest item does not have media type');
      const overlay = itemEl.getAttribute('media-overlay');
      const properties = itemEl.getAttribute('properties');
      const fallback = itemEl.getAttribute('fallback');

      const itemBase: EpubItemBase = {
        id,
        href,
        mediaType,
        overlay,
        properties: this.parseProperties(properties),
        fallback,
      };
      this.items.set(id, itemBase as EpubItem);
    }

    const navHref = Array.from(this.items.values()).find(({ properties }) =>
      properties?.includes('nav'),
    )?.href;
    this.navigationPath = navHref && this.resolve(this.packagePath, navHref);
  }

  private parseSpine(el: Element) {
    for (const itemEl of Array.from(el.getElementsByTagName('itemref'))) {
      const idref = itemEl.getAttribute('idref');
      if (!idref) throw new Error('Spine itemref does not have idref');
      if (!this.items.has(idref))
        throw new Error('Spine itemref idref not in manifest');
      const linear = itemEl.getAttribute('linear');
      const properties = itemEl.getAttribute('properties');

      const itemref: EpubItemref = {
        idref,
        linear,
        properties: this.parseProperties(properties),
      };
      this.itemrefs.push(itemref);
    }
    const tocIdref = el.getAttribute('toc');
    if (tocIdref) {
      const tocItem = this.items.get(tocIdref);
      const tocItemHref = tocItem?.href;
      this.ncxPath = tocItemHref && this.resolve(this.packagePath, tocItemHref);
    }
  }

  private parseNavigationDocument(doc: Document) {
    const parseTocList = (olEl: Element): EpubNavItem[] => {
      const items: EpubNavItem[] = [];

      olEl.querySelectorAll(':scope > li').forEach((liEl) => {
        const linkEl = liEl.querySelector(':scope > a, :scope > span');
        if (!linkEl) throw new Error('Nav toc item does not have link');

        const item: EpubNavItem = {
          text: linkEl.textContent?.trim() || '',
          href: this.toPackageHref(
            this.navigationPath!,
            linkEl.getAttribute('href')?.split('#')[0] || '',
          ),
          children: [],
        };
        const childOlEl = liEl.querySelector(':scope > ol');
        if (childOlEl) item.children = parseTocList(childOlEl);
        items.push(item);
      });
      return items;
    };
    const navEls = Array.from(doc.getElementsByTagName('nav'));
    const tocNavEl =
      navEls.find((navEl) => navEl.getAttribute('epub:type') === 'toc') ??
      navEls.find((navEl) => navEl.id === 'toc'); // 为了兼容不标准的epub
    const tocOlEl = tocNavEl?.querySelector(':scope > ol');
    if (!tocOlEl) throw new Error('Nav toc not exist');
    this.navItems = parseTocList(tocOlEl);
  }

  private parseNcx(doc: Document) {
    Array.from(doc.getElementsByTagName('navPoint')).forEach((navPointEl) => {
      const navLabel = navPointEl.querySelector('navLabel');
      if (!navLabel) throw new Error('Nav point does not have label');
      const content = navPointEl.querySelector('content');
      if (!content) throw new Error('Nav point does not have content');

      const text = navLabel.textContent?.trim() || '';
      const href = this.toPackageHref(
        this.ncxPath!,
        content.getAttribute('src')?.split('#')[0] || '',
      );

      const item: EpubNavItem = {
        text,
        href,
        children: [],
      };
      this.navItems.push(item);
    });
  }

  private async parseFile(file: File) {
    const { BlobReader, BlobWriter, ZipReader, TextWriter } = await import(
      '@zip.js/zip.js'
    );
    const reader = new ZipReader(new BlobReader(file));
    const entries = new Map(
      (await reader.getEntries()).map((obj) => [obj.filename, obj] as const),
    );

    const readDocWithType = async (
      path: string,
      type: DOMParserSupportedType,
    ) => {
      const entry = entries.get(path);
      if (!entry || !('getData' in entry))
        throw new Error(`Entry not found or invalid: ${path}`);
      const text = await entry.getData!(new TextWriter());
      const parser = new DOMParser();
      return parser.parseFromString(text, type);
    };

    const readDoc = async (path: string) =>
      readDocWithType(path, 'application/xhtml+xml');
    const readDocLegacy = async (path: string) =>
      readDocWithType(path, 'text/html');

    const readBlob = async (path: string, type: string) => {
      const entry = entries.get(path);
      if (!entry || !('getData' in entry))
        throw new Error(`Entry not found or invalid: ${path}`);
      const data = await entry.getData!(new BlobWriter());
      return new Blob([data], { type });
    };

    this.parseContainer(await readDoc(CONTAINER_PATH));
    this.parsePackage(await readDoc(this.packagePath));

    if (this.navigationPath) {
      this.parseNavigationDocument(await readDoc(this.navigationPath));
    } else if (this.ncxPath) {
      this.parseNcx(await readDoc(this.ncxPath));
    }

    for (const item of this.items.values()) {
      const path = this.resolve(this.packagePath, item.href);

      if (item.mediaType === 'application/xhtml+xml') {
        (item as EpubItemDoc).doc = await readDoc(path);
      } else if (item.mediaType === 'text/html') {
        item.mediaType = 'application/xhtml+xml';
        (item as EpubItemDoc).doc = await readDocLegacy(path);
      } else {
        (item as EpubItemBlob).blob = await readBlob(path, item.mediaType);
      }
    }
  }

  static async fromFile(file: File) {
    const epub = new Epub(file.name, file);
    await epub.parseFile(file);
    StandardNovel.fromEpub(epub);
    return epub;
  }

  async clone() {
    if (!this.rawFile)
      throw new Error('Cannot clone manually constructed file.');
    return Epub.fromFile(this.rawFile);
  }

  // ==============================
  // 将内容写入文件
  // ==============================

  private fixHrefExtension() {
    const getFileExtension = (path: string) => {
      const match = path.match(/\.([a-zA-Z0-9]+)$/);
      if (match) return match[1];
      return '';
    };

    const mimeToExtensions: { [key: string]: string[] } = {
      'image/gif': ['.gif'],
      'image/jpeg': ['.jpg', '.jpeg', '.jpe', '.jif', '.jfif'],
      'image/png': ['.png'],
      'image/svg+xml': ['.svg'],
      'image/webp': ['.webp'],
    };
    for (const item of this.items.values()) {
      const mime = item.mediaType;
      if (mime in mimeToExtensions) {
        const extensions = mimeToExtensions[mime];
        const ext = getFileExtension(item.href);
        if (!extensions.includes(ext)) {
          const newHref = item.href.replace(/\.([a-zA-Z0-9]+)$/, extensions[0]);
          this.updateHref(item.href, newHref);
          item.href = newHref;
        }
      }
    }
  }

  private updatePackage() {
    const packageDocNs = this.packageDoc.documentElement.namespaceURI;
    const items = [...this.items.values()].map((item) => {
      const itemEl = this.packageDoc.createElementNS(packageDocNs, 'item');
      itemEl.setAttribute('id', item.id);
      itemEl.setAttribute('href', item.href);
      itemEl.setAttribute('media-type', item.mediaType);
      if (item.overlay) itemEl.setAttribute('media-overlay', item.overlay);
      if (item.properties)
        itemEl.setAttribute('properties', item.properties.join(' '));
      if (item.fallback) itemEl.setAttribute('fallback', item.fallback);
      return itemEl;
    });
    const manifest = getEl(this.packageDoc, 'manifest')!;
    manifest.replaceChildren(...items);
  }

  async toBlob() {
    // this.fixHrefExtension();
    this.updatePackage();

    const { BlobReader, BlobWriter, ZipWriter, TextReader } = await import(
      '@zip.js/zip.js'
    );

    const zipBlobWriter = new BlobWriter();
    const writer = new ZipWriter(zipBlobWriter);

    const writeText = (path: string, text: string) =>
      writer.add(path, new TextReader(text));
    const writeBlob = (path: string, blob: Blob) =>
      writer.add(path, new BlobReader(blob));
    const writeDoc = (path: string, doc: Document) =>
      writeText(path, new XMLSerializer().serializeToString(doc));

    await writeText(MIMETYPE_PATH, MIMETYPE_TEMPLATE);
    await writeText(
      CONTAINER_PATH,
      CONTAINER_TEMPLATE.replace('OEBPS/content.opf', this.packagePath),
    );
    await writeDoc(this.packagePath, this.packageDoc);

    for (const item of this.items.values()) {
      const path = this.resolve(this.packagePath, item.href);
      if ('doc' in item) {
        await writeDoc(path, item.doc);
      } else {
        await writeBlob(path, item.blob);
      }
    }

    await writer.close();

    const zipBlob = await zipBlobWriter.getData();
    return zipBlob;
  }

  // ==============================
  // API
  // ==============================

  iterDocInSpine() {
    return this.itemrefs
      .map((itemref) => this.items.get(itemref.idref)!)
      .filter((item) => 'doc' in item);
  }
  iterDoc() {
    return [...this.items.values()].filter((item) => 'doc' in item);
  }
  /**
   * 提取章节标题：nav/ncx 优先，其余章节从正文补全。
   *
   * 只保留「表紙 / 目次 / 正文章节名 / 奥付」这类目录项：
   * 扉页、插图、注意事项、装订信息等不生成标题。
   */
  getChapterTitles() {
    const titles = new Map<string, string>();
    const walk = (items: EpubNavItem[]) => {
      for (const item of items) {
        if (item.href && item.text) titles.set(item.href, item.text);
        walk(item.children);
      }
    };
    walk(this.navItems);
    const navHrefs = new Set(titles.keys());

    const spine = this.iterDocInSpine();
    const spineIndex = new Map(
      spine.map((item, index) => [item.href, index] as const),
    );

    // 奥付之后是出版/版权信息，不再作为章节。
    let endIndex = spine.length;
    for (const [href, title] of titles) {
      if (!isColophonTitle(title)) continue;
      const index = spineIndex.get(href);
      if (index !== undefined) endIndex = Math.min(endIndex, index);
    }

    // 从第一个像章节的正文标题开始，之前的封面/扉页等不生成标题。
    let startIndex = 0;
    let foundChapter = false;
    for (let i = 0; i < spine.length; i++) {
      const item = spine[i];
      if (navHrefs.has(item.href)) continue;
      const candidate = extractDocumentTitle(item.doc);
      if (candidate && isChapterTitle(candidate)) {
        startIndex = i;
        foundChapter = true;
        break;
      }
    }
    if (!foundChapter) startIndex = 0;

    const bookTitle = this.getBookTitle();
    for (let i = startIndex; i < endIndex; i++) {
      const item = spine[i];
      if (titles.has(item.href)) continue;
      const title = extractDocumentTitle(item.doc);
      if (!title || title === bookTitle) continue;
      if (PUBLICATION_TITLE.test(title)) continue;
      titles.set(item.href, title);
    }
    return titles;
  }

  /** EPUB 书名（dc:title），用于过滤正文里重复的书名标题。 */
  getBookTitle() {
    const metadata = getEl(this.packageDoc, 'metadata');
    if (!metadata) return undefined;
    const title =
      metadata.getElementsByTagNameNS(
        'http://purl.org/dc/elements/1.1/',
        'title',
      )[0] ?? metadata.getElementsByTagName('dc:title')[0];
    return normalizeTitle(title?.textContent) || undefined;
  }
  iterBlob(mediaTypes: string[]) {
    return [...this.items.values()]
      .filter((item) => 'blob' in item)
      .filter((item) => mediaTypes.includes(item.mediaType));
  }
  iterImage() {
    return this.iterBlob(MIME.IMAGE);
  }

  updateImage(id: string, blob: Blob) {
    if (!MIME.IMAGE.includes(blob.type)) return;

    const item = this.items.get(id);
    if (!item || !('blob' in item) || !MIME.IMAGE.includes(item.mediaType))
      return;

    item.mediaType = blob.type;
    item.blob = blob;
  }

  cleanStyle() {
    for (const item of this.iterBlob(MIME.CSS)) {
      item.blob = new Blob([''], { type: item.mediaType });
    }
  }

  getText() {
    const contents: string[] = [];
    for (const item of this.iterDocInSpine()) {
      Array.from(item.doc.getElementsByClassName('rt')).forEach((node) =>
        node.parentNode!.removeChild(node),
      );
      contents.push(item.doc.body.textContent ?? '');
    }
    return contents.join('\n');
  }

  getRaw(): Record<string, string> {
    const rawContents: Record<string, string> = {};
    for (const item of this.iterDocInSpine()) {
      let id = item.id;
      if (item.id in rawContents) {
        id = `${item.id}_${Math.random().toString(16).slice(2)}`;
      }
      rawContents[id] = item.doc.body.innerHTML;
    }
    return rawContents;
  }
}

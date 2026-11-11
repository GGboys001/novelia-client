interface EpubParser {
  extractText: (
    doc: Document,
    resolveImage?: (src: string) => Promise<string | undefined>,
  ) => Promise<string[]>;
  injectTranslation: (
    doc: Document,
    mode: 'zh' | 'jp-zh' | 'zh-jp',
    zhLinesList: string[][],
  ) => Document;
}

export const EpubParserV1: EpubParser = {
  extractText: async (doc, resolveImage) => {
    Array.from(doc.getElementsByTagName('rt')).forEach((node) =>
      node.parentNode!.removeChild(node),
    );
    Array.from(doc.getElementsByTagName('rp')).forEach((node) =>
      node.parentNode!.removeChild(node),
    );

    // 按文档顺序遍历段落与插图，插图以内嵌数据的形式与正文一起保存。
    const paragraphs: string[] = [];
    const nodes = Array.from(doc.body.querySelectorAll('p, img, image'));
    for (const node of nodes) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'p') {
        const text = (node as HTMLElement).innerText.trim();
        if (text) paragraphs.push(text);
        continue;
      }
      if (!resolveImage) continue;
      const src =
        node.getAttribute('src') ??
        node.getAttribute('xlink:href') ??
        node.getAttribute('href');
      if (!src) continue;
      const dataUrl = await resolveImage(src);
      if (dataUrl) paragraphs.push(`<图片>${dataUrl}`);
    }
    return paragraphs;
  },
  injectTranslation: (
    doc: Document,
    mode: 'zh' | 'jp-zh' | 'zh-jp',
    zhLinesList: string[][],
  ) => {
    Array.from(doc.body.getElementsByTagName('p'))
      .filter((el) => el.innerText.trim().length !== 0)
      .forEach((el, index) => {
        if (mode === 'zh') {
          zhLinesList.forEach((lines) => {
            const p = document.createElement('p');
            const t = document.createTextNode(lines[index]);
            p.appendChild(t);
            el.parentNode!.insertBefore(p, el);
          });
          el.parentNode!.removeChild(el);
        } else if (mode === 'jp-zh') {
          zhLinesList.forEach((lines) => {
            const p = document.createElement('p');
            const t = document.createTextNode(lines[index]);
            p.appendChild(t);
            el.parentNode!.insertBefore(p, el.nextSibling);
          });
          el.setAttribute('style', 'opacity:0.4;');
        } else {
          zhLinesList.forEach((lines) => {
            const p = document.createElement('p');
            const t = document.createTextNode(lines[index]);
            p.appendChild(t);
            el.parentNode!.insertBefore(p, el);
          });
          el.setAttribute('style', 'opacity:0.4;');
        }
      });

    return doc;
  },
};

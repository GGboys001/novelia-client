import { Toast } from '@novelia/web-kit';
import { invoke } from '@tauri-apps/api/core';
import { useDownloadStore } from '@/stores/useDownloadStore';

/** 是否运行在 Tauri 客户端内（下载需要交给原生落盘）。 */
export const isTauriClient = () =>
  '__TAURI_INTERNALS__' in (globalThis as Record<string, unknown>);

const DOWNLOAD_DIR_HINT_KEY = 'novelia:download-dir-hint';

/** 首次下载时提醒一次：保存位置可在设置里修改。 */
const maybeShowDownloadDirHint = () => {
  try {
    if (localStorage.getItem(DOWNLOAD_DIR_HINT_KEY)) return;
    localStorage.setItem(DOWNLOAD_DIR_HINT_KEY, '1');
  } catch (error) {
    return;
  }
  Toast.info('文件会保存到默认下载目录，可在「设置 → 下载目录」中修改', {
    duration: 5000,
  });
};

const inferExtension = (blob: Blob, url: string) => {
  const type = blob.type.toLowerCase();
  if (type.includes('epub')) return '.epub';
  if (type.startsWith('text/plain')) return '.txt';
  if (type.includes('zip')) return '.zip';
  const match = /\.(epub|txt|zip)$/i.exec(new URL(url).pathname);
  return match ? match[0].toLowerCase() : '';
};

/** 补全扩展名：文库接口返回的文件名不带后缀，按响应类型补。 */
const resolveFilename = (filename: string, blob: Blob, url: string) => {
  const base = (filename || 'novelia-download').trim();
  if (/\.[a-z0-9]{1,8}$/i.test(base)) return base;
  return `${base}${inferExtension(blob, url)}`;
};

/** 浏览器环境下的兜底：临时 a 标签触发下载。 */
const browserDownload = (filename: string, blob: Blob) => {
  const el = document.createElement('a');
  el.href = URL.createObjectURL(blob);
  el.target = '_blank';
  el.download = filename;
  el.click();
  setTimeout(() => URL.revokeObjectURL(el.href), 60_000);
};

/** 把已保存的 EPUB 导入「我的收藏 → 本地小说」，下载后即可直接阅读。 */
const importEpub = async (
  filename: string,
  data: BlobPart,
  savedPath: string,
) => {
  try {
    // 动态引入，避免 util 与 stores 之间的循环依赖。
    const { useLocalVolumeStore } = await import('@/stores');
    const repo = await useLocalVolumeStore();
    await repo.createVolume(new File([data], filename), 'default');
    Toast.success(`已加入本地小说：${filename}`);
    return true;
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (message.includes('已经存在')) {
      Toast.success(`已保存到 ${savedPath}`);
      return true;
    }
    Toast.warning(`已保存到 ${savedPath}，导入本地小说失败：${message}`);
    return false;
  }
};

/**
 * 保存内存中的 Blob 到本地（工具箱导出、批量打包等）。
 *
 * Android WebView 没有下载管理器，`<a download>` 与 blob 链接点击后毫无反应，
 * 因此客户端内统一走原生 `save_download` 命令写到下载目录。
 */
export const downloadBlob = async (filename: string, blob: Blob) => {
  const name = resolveFilename(filename, blob, location.href);
  if (!isTauriClient()) {
    browserDownload(name, blob);
    return;
  }

  const store = useDownloadStore();
  const taskId = store.startTask(name);
  maybeShowDownloadDirHint();
  let savedPath: string;
  try {
    const data = Array.from(new Uint8Array(await blob.arrayBuffer()));
    savedPath = await invoke<string>('save_download', { filename: name, data });
  } catch (error) {
    store.failTask(taskId, String(error));
    Toast.error(`下载失败：${error}`);
    return;
  }

  if (!name.toLowerCase().endsWith('.epub')) {
    store.completeTask(taskId, savedPath);
    Toast.success(`已保存到 ${savedPath}`);
    return;
  }
  store.setImporting(taskId);
  await importEpub(name, blob, savedPath);
  store.completeTask(taskId, savedPath);
};

/** 下载链接指向的文件（详情页、工作区的下载按钮）。 */
export const downloadUrl = async (url: string, filename: string) => {
  if (!url) return;
  const href = new URL(url, location.href).toString();

  if (!isTauriClient()) {
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await downloadBlob(filename, await response.blob());
    } catch (error) {
      Toast.error(
        `下载失败：${error instanceof Error ? error.message : error}`,
      );
    }
    return;
  }

  // 客户端内由原生侧通过本地代理下载，避免大文件经 IPC 序列化的开销。
  const store = useDownloadStore();
  const taskId = store.startTask(filename || 'novelia-download');
  maybeShowDownloadDirHint();
  Toast.info('开始下载…', { duration: 2000 });

  let savedPath: string;
  try {
    savedPath = await invoke<string>('download_url', {
      url: href,
      filename,
      taskId,
    });
  } catch (error) {
    store.failTask(taskId, String(error));
    Toast.error(`下载失败：${error}`);
    return;
  }

  const name = savedPath.split(/[\\/]/).pop() ?? filename;
  if (!name.toLowerCase().endsWith('.epub')) {
    store.completeTask(taskId, savedPath);
    Toast.success(`已保存到 ${savedPath}`);
    return;
  }

  store.setImporting(taskId);
  try {
    const data = await invoke<ArrayBuffer>('read_download', {
      path: savedPath,
    });
    await importEpub(name, data, savedPath);
  } catch (error) {
    Toast.warning(`已保存到 ${savedPath}，读取文件失败：${error}`);
  }
  store.completeTask(taskId, savedPath);
};

/**
 * 拦截 `<a download>` 点击，改由原生落盘。
 *
 * 详情页与工作区的下载按钮都是 `tag="a"` + `download` 属性，WebView 内既不
 * 会弹出保存对话框也不会写入文件。
 */
export const installDownloadInterceptor = () => {
  if (!isTauriClient()) return;
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.(
        'a[download]',
      ) as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('javascript:')) return;
      event.preventDefault();
      event.stopPropagation();
      void downloadUrl(
        anchor.href,
        anchor.getAttribute('download') ?? anchor.textContent ?? '',
      );
    },
    true,
  );
};

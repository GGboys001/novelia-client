import { createGlobalState } from '@vueuse/core';
import { listen } from '@tauri-apps/api/event';
import { nanoid } from 'nanoid';

export interface DownloadTask {
  id: string;
  filename: string;
  status: 'downloading' | 'importing' | 'done' | 'failed';
  /** 已接收字节数。 */
  received: number;
  /** 总字节数，0 表示未知。 */
  total: number;
  savedPath?: string;
  error?: string;
  createAt: number;
}

interface DownloadProgressPayload {
  id: string;
  received: number;
  total: number;
}

const isTauriClient = () =>
  '__TAURI_INTERNALS__' in (globalThis as Record<string, unknown>);

export const useDownloadStore = createGlobalState(() => {
  const tasks = ref<DownloadTask[]>([]);

  const activeCount = computed(
    () =>
      tasks.value.filter(
        (it) => it.status === 'downloading' || it.status === 'importing',
      ).length,
  );

  const startTask = (filename: string) => {
    const id = nanoid();
    tasks.value.unshift({
      id,
      filename: filename || '未命名文件',
      status: 'downloading',
      received: 0,
      total: 0,
      createAt: Date.now(),
    });
    // 只保留最近 30 条，避免列表无限增长。
    if (tasks.value.length > 30) tasks.value.length = 30;
    return id;
  };

  const updateProgress = (payload: DownloadProgressPayload) => {
    const task = tasks.value.find((it) => it.id === payload.id);
    if (!task) return;
    task.received = payload.received;
    if (payload.total > 0) task.total = payload.total;
  };

  const setImporting = (id: string) => {
    const task = tasks.value.find((it) => it.id === id);
    if (task) {
      task.status = 'importing';
      if (task.total > 0) task.received = task.total;
    }
  };

  const completeTask = (id: string, savedPath: string) => {
    const task = tasks.value.find((it) => it.id === id);
    if (!task) return;
    task.status = 'done';
    task.savedPath = savedPath;
    if (task.total > 0) task.received = task.total;
  };

  const failTask = (id: string, error: string) => {
    const task = tasks.value.find((it) => it.id === id);
    if (!task) return;
    task.status = 'failed';
    task.error = error;
  };

  const clearFinished = () => {
    tasks.value = tasks.value.filter(
      (it) => it.status === 'downloading' || it.status === 'importing',
    );
  };

  return {
    tasks,
    activeCount,
    startTask,
    updateProgress,
    setImporting,
    completeTask,
    failTask,
    clearFinished,
  };
});

let progressListenerInstalled = false;

/** 全局安装一次下载进度监听（仅客户端内）。 */
export const installDownloadProgressListener = () => {
  if (progressListenerInstalled || !isTauriClient()) return;
  progressListenerInstalled = true;
  void listen<DownloadProgressPayload>('download://progress', (event) => {
    useDownloadStore().updateProgress(event.payload);
  });
};

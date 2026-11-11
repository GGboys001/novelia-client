<script lang="ts" setup>
import { invoke } from '@tauri-apps/api/core';
import { XButton, XDrawer } from '@novelia/web-kit';
import {
  CloudDownloadOutlined,
  DeleteSweepOutlined,
  FileDownloadOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  SettingsOutlined,
} from '@vicons/material';

import { useDownloadStore } from '@/stores/useDownloadStore';
import type { DownloadTask } from '@/stores/useDownloadStore';
import { isTauriClient } from '@/util/download';

const store = useDownloadStore();
const { tasks, activeCount } = store;
const show = ref(false);
const downloadDir = ref('');
const router = useRouter();

const finishedCount = computed(() => tasks.value.length - activeCount.value);

const headerSubtitle = computed(() => {
  if (activeCount.value > 0) return `${activeCount.value} 个任务进行中`;
  if (tasks.value.length > 0) return `共 ${tasks.value.length} 个任务`;
  return '暂无下载任务';
});

const loadDownloadDir = async () => {
  if (!isTauriClient()) return;
  try {
    const settings = await invoke<{ resolved_dir: string }>(
      'get_download_settings',
    );
    downloadDir.value = settings.resolved_dir;
  } catch (error) {
    downloadDir.value = '';
  }
};

watch(show, (value) => {
  if (value) void loadDownloadDir();
});

const goSetting = () => {
  show.value = false;
  void router.push('/setting');
};

const fileKind = (filename: string) => {
  const match = /\.([a-z0-9]{1,4})$/i.exec(filename);
  return match ? match[1].toUpperCase() : 'FILE';
};

const statusLabel = (task: DownloadTask) => {
  if (task.status === 'importing') return '导入中';
  if (task.status === 'done') return '已完成';
  if (task.status === 'failed') return '失败';
  return '下载中';
};

const percent = (task: DownloadTask) => {
  if (task.status === 'done') return 100;
  if (task.total <= 0) return 0;
  return Math.min(99, Math.floor((task.received / task.total) * 100));
};

const showPercent = (task: DownloadTask) =>
  task.status === 'done' || task.total > 0;

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const sizeText = (task: DownloadTask) => {
  if (task.status === 'importing') return '正在加入本地小说';
  if (task.status === 'downloading') {
    return task.total > 0
      ? `${formatSize(task.received)} / ${formatSize(task.total)}`
      : `已下载 ${formatSize(task.received)}`;
  }
  return formatSize(task.total || task.received);
};

const formatTime = (time: number) => {
  const date = new Date(time);
  const now = new Date();
  const hh = `${date.getHours()}`.padStart(2, '0');
  const mm = `${date.getMinutes()}`.padStart(2, '0');
  if (date.toDateString() === now.toDateString()) {
    return `今天 ${hh}:${mm}`;
  }
  return `${date.getMonth() + 1}-${date.getDate()} ${hh}:${mm}`;
};
</script>

<template>
  <div class="download-entry">
    <XButton
      size="icon"
      color="neutral"
      variant="ghost"
      aria-label="下载管理"
      title="下载管理"
      @click="show = true"
    >
      <FileDownloadOutlined class="size-5" aria-hidden="true" />
    </XButton>
    <span v-if="activeCount > 0" class="download-badge">
      {{ activeCount }}
    </span>
  </div>

  <XDrawer
    v-model:open="show"
    title="下载管理"
    side="right"
    size="clamp(340px, 94vw, 480px)"
  >
    <div class="dl-shell">
      <header class="dl-header">
        <div class="dl-header-icon">
          <CloudDownloadOutlined class="size-5" aria-hidden="true" />
        </div>
        <div class="dl-header-text">
          <div class="dl-title">下载管理</div>
          <div class="dl-subtitle">{{ headerSubtitle }}</div>
        </div>
        <XButton
          v-if="finishedCount > 0"
          size="icon"
          color="neutral"
          variant="ghost"
          aria-label="清空已结束任务"
          title="清空已结束任务"
          @click="store.clearFinished()"
        >
          <DeleteSweepOutlined class="size-5" aria-hidden="true" />
        </XButton>
      </header>

      <div class="dl-scroll">
        <n-scrollbar trigger="none" style="height: 100%">
          <div v-if="tasks.length === 0" class="dl-empty">
            <div class="dl-empty-icon">
              <CloudDownloadOutlined class="size-8" aria-hidden="true" />
            </div>
            <div class="dl-empty-title">还没有下载任务</div>
            <div class="dl-empty-hint">
              在小说详情页或工作区点击下载，文件会显示在这里。
            </div>
          </div>

          <div v-else class="dl-list">
            <article
              v-for="task in tasks"
              :key="task.id"
              class="dl-card"
              :class="`is-${task.status}`"
            >
              <div class="dl-card-top">
                <div class="dl-file-badge">{{ fileKind(task.filename) }}</div>
                <div class="dl-file-main">
                  <div class="dl-file-name" :title="task.filename">
                    {{ task.filename }}
                  </div>
                  <div class="dl-file-meta">
                    <span class="dl-chip" :class="`is-${task.status}`">
                      {{ statusLabel(task) }}
                    </span>
                    <span class="dl-size">{{ sizeText(task) }}</span>
                    <span class="dl-dot">·</span>
                    <span>{{ formatTime(task.createAt) }}</span>
                  </div>
                </div>
              </div>

              <div class="dl-progress">
                <div class="dl-progress-track">
                  <n-progress
                    v-if="task.status === 'downloading'"
                    type="line"
                    :percentage="percent(task)"
                    :processing="task.total <= 0"
                    :show-indicator="false"
                    :height="8"
                    :border-radius="4"
                  />
                  <n-progress
                    v-else-if="task.status === 'importing'"
                    type="line"
                    :percentage="100"
                    processing
                    :show-indicator="false"
                    :height="8"
                    :border-radius="4"
                  />
                  <n-progress
                    v-else
                    type="line"
                    :percentage="task.status === 'done' ? 100 : percent(task)"
                    :status="task.status === 'failed' ? 'error' : 'success'"
                    :show-indicator="false"
                    :height="8"
                    :border-radius="4"
                  />
                </div>
                <span v-if="showPercent(task)" class="dl-percent">
                  {{ percent(task) }}%
                </span>
              </div>

              <div v-if="task.error" class="dl-error" :title="task.error">
                {{ task.error }}
              </div>

              <div
                v-if="task.savedPath"
                class="dl-path"
                :title="task.savedPath"
              >
                <FolderOpenOutlined class="dl-path-icon" aria-hidden="true" />
                <span>{{ task.savedPath }}</span>
              </div>
            </article>
          </div>
        </n-scrollbar>
      </div>

      <footer class="dl-footer">
        <button
          type="button"
          class="dl-dir"
          aria-label="修改下载目录"
          @click="goSetting"
        >
          <div class="dl-dir-icon">
            <FolderOutlined class="size-4" aria-hidden="true" />
          </div>
          <div class="dl-dir-info">
            <div class="dl-dir-label">
              保存位置
              <span class="dl-dir-edit">修改</span>
            </div>
            <div class="dl-dir-path" :title="downloadDir">
              {{ downloadDir || '默认下载目录' }}
            </div>
          </div>
          <SettingsOutlined class="dl-dir-arrow" aria-hidden="true" />
        </button>
      </footer>
    </div>
  </XDrawer>
</template>

<style scoped>
.download-entry {
  position: relative;
  display: inline-flex;
}
.download-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--color-primary, #18a058);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
  text-align: center;
  pointer-events: none;
  box-shadow: 0 0 0 2px var(--color-body, #fff);
}

.dl-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding-top: var(--novelia-inset-top, 0px);
  padding-bottom: var(--novelia-inset-bottom, 0px);
  background: var(--color-modal);
  color: var(--color-ink);
}

.dl-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--color-divider);
}
.dl-header-icon {
  display: grid;
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 12px;
  background: var(--color-primary-soft);
  color: var(--color-primary-text);
}
.dl-header-text {
  flex: 1;
  min-width: 0;
}
.dl-title {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.25;
}
.dl-subtitle {
  margin-top: 3px;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.2;
}

.dl-scroll {
  flex: 1;
  min-height: 0;
}

.dl-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.dl-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--color-divider);
  border-radius: 14px;
  background: var(--color-embedded);
}
.dl-card-top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.dl-file-badge {
  display: grid;
  flex: 0 0 auto;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 12px;
  background: var(--color-primary-soft);
  color: var(--color-primary-text);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.03em;
}
.dl-file-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.dl-file-name {
  display: -webkit-box;
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.35;
  word-break: break-all;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.dl-file-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--color-muted);
  font-size: 11.5px;
}
.dl-chip {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.6;
}
.dl-chip.is-downloading {
  background: var(--color-primary-soft);
  color: var(--color-primary-text);
}
.dl-chip.is-importing {
  background: var(--color-warning-soft);
  color: var(--color-warning-text);
}
.dl-chip.is-done {
  background: var(--color-success-soft);
  color: var(--color-success-text);
}
.dl-chip.is-failed {
  background: var(--color-error-soft);
  color: var(--color-error-text);
}
.dl-size {
  font-variant-numeric: tabular-nums;
}
.dl-dot {
  opacity: 0.45;
}

.dl-progress {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dl-progress-track {
  flex: 1;
  min-width: 0;
}
.dl-percent {
  flex: 0 0 auto;
  min-width: 34px;
  color: var(--color-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.dl-error {
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-error-text);
  font-size: 11.5px;
  line-height: 1.4;
  word-break: break-all;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.dl-path {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--color-muted);
  font-size: 11px;
  line-height: 1.4;
}
.dl-path-icon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin-top: 1px;
  opacity: 0.7;
}
.dl-path span {
  display: -webkit-box;
  overflow: hidden;
  word-break: break-all;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.dl-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 72px 32px 32px;
  text-align: center;
}
.dl-empty-icon {
  display: grid;
  width: 64px;
  height: 64px;
  margin-bottom: 16px;
  place-items: center;
  border-radius: 20px;
  background: var(--color-primary-soft);
  color: var(--color-primary-text);
}
.dl-empty-title {
  font-size: 14px;
  font-weight: 600;
}
.dl-empty-hint {
  margin-top: 6px;
  max-width: 240px;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.6;
}

.dl-footer {
  flex: 0 0 auto;
  padding: 12px 16px;
  border-top: 1px solid var(--color-divider);
}
.dl-dir {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--color-divider);
  border-radius: 12px;
  background: var(--color-surface);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}
.dl-dir:hover {
  border-color: var(--color-primary);
  background: var(--color-embedded);
}
.dl-dir-icon {
  display: grid;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 9px;
  background: var(--color-primary-soft);
  color: var(--color-primary-text);
}
.dl-dir-info {
  flex: 1;
  min-width: 0;
}
.dl-dir-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}
.dl-dir-edit {
  color: var(--color-primary-text);
  font-size: 10.5px;
  font-weight: 500;
}
.dl-dir-path {
  display: -webkit-box;
  overflow: hidden;
  margin-top: 2px;
  color: var(--color-muted);
  font-size: 11px;
  line-height: 1.4;
  word-break: break-all;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.dl-dir-arrow {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  color: var(--color-muted);
}
</style>

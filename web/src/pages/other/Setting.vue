<script lang="ts" setup>
import { invoke } from '@tauri-apps/api/core';
import { Toast, useWebKit, XPage, XPageHeader } from '@novelia/web-kit';
import SoundAllTaskCompleted from '@/sound/all_task_completed.mp3';
import { noveliaRuntime } from '@/runtime';
import {
  Setting,
  useSettingStore,
  useWebSearchHistoryStore,
  useWenkuSearchHistoryStore,
} from '@/stores';
import { InfoOutlined } from '@vicons/material';

type NetworkMode = 'ech' | 'system' | 'direct' | 'manual';

interface NetworkConfig {
  mode: NetworkMode;
  proxy: string;
}

const settingStore = useSettingStore();
const { setting } = storeToRefs(settingStore);

const isClient =
  noveliaRuntime !== undefined ||
  '__TAURI_INTERNALS__' in (globalThis as Record<string, unknown>);
const echAvailable = noveliaRuntime?.echAvailable ?? __ECH_AVAILABLE__;
const networkMode = ref<NetworkMode>('system');
const proxyUrl = ref('');
const networkMessage = ref('');
const savingNetwork = ref(false);
const testingNetwork = ref(false);
const networkModeOptions = computed(() => {
  const options = [
    { label: 'ECH 直连（推荐）', value: 'ech', echOnly: true },
    { label: '系统代理', value: 'system', echOnly: false },
    { label: '直连', value: 'direct', echOnly: false },
    { label: '手动代理', value: 'manual', echOnly: false },
  ];
  return options
    .filter((option) => !option.echOnly || echAvailable)
    .map(({ label, value }) => ({ label, value }));
});

const loadNetworkConfig = async () => {
  if (!isClient) return;
  try {
    const config = await invoke<NetworkConfig>('get_network_config');
    networkMode.value = config.mode;
    proxyUrl.value = config.proxy;
  } catch (error) {
    networkMessage.value = `读取网络设置失败：${error}`;
  }
};

const saveNetworkConfig = async () => {
  savingNetwork.value = true;
  networkMessage.value = '';
  try {
    await invoke('set_network_config', {
      config: { mode: networkMode.value, proxy: proxyUrl.value },
    });
    networkMessage.value = '已保存并立即生效';
  } catch (error) {
    networkMessage.value = `保存失败：${error}`;
  } finally {
    savingNetwork.value = false;
  }
};

const testNetwork = async () => {
  testingNetwork.value = true;
  networkMessage.value = '';
  try {
    networkMessage.value = await invoke<string>('test_network', {
      config: { mode: networkMode.value, proxy: proxyUrl.value },
    });
  } catch (error) {
    networkMessage.value = `测试失败：${error}`;
  } finally {
    testingNetwork.value = false;
  }
};

onMounted(loadNetworkConfig);

const clearWebSearchHistory = () => {
  useWebSearchHistoryStore().clear();
  Toast.success('清空成功');
};

const clearWenkuSearchHistory = () => {
  useWenkuSearchHistoryStore().clear();
  Toast.success('清空成功');
};

const playSound = (source: string) => {
  return new Audio(source).play();
};
const { theme } = useWebKit();
</script>

<template>
  <XPage>
    <XPageHeader title="设置" />

    <n-list bordered>
      <n-list-item>
        <n-flex vertical>
          <b>主题</b>
          <c-radio-group
            :value="theme.preference.value"
            @update:value="theme.setPreference($event)"
            :options="Setting.themeOptions"
            size="small"
          />
        </n-flex>
      </n-list-item>

      <n-list-item v-if="isClient">
        <n-flex vertical>
          <b>客户端网络</b>
          <span class="text-xs opacity-60">
            {{
              echAvailable
                ? '仅客户端生效。ECH 直连使用 DoH + 加密 SNI，无需外部代理；系统代理和手动 HTTP/SOCKS5 代理作为备用线路。'
                : '移动端当前使用直连、系统代理或 VPN；ECH 直连将在后续版本接入。'
            }}
          </span>
          <c-radio-group
            v-model:value="networkMode"
            :options="networkModeOptions"
            size="small"
            class="radio-wrap"
          />
          <span v-if="networkMode === 'ech'" class="text-xs opacity-60">
            ECH 模式由本地侧车完成握手，失败时请切换系统代理或手动代理。
          </span>
          <n-input
            v-if="networkMode === 'manual'"
            v-model:value="proxyUrl"
            size="small"
            placeholder="http://127.0.0.1:7897 或 socks5://127.0.0.1:1080"
            style="max-width: 420px"
          />
          <n-flex align="center">
            <n-button size="small" :loading="savingNetwork" @click="saveNetworkConfig">
              保存
            </n-button>
            <n-button size="small" :loading="testingNetwork" @click="testNetwork">
              测试连接
            </n-button>
          </n-flex>
          <span v-if="networkMessage" class="text-xs">{{ networkMessage }}</span>
        </n-flex>
      </n-list-item>

      <n-list-item>
        <n-flex vertical>
          <b>快捷键说明</b>
          <n-ul>
            <n-li>列表页面，可以使用左右方向键翻页。</n-li>
            <n-li>
              GPT/Sakura排队按钮，按住 Ctrl（macOS 为
              Cmd）键点击，会将任务自动置顶。
            </n-li>
            <n-li>
              小说/文库页面，可以用数字键切换底部分页，也可在分页区域内单指左右滑动切换。
            </n-li>
            <n-li>阅读页面，可以使用左右方向键跳转上/下一章。</n-li>
            <n-li>阅读页面，可以使用数字键1～3快速切换翻译。</n-li>
          </n-ul>
        </n-flex>
      </n-list-item>

      <n-list-item>
        <n-flex vertical>
          <b>网络小说目录</b>
          <n-checkbox v-model:checked="setting.tocCollapseInNarrowScreen">
            目录折叠在侧边栏 (移动端)
          </n-checkbox>
          <n-checkbox v-model:checked="setting.tocExpandAll">
            目录默认展开所有章节
            <n-tooltip trigger="hover" placement="top" style="max-width: 400px">
              <template #trigger>
                <n-button text @click.stop>
                  <n-icon depth="4" :component="InfoOutlined" size="12" />
                </n-button>
              </template>
              开启：默认展开所有章节（可能导致性能问题）
              <br />
              关闭：只展开上次阅读的章节（如无记录则展开第一个章节）
              <br />
              不影响无分章的网络小说
            </n-tooltip>
          </n-checkbox>
          <b>评论</b>
          <n-checkbox v-model:checked="setting.hideCommmentWebNovel">
            隐藏网络小说评论
          </n-checkbox>
          <n-checkbox v-model:checked="setting.hideCommmentWenkuNovel">
            隐藏文库小说评论
          </n-checkbox>
          <b>收藏夹</b>
          <n-checkbox v-model:checked="setting.showTagInWebFavored">
            显示收藏夹里网络小说的标签
          </n-checkbox>
          <n-checkbox v-model:checked="setting.favoriteCreateTimeFirst">
            收藏时间排序优先
          </n-checkbox>
        </n-flex>
      </n-list-item>

      <n-list-item>
        <n-flex vertical>
          <b>工作区</b>
          <n-checkbox v-model:checked="setting.autoTopJobWhenAddTask">
            工作区添加时自动置顶
          </n-checkbox>
        </n-flex>
      </n-list-item>

      <n-list-item>
        <n-flex vertical>
          <b>列表分页方式</b>
          <c-radio-group
            v-model:value="setting.paginationMode"
            :options="Setting.paginationModeOptions"
            size="small"
          />
        </n-flex>
      </n-list-item>

      <n-list-item>
        <n-flex vertical>
          <b>显示的翻译按钮</b>
          <translator-check
            v-model:value="setting.enabledTranslator"
            size="small"
          />
        </n-flex>
      </n-list-item>

      <n-list-item>
        <n-flex vertical>
          <b>工作区语音提醒</b>
          <n-flex :wrap="false" :size="0">
            <n-checkbox v-model:checked="setting.workspaceSound">
              任务全部完成
            </n-checkbox>

            [
            <c-button
              label="点击播放"
              text
              type="primary"
              @action="playSound(SoundAllTaskCompleted)"
            />
            ]
          </n-flex>
        </n-flex>
      </n-list-item>

      <n-list-item>
        <n-flex vertical align="start">
          <b>清空搜索历史</b>
          <n-flex>
            <c-button
              label="清空网络搜索历史"
              size="small"
              @action="clearWebSearchHistory"
            />
            <c-button
              label="清空文库搜索历史"
              size="small"
              @action="clearWenkuSearchHistory"
            />
          </n-flex>
        </n-flex>
      </n-list-item>

      <n-list-item>
        <n-flex vertical>
          <b>语言</b>
          简繁转换目前只覆盖web章节内容。
          <c-radio-group
            v-model:value="setting.locale"
            :options="Setting.localeOptions"
            size="small"
          />
          <n-checkbox v-model:checked="setting.searchLocaleAware">
            支持繁体搜索（不稳定）
          </n-checkbox>
        </n-flex>
      </n-list-item>
    </n-list>
  </XPage>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { defaultSettings, limits, parseSettings, serializeSettings, validateSettings, type Settings } from '../domain/settings';

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ apply: [settings: Settings] }>();
const dialog = ref<HTMLDialogElement>();
const fileInput = ref<HTMLInputElement>();
const draft = ref(defaultSettings());
const message = ref('');
const failed = ref(false);

function open() {
  draft.value = validateSettings(props.settings);
  message.value = '';
  failed.value = false;
  dialog.value?.showModal();
}

function report(cause: unknown) {
  message.value = cause instanceof Error ? cause.message : String(cause);
  failed.value = true;
}

function apply() {
  try {
    emit('apply', validateSettings(draft.value));
    dialog.value?.close();
  } catch (cause) {
    report(cause);
  }
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    if (file.size > 32768) throw new Error('配置文件不能超过 32 KB');
    draft.value = parseSettings(await file.text());
    message.value = '配置已载入草稿，点击“应用设置”生效。';
    failed.value = false;
  } catch (cause) {
    report(cause);
  }
}

function exportFile() {
  try {
    const blob = new Blob([serializeSettings(draft.value)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    // WebKitGTK does not rename a download when its destination already exists.
    link.download = `ssh-terminal-settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    message.value = '已发起配置下载，请检查下载目录；文件不包含连接地址、密码或主机验证开关。';
    failed.value = false;
  } catch (cause) {
    report(cause);
  }
}

function reset() {
  draft.value = defaultSettings();
  message.value = '草稿已恢复默认，点击“应用设置”生效。';
  failed.value = false;
}

defineExpose({ open });
</script>

<template>
  <dialog ref="dialog" class="settings-dialog" aria-labelledby="settings-title" aria-describedby="settings-description">
    <form class="settings-form" @submit.prevent="apply">
      <div class="dialog-header">
        <div><p class="eyebrow">MAKE IT YOURS</p><h2 id="settings-title">工作区设置</h2></div>
        <button type="button" class="icon-button" aria-label="关闭设置" @click="dialog?.close()">×</button>
      </div>
      <div class="settings-content">
        <p id="settings-description" class="muted">外观与终端设置在应用后生效，SSH 参数用于下次连接。设置保存在当前设备。</p>
        <section class="settings-section" aria-labelledby="appearance-title">
          <div class="section-heading"><span class="section-number" aria-hidden="true">01</span><h3 id="appearance-title">外观与布局</h3></div>
          <div class="settings-grid">
            <div><label for="theme">界面主题</label><select id="theme" v-model="draft.appearance.theme"><option value="dark">深色</option><option value="light">浅色</option><option value="system">跟随系统</option></select></div>
            <div><label for="accent">强调色</label><select id="accent" v-model="draft.appearance.accent"><option value="mint">薄荷绿</option><option value="blue">晴空蓝</option><option value="violet">鸢尾紫</option></select></div>
            <div><label for="density">界面密度</label><select id="density" v-model="draft.appearance.density"><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></div>
            <div><label for="sidebar-width">连接面板宽度（px）</label><input id="sidebar-width" v-model.number="draft.appearance.sidebarWidth" required type="number" v-bind="limits.sidebarWidth" /></div>
          </div>
        </section>

        <section class="settings-section" aria-labelledby="terminal-settings-title">
          <div class="section-heading"><span class="section-number" aria-hidden="true">02</span><h3 id="terminal-settings-title">终端体验</h3></div>
          <label for="font-family">字体族</label>
          <input id="font-family" v-model.trim="draft.terminal.fontFamily" required maxlength="200" spellcheck="false" aria-describedby="font-help" />
          <p id="font-help" class="field-help">使用本机已安装的等宽字体，可用逗号指定回退字体。</p>
          <div class="settings-grid">
            <div><label for="font-size">字号（px）</label><input id="font-size" v-model.number="draft.terminal.fontSize" required type="number" v-bind="limits.fontSize" /></div>
            <div><label for="line-height">行高</label><input id="line-height" v-model.number="draft.terminal.lineHeight" required type="number" v-bind="limits.lineHeight" /></div>
            <div><label for="scrollback">回滚行数</label><input id="scrollback" v-model.number="draft.terminal.scrollback" required type="number" v-bind="limits.scrollback" aria-describedby="scrollback-help" /></div>
            <div><label for="cursor-style">光标样式</label><select id="cursor-style" v-model="draft.terminal.cursorStyle"><option value="block">方块</option><option value="bar">竖线</option><option value="underline">下划线</option></select></div>
          </div>
          <p id="scrollback-help" class="field-help">0 表示不保留回滚。减小行数会丢弃超出上限的历史输出。</p>
          <div class="settings-grid">
            <label class="checkbox"><input v-model="draft.terminal.cursorBlink" type="checkbox" />光标闪烁</label>
            <label class="checkbox"><input v-model="draft.terminal.screenReaderMode" type="checkbox" />屏幕阅读器支持</label>
          </div>
          <label for="palette">终端配色</label>
          <select id="palette" v-model="draft.terminal.palette"><option value="midnight">午夜 · 深色</option><option value="paper">纸张 · 浅色</option><option value="custom">自定义</option></select>
          <p class="field-help">浅色背景会使用加深的 16 色 ANSI 调色板，保证提示符、目录与 diff 等彩色输出可读。</p>
          <div v-if="draft.terminal.palette === 'custom'" class="color-grid">
            <div><label for="terminal-background">终端背景色</label><input id="terminal-background" v-model="draft.terminal.background" type="color" /></div>
            <div><label for="terminal-foreground">终端文字色</label><input id="terminal-foreground" v-model="draft.terminal.foreground" type="color" /></div>
            <div><label for="terminal-cursor">终端光标色</label><input id="terminal-cursor" v-model="draft.terminal.cursor" type="color" /></div>
          </div>
        </section>

        <section class="settings-section" aria-labelledby="ssh-settings-title">
          <div class="section-heading"><span class="section-number" aria-hidden="true">03</span><h3 id="ssh-settings-title">SSH 参数</h3></div>
          <p class="field-help">只影响新连接；不改变当前会话的协议参数。</p>
          <div class="settings-grid">
            <div><label for="term">终端类型（TERM）</label><input id="term" v-model.trim="draft.ssh.term" required maxlength="64" pattern="[a-zA-Z0-9][a-zA-Z0-9._+\-]{0,63}" list="term-presets" spellcheck="false" /><datalist id="term-presets"><option value="xterm-256color" /><option value="xterm" /><option value="vt100" /></datalist></div>
            <div><label for="connect-timeout">连接超时（秒）</label><input id="connect-timeout" v-model.number="draft.ssh.connectTimeoutSecs" required type="number" v-bind="limits.connectTimeoutSecs" /></div>
            <div><label for="keepalive-interval">保活间隔（秒）</label><input id="keepalive-interval" v-model.number="draft.ssh.keepaliveIntervalSecs" required type="number" v-bind="limits.keepaliveIntervalSecs" /></div>
            <div><label for="keepalive-max">保活最大未响应次数</label><input id="keepalive-max" v-model.number="draft.ssh.keepaliveMax" required type="number" v-bind="limits.keepaliveMax" /></div>
            <div><label for="inactivity-timeout">无数据超时（秒）</label><input id="inactivity-timeout" v-model.number="draft.ssh.inactivityTimeoutSecs" required type="number" v-bind="limits.inactivityTimeoutSecs" /></div>
          </div>
          <p class="field-help">保活间隔和无数据超时设为 0 可分别禁用。无数据超时计算协议活动，包括保活回复；过小可能导致正常会话断开。</p>
        </section>

        <section class="settings-section" aria-labelledby="config-title">
          <div class="section-heading"><span class="section-number" aria-hidden="true">04</span><h3 id="config-title">配置管理</h3></div>
          <p class="field-help">JSON 格式，最多 32 KB。仅包含上述设置，不保存连接地址、用户名、密码或指纹验证开关。</p>
          <div class="config-actions">
            <button type="button" class="secondary" @click="fileInput?.click()">导入配置</button>
            <button type="button" class="secondary" @click="exportFile">导出配置</button>
            <button type="button" class="text-button" @click="reset">恢复默认</button>
          </div>
          <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="importFile" />
        </section>
      </div>
      <div class="dialog-footer">
        <p v-if="message" class="settings-message" :class="{ 'warning-text': failed }" :role="failed ? 'alert' : undefined" aria-live="polite">{{ message }}</p>
        <div class="dialog-actions"><button type="button" class="secondary" @click="dialog?.close()">取消</button><button type="submit" class="primary">应用设置</button></div>
      </div>
    </form>
  </dialog>
</template>

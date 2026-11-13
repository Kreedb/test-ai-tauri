<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watchEffect } from 'vue';
import ConnectionForm from './components/ConnectionForm.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import TerminalPane from './components/TerminalPane.vue';
import { createTerminalSession } from './application/terminalSession';
import { useSettings } from './application/settings';
import { terminalTransport } from './platform';
import { terminalColors } from './domain/settings';
import type { ConnectionRequest, TerminalSize } from './domain/terminal';

const { settings, storageError, applySettings } = useSettings();
const settingsPanel = ref<InstanceType<typeof SettingsPanel>>();
const terminal = ref<InstanceType<typeof TerminalPane>>();
const terminalKey = ref(0);
const connectPending = ref(false);
const sidebarVisible = ref(true);
const dimensions = ref<TerminalSize>({ cols: 80, rows: 24 });
const target = ref('');
const activeTerm = ref('');
const session = createTerminalSession(terminalTransport, (data) => terminal.value?.write(data));
const { phase, error } = session;
const status = computed(() => ({
  idle: '未连接',
  connecting: '正在连接…',
  connected: '已连接',
  disconnecting: '正在断开…',
})[phase.value]);
const colors = computed(() => terminalColors(settings.value.terminal));
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const systemDark = ref(systemTheme.matches);
const updateSystemTheme = (event: MediaQueryListEvent) => { systemDark.value = event.matches; };
systemTheme.addEventListener('change', updateSystemTheme);
watchEffect(() => {
  const { theme, accent, density } = settings.value.appearance;
  document.documentElement.dataset.theme = theme === 'system' ? (systemDark.value ? 'dark' : 'light') : theme;
  document.documentElement.dataset.accent = accent;
  document.documentElement.dataset.density = density;
});

async function connect(request: ConnectionRequest) {
  if (connectPending.value || session.phase.value !== 'idle' || !terminalTransport.available) return;
  connectPending.value = true;
  const options = { ...settings.value.ssh };
  try {
    terminalKey.value++;
    await nextTick();
    const pane = terminal.value;
    if (!pane) return;
    target.value = `${request.username}@${request.host}:${request.port}`;
    activeTerm.value = options.term;
    await session.connect({ ...request, options }, pane.size());
    if (phase.value === 'connected') {
      await session.resize(pane.size());
      pane.focus();
    }
  } finally {
    connectPending.value = false;
  }
}

function resize(size: TerminalSize) {
  dimensions.value = size;
  void session.resize(size);
}

onBeforeUnmount(() => {
  systemTheme.removeEventListener('change', updateSystemTheme);
  void session.disconnect();
});
</script>

<template>
  <main :style="{ '--sidebar-width': `${settings.appearance.sidebarWidth}px` }">
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">&gt;_</span>
        <div><p class="eyebrow">TAURI · VUE · RUST</p><h1>SSH Terminal</h1></div>
      </div>
      <div class="header-actions">
        <span class="badge">{{ terminalTransport.available ? '桌面版' : 'Web 预览' }}</span>
        <button type="button" class="secondary settings-trigger" @click="settingsPanel?.open()">工作区设置 <span aria-hidden="true">⚙</span></button>
      </div>
    </header>

    <div class="workspace-heading"><div><h2>你的远程工作区</h2><p class="muted">专注连接，自在定制。</p></div><span class="workspace-meta">SSH / UTF-8</span></div>
    <p v-if="!terminalTransport.available" class="notice" role="note">当前为静态 Web 预览，可体验工作区设置。浏览器不支持直连 SSH，请使用 Linux 或 Windows 桌面版。</p>
    <p v-if="storageError" class="error" role="alert">{{ storageError }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <section class="workspace" :class="{ 'terminal-only': !sidebarVisible }" aria-label="SSH 工作区">
      <ConnectionForm v-show="sidebarVisible" :available="terminalTransport.available" :busy="phase !== 'idle' || connectPending" :connected="phase === 'connected'" @connect="connect" @disconnect="session.disconnect" />

      <section class="terminal-panel panel" aria-labelledby="terminal-title" :style="{ '--terminal-background': colors.background }">
        <div class="terminal-toolbar">
          <div class="terminal-heading"><span class="terminal-symbol" aria-hidden="true">&gt;_</span><div><h2 id="terminal-title">远程终端</h2><p class="terminal-target">{{ phase === 'idle' ? '等待建立安全连接' : target }}</p></div></div>
          <span role="status" class="session-status" :class="{ connected: phase === 'connected' }"><span class="status-dot" aria-hidden="true" />{{ status }}</span>
        </div>
        <div class="terminal-actions">
          <button type="button" class="text-button" :aria-expanded="sidebarVisible" aria-controls="connection-panel" @click="sidebarVisible = !sidebarVisible">{{ sidebarVisible ? '隐藏连接面板' : '显示连接面板' }}</button>
          <div><button type="button" class="text-button" @click="terminal?.focus()">聚焦终端</button><button type="button" class="text-button" title="清除本地显示与回滚，不向服务器发送命令" @click="terminal?.clear()">清屏</button></div>
        </div>
        <TerminalPane :key="terminalKey" ref="terminal" :show-welcome="terminalKey === 0" :settings="settings.terminal" @input="session.write" @resize="resize" />
        <div class="terminal-statusbar"><span>{{ phase === 'idle' ? settings.ssh.term : activeTerm }} · UTF-8</span><span>{{ dimensions.cols }} × {{ dimensions.rows }}</span></div>
      </section>
    </section>
    <footer><span>Tauri SSH Terminal <span class="footer-divider">/</span> 为下一次构建准备</span><span>单会话 · 自动适配终端尺寸</span></footer>
    <SettingsPanel ref="settingsPanel" :settings="settings" @apply="applySettings" />
  </main>
</template>

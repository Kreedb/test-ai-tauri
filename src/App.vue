<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import TerminalPane from './components/TerminalPane.vue';
import { createTerminalSession } from './application/terminalSession';
import { terminalTransport } from './platform';
import type { ConnectionRequest } from './domain/terminal';

const terminal = ref<InstanceType<typeof TerminalPane>>();
const form = reactive<ConnectionRequest>({
  host: '',
  port: 22,
  username: '',
  password: '',
  hostKeySha256: '',
  ignoreHostKey: false,
});
const session = createTerminalSession(terminalTransport, (data) => terminal.value?.write(data));
const { phase, error } = session;
const status = computed(() => ({
  idle: '未连接',
  connecting: '正在连接…',
  connected: '已连接',
  disconnecting: '正在断开…',
})[phase.value]);

async function connect() {
  const pane = terminal.value;
  if (!pane) return;
  await pane.reset();
  const connecting = session.connect({ ...form }, pane.size());
  form.password = '';
  await connecting;
  if (phase.value === 'connected') {
    await session.resize(pane.size());
    pane.focus();
  }
}

onBeforeUnmount(() => { void session.disconnect(); });
</script>

<template>
  <main>
    <header>
      <div>
        <p class="eyebrow">TAURI · VUE · RUST</p>
        <h1>SSH Terminal</h1>
      </div>
      <span class="badge">{{ terminalTransport.available ? '桌面版' : 'Web 预览' }}</span>
    </header>

    <p v-if="!terminalTransport.available" class="notice" role="note">
      当前是 GitHub Pages 可部署的静态预览。浏览器不支持直连 SSH，请下载 Linux 或 Windows 桌面版。
    </p>

    <section class="workspace" aria-label="SSH 工作区">
      <form class="connection" @submit.prevent="connect">
        <h2>新建连接</h2>
        <p class="muted">密码仅用于本次认证，不保存连接凭据。</p>
        <fieldset :disabled="!terminalTransport.available || phase !== 'idle'">
          <label for="host">主机</label>
          <input id="host" v-model.trim="form.host" required maxlength="253" placeholder="192.168.1.10" autocomplete="off" />

          <label for="port">端口</label>
          <input id="port" v-model.number="form.port" required type="number" min="1" max="65535" step="1" />

          <label for="username">用户名</label>
          <input id="username" v-model.trim="form.username" required maxlength="256" placeholder="user" autocomplete="off" />

          <label for="password">密码</label>
          <input id="password" v-model="form.password" required type="password" maxlength="16384" autocomplete="off" />

          <label for="fingerprint">主机指纹（SHA256）</label>
          <input id="fingerprint" v-model.trim="form.hostKeySha256" :required="!form.ignoreHostKey" :disabled="form.ignoreHostKey" pattern="SHA256:[A-Za-z0-9+\/]{43}" placeholder="SHA256:…" autocomplete="off" aria-describedby="fingerprint-help" />
          <p id="fingerprint-help" class="muted">通过可信渠道向服务器管理员获取；指纹不匹配时会在发送密码前拒绝连接。</p>
          <label for="ignore-host-key" class="checkbox">
            <input id="ignore-host-key" v-model="form.ignoreHostKey" type="checkbox" aria-describedby="host-key-warning" />
            忽略主机指纹（不安全）
          </label>
          <p id="host-key-warning" class="muted">忽略后无法确认服务器身份，可能遭中间人攻击并泄露密码；仅在可信网络临时使用。</p>
          <button type="submit">连接 SSH</button>
        </fieldset>
        <button v-if="phase === 'connected'" type="button" class="secondary" @click="session.disconnect">断开连接</button>
      </form>

      <section class="terminal-panel" aria-labelledby="terminal-title">
        <div class="terminal-toolbar">
          <h2 id="terminal-title">远程终端</h2>
          <span role="status" :class="{ connected: phase === 'connected' }">{{ status }}</span>
        </div>
        <TerminalPane ref="terminal" @input="session.write" @resize="session.resize" />
      </section>
    </section>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <footer>单会话 · 密码认证 · xterm-256color PTY · 自动适配终端尺寸</footer>
  </main>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import type { ConnectionRequest } from '../domain/terminal';

const props = defineProps<{ available: boolean; busy: boolean; connected: boolean }>();
const emit = defineEmits<{ connect: [request: ConnectionRequest]; disconnect: [] }>();
const form = reactive<ConnectionRequest>({
  host: '', port: 22, username: '', password: '', hostKeySha256: '', ignoreHostKey: false,
});

function submit() {
  if (!props.available || props.busy) return;
  const request = { ...form };
  form.password = '';
  emit('connect', request);
}
</script>

<template>
  <form id="connection-panel" class="connection panel" @submit.prevent="submit">
    <div class="section-heading">
      <span class="section-number" aria-hidden="true">01</span>
      <div><h2>连接配置</h2><p class="muted">建立你的远程工作区</p></div>
    </div>
    <fieldset :disabled="!available || busy">
      <div class="host-port">
        <div>
          <label for="host">主机</label>
          <input id="host" v-model.trim="form.host" required maxlength="253" placeholder="192.168.1.10" autocomplete="off" spellcheck="false" />
        </div>
        <div>
          <label for="port">端口</label>
          <input id="port" v-model.number="form.port" required type="number" min="1" max="65535" step="1" />
        </div>
      </div>
      <label for="username">用户名</label>
      <input id="username" v-model.trim="form.username" required maxlength="256" placeholder="user" autocomplete="off" spellcheck="false" />

      <label for="password">密码</label>
      <input id="password" v-model="form.password" required type="password" maxlength="16384" autocomplete="off" aria-describedby="password-help" />
      <p id="password-help" class="field-help">仅用于本次认证，提交后清空，不保存到本地。</p>

      <div class="trust-section">
        <label for="fingerprint">主机指纹（SHA256）</label>
        <input id="fingerprint" v-model.trim="form.hostKeySha256" :required="!form.ignoreHostKey" :disabled="form.ignoreHostKey" pattern="SHA256:[A-Za-z0-9+\/]{43}" placeholder="SHA256:…" autocomplete="off" spellcheck="false" aria-describedby="fingerprint-help" />
        <p id="fingerprint-help" class="field-help">从可信渠道获取。指纹不匹配时，在发送密码前拒绝连接。</p>
        <label for="ignore-host-key" class="checkbox">
          <input id="ignore-host-key" v-model="form.ignoreHostKey" type="checkbox" :aria-describedby="form.ignoreHostKey ? 'host-key-warning' : undefined" />
          忽略主机指纹（不安全）
        </label>
        <p v-if="form.ignoreHostKey" id="host-key-warning" class="warning-text">无法确认服务器身份，可能遭中间人攻击并泄露密码；仅在可信网络临时使用。</p>
      </div>
      <button class="primary connect-button" type="submit">连接 SSH <span aria-hidden="true">↗</span></button>
    </fieldset>
    <button v-if="connected" type="button" class="secondary disconnect-button" @click="emit('disconnect')">断开连接</button>
    <p v-if="!available" class="field-help">连接功能在桌面版中可用。</p>
    <div class="connection-note"><span aria-hidden="true">◇</span> 单会话 · 密码认证 · 端到端 SSH</div>
  </form>
</template>

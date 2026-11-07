<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalSize } from '../domain/terminal';
import '@xterm/xterm/css/xterm.css';

const emit = defineEmits<{
  input: [data: Uint8Array];
  resize: [size: TerminalSize];
}>();
const container = ref<HTMLDivElement>();
const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  screenReaderMode: true,
  theme: { background: '#10151e', foreground: '#dce4ef', cursor: '#7dd3c0' },
});
const fit = new FitAddon();
let observer: ResizeObserver | undefined;

onMounted(() => {
  if (!container.value) return;
  terminal.loadAddon(fit);
  terminal.open(container.value);
  terminal.writeln('Tauri SSH Terminal');
  terminal.writeln('在桌面版中填写连接信息并核验主机指纹，即可打开远程 shell。');
  terminal.onData((data) => emit('input', new TextEncoder().encode(data)));
  terminal.onBinary((data) => emit('input', Uint8Array.from(data, (char) => char.charCodeAt(0))));
  terminal.onResize((size) => emit('resize', size));
  observer = new ResizeObserver(() => fit.fit());
  observer.observe(container.value);
  fit.fit();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  terminal.dispose();
});

defineExpose({
  write: (data: Uint8Array) => new Promise<void>((resolve) => terminal.write(data, resolve)),
  // CAN cancels an unfinished escape string, then RIS resets parser and screen.
  reset: () => new Promise<void>((resolve) => terminal.write(Uint8Array.of(0x18, 0x1b, 0x63), resolve)),
  focus: () => terminal.focus(),
  size: (): TerminalSize => ({ cols: terminal.cols, rows: terminal.rows }),
});
</script>

<template>
  <div ref="container" class="terminal" role="region" aria-label="SSH 终端输出与输入" />
</template>

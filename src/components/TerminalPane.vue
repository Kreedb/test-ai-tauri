<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalSize } from '../domain/terminal';
import { terminalColors, type TerminalSettings } from '../domain/settings';
import '@xterm/xterm/css/xterm.css';

const props = defineProps<{ showWelcome: boolean; settings: TerminalSettings }>();
const emit = defineEmits<{
  input: [data: Uint8Array];
  resize: [size: TerminalSize];
}>();
const container = ref<HTMLDivElement>();
function options() {
  const { fontFamily, fontSize, lineHeight, scrollback, cursorStyle, cursorBlink, screenReaderMode } = props.settings;
  return { fontFamily, fontSize, lineHeight, scrollback, cursorStyle, cursorBlink, screenReaderMode, theme: terminalColors(props.settings) };
}
const terminal = new Terminal(options());
const fit = new FitAddon();
let observer: ResizeObserver | undefined;

watch(() => props.settings, () => {
  terminal.options = options();
  fit.fit();
}, { flush: 'post' });

onMounted(() => {
  if (!container.value) return;
  terminal.loadAddon(fit);
  terminal.open(container.value);
  if (props.showWelcome) {
    terminal.writeln('Tauri SSH Terminal');
    terminal.writeln('在桌面版中填写连接信息并核验主机指纹，即可打开远程 shell。');
  }
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
  focus: () => terminal.focus(),
  clear: () => terminal.clear(),
  size: (): TerminalSize => ({ cols: terminal.cols, rows: terminal.rows }),
});
</script>

<template>
  <div ref="container" class="terminal" role="region" aria-label="SSH 终端输出与输入" />
</template>

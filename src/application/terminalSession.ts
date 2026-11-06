import { readonly, ref } from 'vue';
import type {
  ConnectionRequest,
  TerminalConnection,
  TerminalSize,
  TerminalTransport,
} from '../domain/terminal';

export function createTerminalSession(
  transport: TerminalTransport,
  onData: (data: Uint8Array) => void | Promise<void>,
) {
  const phase = ref<'idle' | 'connecting' | 'connected' | 'disconnecting'>('idle');
  const error = ref('');
  let connection: TerminalConnection | undefined;
  let generation = 0;
  let inputQueue = Promise.resolve();

  function showError(cause: unknown) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }

  async function connect(request: ConnectionRequest, size: TerminalSize) {
    if (phase.value !== 'idle') return;
    const attempt = ++generation;
    let closed = false;
    error.value = '';
    phase.value = 'connecting';

    try {
      const active = await transport.connect(request, size, async (event) => {
        if (attempt !== generation) return;
        if (event.type === 'data') {
          await onData(Uint8Array.from(event.data));
        } else {
          closed = true;
          connection = undefined;
          phase.value = 'idle';
          if (event.error) error.value = event.error;
        }
      });
      if (attempt !== generation || closed) {
        await active.disconnect();
        return;
      }
      connection = active;
      inputQueue = Promise.resolve();
      phase.value = 'connected';
    } catch (cause) {
      if (attempt === generation) {
        phase.value = 'idle';
        showError(cause);
      }
    }
  }

  async function disconnect() {
    ++generation;
    const active = connection;
    connection = undefined;
    phase.value = active ? 'disconnecting' : 'idle';
    try {
      await active?.disconnect();
    } catch (cause) {
      showError(cause);
    } finally {
      phase.value = 'idle';
    }
  }

  async function fail(cause: unknown, active: TerminalConnection) {
    if (active !== connection) return;
    showError(cause);
    await disconnect();
  }

  function write(data: Uint8Array) {
    const active = connection;
    if (!active) return Promise.resolve();
    inputQueue = inputQueue
      .then(() => active === connection ? active.write(data) : undefined)
      .catch((cause: unknown) => fail(cause, active));
    return inputQueue;
  }

  async function resize(size: TerminalSize) {
    const active = connection;
    if (!active) return;
    try {
      await active.resize(size);
    } catch (cause) {
      await fail(cause, active);
    }
  }

  return { phase: readonly(phase), error: readonly(error), connect, disconnect, write, resize };
}

import { invoke } from '@tauri-apps/api/core';
import type { TerminalEvent, TerminalTransport } from '../domain/terminal';

export const tauriTransport: TerminalTransport = {
  available: true,
  async connect(request, size, onEvent) {
    const sessionId = await invoke<number>('ssh_connect', { request, size });
    let reading = true;

    async function readOutput() {
      try {
        // shortcut: one read per rendered chunk, batch with acknowledgements if throughput becomes a requirement.
        while (reading) {
          const event = await invoke<TerminalEvent | null>('ssh_read', { sessionId });
          if (!reading) return;
          await onEvent(event ?? { type: 'closed', error: null });
          if (!event || event.type === 'closed') return;
        }
      } catch (cause) {
        if (!reading) return;
        reading = false;
        await invoke('ssh_disconnect', { sessionId }).catch(() => {});
        await onEvent({ type: 'closed', error: String(cause) });
      }
    }
    void readOutput();

    return {
      async write(data) {
        for (let offset = 0; offset < data.length; offset += 16384) {
          await invoke('ssh_write', {
            sessionId,
            data: Array.from(data.subarray(offset, offset + 16384)),
          });
        }
      },
      async resize(size) {
        await invoke('ssh_resize', { sessionId, size });
      },
      async disconnect() {
        reading = false;
        await invoke('ssh_disconnect', { sessionId });
      },
    };
  },
};

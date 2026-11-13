export interface ConnectionOptions {
  term: string;
  connectTimeoutSecs: number;
  keepaliveIntervalSecs: number;
  keepaliveMax: number;
  inactivityTimeoutSecs: number;
}

export interface ConnectionRequest {
  host: string;
  port: number;
  username: string;
  password: string;
  hostKeySha256: string;
  ignoreHostKey: boolean;
  options?: ConnectionOptions;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export type TerminalEvent =
  | { type: 'data'; data: number[] }
  | { type: 'closed'; error: string | null };

export interface TerminalConnection {
  write(data: Uint8Array): Promise<void>;
  resize(size: TerminalSize): Promise<void>;
  disconnect(): Promise<void>;
}

export interface TerminalTransport {
  available: boolean;
  connect(
    request: ConnectionRequest,
    size: TerminalSize,
    onEvent: (event: TerminalEvent) => void | Promise<void>,
  ): Promise<TerminalConnection>;
}

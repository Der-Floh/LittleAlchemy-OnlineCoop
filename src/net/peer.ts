// The part of PeerJS that the room session uses. Real PeerJS objects fit these
// interfaces (checked where main.ts creates them); the unit tests use an
// in-memory fake of the same shape (test/unit/fakes.ts).

export type PeerErrorLike = { type?: string } | null | undefined;

export type ConnectOptions = { reliable?: boolean; serialization?: string; metadata?: unknown };

export interface ConnLike {
  readonly open: boolean;
  readonly peerConnection?: RTCPeerConnection | null;
  on(event: 'open' | 'close', fn: () => void): unknown;
  on(event: 'data', fn: (data: unknown) => void): unknown;
  on(event: 'error', fn: (err: unknown) => void): unknown;
  send(data: string): unknown;
  close(): void;
}

export interface PeerLike {
  readonly disconnected: boolean;
  readonly destroyed: boolean;
  on(event: 'open', fn: (id: string) => void): unknown;
  on(event: 'connection', fn: (conn: ConnLike) => void): unknown;
  on(event: 'disconnected', fn: () => void): unknown;
  on(event: 'error', fn: (err: PeerErrorLike) => void): unknown;
  connect(id: string, options: ConnectOptions): ConnLike;
  reconnect(): void;
  destroy(): void;
}

// Creates a peer on the broker: with an id to claim it (hosting), or
// undefined for a random one (joining).
export type CreatePeer = (id: string | undefined) => PeerLike;

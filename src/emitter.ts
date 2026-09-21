// Minimal typed event emitter; listener errors are isolated so one bad
// listener can't break the session or the game.

// Event name -> payload type, e.g. {status: Status; left: Member}.
export type EventMap = Record<string, unknown>;
export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends EventMap> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  off<K extends keyof Events>(type: K, fn: Listener<Events[K]>): void {
    this.listeners.get(type)?.delete(fn);
  }

  protected emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set] as Listener<Events[K]>[]) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[la-coop] listener for "' + String(type) + '" failed', err);
      }
    }
  }
}

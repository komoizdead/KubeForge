export interface EventListener {
  (payload: unknown): void;
}

export class EventBus {
  readonly #listeners = new Map<string, Set<EventListener>>();

  on(event: string, listener: EventListener): () => void {
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener);
    return () => this.off(event, listener);
  }

  once(event: string, listener: EventListener): () => void {
    const wrapper: EventListener = (payload) => {
      this.off(event, wrapper);
      listener(payload);
    };
    return this.on(event, wrapper);
  }

  off(event: string, listener: EventListener): void {
    const listeners = this.#listeners.get(event);
    if (!listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) this.#listeners.delete(event);
  }

  emit(event: string, payload?: unknown): void {
    const listeners = this.#listeners.get(event);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(payload);
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}

export type Listener<T> = (value: T) => void;
export type Unsubscribe = () => void;

export class Signal<T> {
  #value: T;
  #listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.#value = initial;
  }

  get value(): T {
    return this.#value;
  }

  set(value: T): void {
    this.#value = value;
    for (const listener of this.#listeners) {
      listener(value);
    }
  }

  subscribe(listener: Listener<T>): Unsubscribe {
    this.#listeners.add(listener);
    listener(this.#value);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export function objectKey(type: string, id: string): string {
  return `${type}:${id}`;
}

export function streamKey(stream: string, key: string): string {
  return `${stream}:${key}`;
}

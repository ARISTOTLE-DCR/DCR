export class ScanCache<T> {
  private readonly values = new Map<string, { expires: number; value: T }>();
  private readonly inflight = new Map<string, Promise<T>>();
  constructor(private readonly ttlMs: number) {}
  run(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.values.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const task = load().then((value) => { this.values.set(key, { expires: Date.now() + this.ttlMs, value }); return value; }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }
}

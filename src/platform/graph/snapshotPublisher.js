import { frozenCopy } from '../contracts/canonicalJson.js';
import { validateSnapshot } from './validateSnapshot.js';

export class SnapshotPublisher {
  #tail = Promise.resolve();
  #current = null;
  constructor(store) { this.store = store; }
  get current() { return this.#current; }
  async restore(environment = 'demo') {
    const snapshot = await this.store.getActiveSnapshot(environment);
    this.#current = snapshot ? frozenCopy(snapshot) : null;
    return this.#current;
  }
  publish(registry, buildCandidate) {
    const publish = async () => {
      const snapshot = validateSnapshot(await buildCandidate(), registry);
      const stored = await this.store.publishSnapshot(registry, snapshot);
      this.#current = frozenCopy(stored);
      return this.#current;
    };
    const next = this.#tail.then(publish);
    this.#tail = next.catch(() => {});
    return next;
  }
}

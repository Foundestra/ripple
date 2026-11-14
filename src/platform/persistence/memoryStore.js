import { frozenCopy } from '../contracts/canonicalJson.js';
import { validateSnapshot } from '../graph/validateSnapshot.js';

// Test/demo store only. Runtime durability uses Postgres, not this process-local store.
export class MemorySnapshotStore {
  #registries = new Map();
  #snapshots = new Map();
  #active = new Map();
  #events = [];
  async publishSnapshot(registry, snapshot) {
    validateSnapshot(snapshot, registry);
    const key = `${registry.registry_id}@${registry.version}`;
    const existing = this.#registries.get(key);
    if (existing && existing.source_sha256 !== registry.source_sha256) throw Object.assign(new Error('Registry version content conflict'), { code: 'SNAPSHOT_VERSION_CONFLICT' });
    const stored = this.#snapshots.get(snapshot.snapshot_id) || frozenCopy(snapshot);
    const old = this.#active.get(snapshot.environment);
    this.#registries.set(key, frozenCopy(registry));
    this.#snapshots.set(stored.snapshot_id, stored);
    if (old !== stored.snapshot_id) {
      this.#events.push(frozenCopy({ event_type: 'PUBLISHED', snapshot_id: stored.snapshot_id, related_snapshot_id: old || null, generation: this.#events.length + 1 }));
      if (old) this.#events.push(frozenCopy({ event_type: 'SUPERSEDES', snapshot_id: stored.snapshot_id, related_snapshot_id: old }));
    }
    this.#active.set(snapshot.environment, stored.snapshot_id);
    return frozenCopy(stored);
  }
  async getSnapshot(id) { return this.#snapshots.has(id) ? frozenCopy(this.#snapshots.get(id)) : null; }
  async getActiveSnapshot(environment = 'demo') { return this.getSnapshot(this.#active.get(environment)); }
  async snapshotEvents() { return frozenCopy(this.#events); }
  async rebuildSnapshotProjections() {
    this.#active.clear();
    for (const event of this.#events) if (event.event_type === 'PUBLISHED') this.#active.set(this.#snapshots.get(event.snapshot_id).environment, event.snapshot_id);
  }
}

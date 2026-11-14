// The snapshot store contract: all operations are asynchronous, snapshots immutable.
// publishSnapshot(registry, snapshot): validate, atomically persist facts/events and
// active projection, return the stored (possibly deduplicated) frozen document.
// getSnapshot(id), getActiveSnapshot(environment): read only; null if absent.
// rebuildSnapshotProjections(): rebuild from append-only publication facts.
export function assertSnapshotStore(store) {
  for (const name of ['publishSnapshot', 'getSnapshot', 'getActiveSnapshot', 'rebuildSnapshotProjections']) {
    if (typeof store?.[name] !== 'function') throw new TypeError(`Snapshot store lacks ${name}`);
  }
  return store;
}

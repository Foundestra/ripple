// Provider-neutral result envelope. Initial adapters accept bundled DEMO only.
// Operational adapters require separate source authorization before acquisition.
export const SOURCE_STATUSES = Object.freeze(['real', 'mock', 'pending', 'unavailable']);
export const ADAPTER_METHODS = Object.freeze(['loadRegistry', 'loadDependencyObservations', 'loadOwnershipAndTier', 'loadControls', 'loadOperationalContext']);
export function assertAdapterResult(result) {
  if (!result || !SOURCE_STATUSES.includes(result.status) || !Array.isArray(result.records) || result.records.length > 2500 ||
      typeof result.source_version !== 'string' || typeof result.truncated !== 'boolean' || !Array.isArray(result.references) || result.references.length > 100) {
    throw new Error('Invalid bounded adapter result');
  }
  return result;
}

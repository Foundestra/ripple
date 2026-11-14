import { loadConfig } from './config.js';
import { loadCatalog } from './adapters/catalog.js';
import { GraphService } from './core/graphService.js';
import { createPlanningAdapter } from './adapters/planning.js';
import { SeededIncidents } from './adapters/incidents.js';
import { createLlm } from './adapters/llm.js';
import { Orchestrator } from './core/orchestrator.js';
import { loadPlatformFixture } from './adapters/fixtures.js';

// Wires adapters together. Every seeded adapter has the same interface as its
// real counterpart, so swapping one in is a config change.
export async function createRipple(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  if (overrides.graph) config.graph = { ...loadConfig().graph, ...overrides.graph };
  if (overrides.platform) config.platform = { ...loadConfig().platform, ...overrides.platform };
  const catalog = loadCatalog(config.dataDir);
  const graphService = await new GraphService(config, catalog, { log: overrides.log || console }).init();
  const planning = createPlanningAdapter(config);
  const incidentSource = new SeededIncidents(config);
  const llm = createLlm(config);
  const orchestrator = new Orchestrator({ config, catalog, graphService, planning, incidentSource, llm });
  let platform;
  try { platform = await createPlatform(config, overrides); }
  catch (error) { await graphService.stop(); throw error; }
  return { config, catalog, graphService, planning, incidentSource, llm, orchestrator, platform };
}

async function createPlatform(config, overrides) {
  if (config.platform.mode === 'off') return null;
  const { createAccessBoundary } = await import('./platform/security/accessBoundary.js');
  const accessBoundary = createAccessBoundary({ mode: config.platform.mode });
  if (config.platform.mode !== 'demo') throw Object.assign(new Error('Operational platform mode is not available'), { code: 'PLATFORM_AUTH_NOT_CONFIGURED' });

  const injected = overrides.platform?.assessmentStore && overrides.platform?.snapshotStore;
  let assessmentStore = overrides.platform?.assessmentStore;
  let snapshotStore = overrides.platform?.snapshotStore;
  let pool = null;
  try {
    if (!injected) {
      if (!config.postgresUrl) throw Object.assign(new Error('Demo platform mode requires DATABASE_URL for durable storage'), { code: 'PLATFORM_DATABASE_REQUIRED' });
      const { Pool } = await import('pg');
      const { PostgresSnapshotStore } = await import('./platform/persistence/postgresStore.js');
      const { PostgresAssessmentStore } = await import('./platform/persistence/postgresAssessmentStore.js');
      pool = new Pool({ connectionString: config.postgresUrl });
      snapshotStore = new PostgresSnapshotStore(pool);
      assessmentStore = new PostgresAssessmentStore(pool);
      await snapshotStore.init();
    }
    const [{ loadDemoRegistry }, { loadDemoSnapshot }, { loadPolicy }, { createPlatformRouter }] = await Promise.all([
      import('./platform/adapters/demoRegistryAdapter.js'), import('./platform/adapters/demoGraphAdapter.js'),
      import('./platform/policy/loadPolicy.js'), import('./platform/http/platformRoutes.js'),
    ]);
    const registry = await loadDemoRegistry(config.platform.manifestPath);
    const active = await snapshotStore.getActiveSnapshot('demo');
    if (!active || active.registry_version !== registry.registry_version) await snapshotStore.publishSnapshot(registry, await loadDemoSnapshot(registry));
    const policy = loadPolicy(config.platform.policyPath);
    const fixtureLoader = id => {
      const request = loadPlatformFixture(config.fixturesDir, id);
      if (!request) throw Object.assign(new Error('Unknown bundled demo fixture'), { code: 'ACCESS_DENIED', status: 403 });
      return request;
    };
    const router = createPlatformRouter({ registry, snapshotStore, assessmentStore, policy, accessBoundary, fixtureLoader,
      limits: { max_body_bytes: config.platform.maxBodyBytes, max_files: config.platform.maxFiles,
        max_path_bytes: config.platform.maxPathBytes, max_result_bytes: config.platform.maxResultBytes,
        max_history: config.platform.maxHistory, max_ms: config.platform.maxMs, max_nodes: config.platform.maxNodes,
        max_edges_per_direction: config.platform.maxEdgesPerDirection, max_evidence_bytes: config.platform.maxEvidenceBytes,
        max_references: config.platform.maxReferences } });
    return { router, registry, snapshotStore, assessmentStore, policy, accessBoundary, pool,
      async close() { if (pool) await pool.end(); } };
  } catch (error) {
    if (pool) await pool.end();
    throw error;
  }
}

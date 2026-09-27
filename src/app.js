import { loadConfig } from './config.js';
import { loadCatalog } from './adapters/catalog.js';
import { GraphService } from './core/graphService.js';
import { createPlanningAdapter } from './adapters/planning.js';
import { SeededIncidents } from './adapters/incidents.js';
import { createLlm } from './adapters/llm.js';
import { Orchestrator } from './core/orchestrator.js';

// Wires adapters together. Every seeded adapter has the same interface as its
// real counterpart, so swapping one in is a config change.
export async function createRipple(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  if (overrides.graph) config.graph = { ...loadConfig().graph, ...overrides.graph };
  const catalog = loadCatalog(config.dataDir);
  const graphService = await new GraphService(config, catalog, { log: overrides.log || console }).init();
  const planning = createPlanningAdapter(config);
  const incidentSource = new SeededIncidents(config);
  const llm = createLlm(config);
  const orchestrator = new Orchestrator({ config, catalog, graphService, planning, incidentSource, llm });
  return { config, catalog, graphService, planning, incidentSource, llm, orchestrator };
}

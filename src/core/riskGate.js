// The risk gate. Turns the three signal families into LOW / MEDIUM / HIGH with
// an itemised, explainable score. Cheap and deterministic: it runs before any
// agent, and LOW PRs stop here.

export const LEVELS = { low: 'low', medium: 'medium', high: 'high' };
export const THRESHOLDS = { medium: 3, high: 7 };

export function classifyRisk({ change, blast, incidents, intent, catalog }) {
  const factors = [];
  const add = (points, family, label) => factors.push({ points, family, label });

  if (change.docsOnly) {
    add(0, 'code', 'Documentation-only change');
    return result(factors, 'low', { capped: false });
  }

  // Code: how critical is what changed?
  const top = change.services[0];
  if (top) {
    const s = catalog.get(top.name);
    if (s.tier === 1) add(3, 'code', `Changes tier-1 service \`${top.name}\``);
    else if (s.tier === 2) add(1, 'code', `Changes tier-2 service \`${top.name}\``);
    else add(0, 'code', `Changes tier-${s.tier} service \`${top.name}\``);
  }

  // Build: what kind of change is it?
  const breaking = change.breakingChanges;
  const additive = change.contractChanges.filter((c) => !c.breaking);
  if (breaking.length) add(3, 'build', `Breaking contract change: ${breaking.map((c) => c.detail).join('; ')}`);
  else if (additive.length) add(1, 'build', `Additive contract change: ${additive.map((c) => c.detail).join('; ')}`);
  if (change.otherContractFiles.length) add(1, 'build', `Touches contract files: ${change.otherContractFiles.map((f) => `\`${f}\``).join(', ')}`);

  const handler = change.apiSurface[0];
  if (handler && !breaking.length) add(2, 'build', `Changes API handler \`${handler.symbol}\` in \`${handler.service}\``);

  if (change.migrations.length) add(2, 'build', `Includes migrations: ${change.migrations.map((f) => `\`${f}\``).join(', ')}`);

  if (change.size.changed > 1000) add(2, 'build', `Large diff (${change.size.changed} changed lines)`);
  else if (change.size.changed > 400) add(1, 'build', `Sizeable diff (${change.size.changed} changed lines)`);

  if (change.ci?.state === 'failure') add(2, 'build', 'CI is failing');

  // Code: who depends on it, and how hard?
  const interfaceChange = breaking.length > 0 || additive.length > 0 || !!handler || change.otherContractFiles.length > 0;
  const hard = blast.filter((b) => b.allHard);
  const soft = blast.filter((b) => !b.allHard);
  const hardTier1 = hard.filter((b) => b.tier === 1);
  if (interfaceChange) {
    if (hard.length) {
      add(3, 'code', `${hard.length} caller${hard.length > 1 ? 's' : ''} depend on it via hard edges: ${names(hard)}`);
      if (hardTier1.length) add(1, 'code', `Hard-dependent callers include tier-1: ${names(hardTier1)}`);
    } else if (soft.length) {
      add(1, 'code', `Callers depend on it via soft edges only (${names(soft)}): they degrade, not break`);
    }
  } else if (hardTier1.length && !change.copyOnly) {
    add(1, 'code', `Runtime exposure: tier-1 ${names(hardTier1)} call it synchronously`);
  }

  // Build: has a change like this hurt us before?
  const best = incidents[0];
  if (best?.strength === 'match') add(2, 'build', `Similar to past incident ${best.incident.id} (similarity ${best.score})`);
  else if (best?.strength === 'related') add(1, 'build', `Related to past incident ${best.incident.id} (similarity ${best.score})`);

  // Planning: does it do what the ticket says?
  if (intent.status === 'mismatch') add(2, 'planning', `Diff doesn't match ${intent.key}: ${intent.reasons[0]}`);
  else if (intent.status === 'partial') add(1, 'planning', `Diff partly outside ${intent.key}'s scope`);
  else if (intent.status === 'missing') add(1, 'planning', intent.reasons[0]);

  const score = factors.reduce((s, f) => s + f.points, 0);
  let level = score >= THRESHOLDS.high ? 'high' : score >= THRESHOLDS.medium ? 'medium' : 'low';

  // Don't cry wolf: HIGH needs a real reason to break something. Soft edges warn,
  // only hard edges on critical tiers (or breaking changes / migrations) escalate.
  const escalates = (interfaceChange && hardTier1.length > 0) || breaking.length > 0 || change.migrations.length > 0;
  let capped = false;
  if (level === 'high' && !escalates) {
    level = 'medium';
    capped = true;
  }
  return result(factors, level, { capped, interfaceChange, hard, soft });
}

function result(factors, level, extra) {
  const score = factors.reduce((s, f) => s + f.points, 0);
  return { level, score, factors, thresholds: THRESHOLDS, ...extra };
}

const names = (xs) => xs.map((x) => `\`${x.service}\``).join(', ');

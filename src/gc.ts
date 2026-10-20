import type { KalinovStorageAdapter } from "./adapters/types.ts";
import { classify, buildMeta } from "./classifier.ts";
import { arbitrate } from "./arbitration.ts";

export interface GCReport { adapter: string; expired: number; contradicted: number; restamped: number; postHocDeleted: number }

export async function runGC(
  adapters: KalinovStorageAdapter[],
  session: number,
  since: Date,
  ttlSessions: number,
  log: (m: string) => void,
): Promise<GCReport[]> {
  const reports: GCReport[] = [];
  for (const a of adapters) {
    const r: GCReport = { adapter: a.id, expired: 0, contradicted: 0, restamped: 0, postHocDeleted: 0 };

    // Delete in reverse id order so line-addressed backends don't shift remaining ids.
    const doomed = new Map<string, "expired" | "contradicted">();
    for (const rec of await a.list({ tier: "HYPOTHESIS" })) {
      const m = rec.meta;
      if (m.expiresAfterSessions !== undefined && session - (m.recordedSession ?? session) >= m.expiresAfterSessions) doomed.set(rec.id, "expired");
    }
    for (const rec of await a.list({ contradicted: true })) doomed.set(rec.id, "contradicted");
    for (const id of [...doomed.keys()].sort(byIdDesc)) {
      await a.delete(id);
      r[doomed.get(id)!]++;
    }

    const constraints = await a.activeConstraints();
    const unstamped = (await a.listUnstamped(since)).sort((x, y) => byIdDesc(x.id, y.id));
    for (const rec of unstamped) {
      const c = classify({ content: rec.content });
      const conflict = arbitrate({ tier: c.tier, content: rec.content, scope: c.scope }, constraints);
      if (conflict) { await a.delete(rec.id); r.postHocDeleted++; log(`post-hoc delete ${rec.id}: ${conflict.reason}`); continue; }
      await a.restamp(rec.id, buildMeta(c, session, undefined, ttlSessions)); r.restamped++;
    }
    reports.push(r);
  }
  return reports;
}

function byIdDesc(a: string, b: string): number {
  const na = Number(a.split("#L")[1]), nb = Number(b.split("#L")[1]);
  const fa = a.split("#L")[0], fb = b.split("#L")[0];
  if (fa !== fb) return fa < fb ? -1 : 1;
  return Number.isFinite(na) && Number.isFinite(nb) ? nb - na : b < a ? -1 : 1;
}

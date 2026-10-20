import { promises as fs } from "node:fs";
import path from "node:path";
import type { Constraint, KalinovStorageAdapter, MemoryRecord, Tier, TierMeta, WriteInterceptSpec } from "./types.ts";

const TAG = /\s*<!--\s*kalinov:(\{.*\})\s*-->\s*$/;

export function stampLine(line: string, meta: TierMeta): string {
  return `${line.replace(TAG, "").trimEnd()} <!-- kalinov:${JSON.stringify(meta)} -->`;
}
export function stripTag(line: string): string { return line.replace(TAG, ""); }
export function parseLine(line: string): TierMeta | null {
  const m = TAG.exec(line); if (!m) return null;
  try { return JSON.parse(m[1]) as TierMeta; } catch { return null; }
}
const recordId = (file: string, lineNo: number): string => `${file}#L${lineNo + 1}`;
function splitId(id: string): { file: string; lineNo: number } {
  const i = id.lastIndexOf("#L"); return { file: id.slice(0, i), lineNo: Number(id.slice(i + 2)) - 1 };
}

/**
 * Built-in OpenClaw memory (MEMORY.md, memory/*.md). No auto-capture: every agent write goes through
 * file tools and is stamped at the gate. Unstamped lines are human-authored or pre-date Kalinov —
 * they are never classified, restamped or deleted.
 */
export class MarkdownAdapter implements KalinovStorageAdapter {
  readonly id = "markdown";
  private readonly workspaceDir: string;
  constructor(workspaceDir: string) { this.workspaceDir = workspaceDir; }

  get root(): string { return this.workspaceDir; }

  writeIntercept(): WriteInterceptSpec {
    return { toolNames: ["write", "edit"], writePathPatterns: ["MEMORY.md", "memory.md", "memory/*.md"] };
  }

  matchesPath(p: string | undefined): boolean {
    if (!p) return false;
    const rel = path.relative(this.workspaceDir, path.resolve(this.workspaceDir, p)).split(path.sep).join("/");
    return rel === "MEMORY.md" || rel === "memory.md" || /^memory\/[^/]+\.md$/.test(rel);
  }

  stamp(payload: unknown, meta: TierMeta): unknown {
    const p = payload as Record<string, unknown>;
    const key = (["content", "text", "new_string"] as const).find((k) => typeof p[k] === "string");
    if (!key) return payload;
    const lines = (p[key] as string).split("\n");
    return { ...p, [key]: lines.map((l) => (l.trim() && !l.trimStart().startsWith("#") ? stampLine(l, meta) : l)).join("\n") };
  }

  private async files(): Promise<string[]> {
    const out: string[] = [];
    for (const f of ["MEMORY.md", "memory.md"]) { try { await fs.access(path.join(this.workspaceDir, f)); out.push(f); } catch { /* absent */ } }
    try {
      for (const f of (await fs.readdir(path.join(this.workspaceDir, "memory"))).sort()) if (f.endsWith(".md")) out.push(`memory/${f}`);
    } catch { /* absent */ }
    return out;
  }

  async list(filter: { tier?: Tier; contradicted?: boolean; createdAfter?: Date }): Promise<MemoryRecord[]> {
    const out: MemoryRecord[] = [];
    for (const file of await this.files()) {
      const lines = (await fs.readFile(path.join(this.workspaceDir, file), "utf8")).split("\n");
      lines.forEach((line, i) => {
        const meta = parseLine(line); if (!meta) return;
        if (filter.tier && meta.tier !== filter.tier) return;
        if (filter.contradicted !== undefined && !!meta.contradicted !== filter.contradicted) return;
        if (filter.createdAfter && new Date(meta.recordedAt) <= filter.createdAfter) return;
        out.push({ id: recordId(file, i), content: line.replace(TAG, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim(), meta });
      });
    }
    return out;
  }

  async listUnstamped(_createdAfter: Date): Promise<MemoryRecord[]> { return []; }

  private async rewrite(id: string, fn: (line: string) => string | null): Promise<void> {
    const { file, lineNo } = splitId(id);
    const abs = path.join(this.workspaceDir, file);
    const lines = (await fs.readFile(abs, "utf8")).split("\n");
    if (lineNo < 0 || lineNo >= lines.length) return;
    const next = fn(lines[lineNo]);
    if (next === null) lines.splice(lineNo, 1); else lines[lineNo] = next;
    await fs.writeFile(abs, lines.join("\n"), "utf8");
  }

  async restamp(id: string, meta: TierMeta): Promise<void> { await this.rewrite(id, (l) => stampLine(l, meta)); }
  async delete(id: string): Promise<void> { await this.rewrite(id, () => null); }

  async activeConstraints(): Promise<Constraint[]> {
    return (await this.list({}))
      .filter((r) => (r.meta.tier === "DIRECTIVE" || r.meta.tier === "DECISION") && !r.meta.contradicted)
      .map((r) => ({
        id: r.id, tier: r.meta.tier as "DIRECTIVE" | "DECISION", content: r.content, recordedAt: r.meta.recordedAt,
        ...(r.meta.scope ? { scope: r.meta.scope } : {}),
      }));
  }

  async doctor(): Promise<{ ok: boolean; detail: string }> {
    const file = `memory/kalinov-doctor-${Date.now()}.md`;
    const abs = path.join(this.workspaceDir, file);
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, stampLine("kalinov doctor probe", { tier: "HYPOTHESIS", recordedAt: new Date().toISOString() }) + "\n", "utf8");
      const found = (await this.list({ tier: "HYPOTHESIS" })).find((r) => r.id.startsWith(file + "#"));
      if (!found) { await fs.rm(abs, { force: true }); return { ok: false, detail: "probe written but not listed" }; }
      await this.delete(found.id);
      const survived = (await this.list({ tier: "HYPOTHESIS" })).some((r) => r.id.startsWith(file + "#"));
      await fs.rm(abs, { force: true });
      return survived ? { ok: false, detail: "probe survived delete()" } : { ok: true, detail: "write/list/delete round-trip ok" };
    } catch (e) {
      await fs.rm(abs, { force: true }).catch(() => {});
      return { ok: false, detail: String(e) };
    }
  }
}

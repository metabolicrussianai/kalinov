export type Tier = "DIRECTIVE" | "OBSERVATION" | "DECISION" | "HYPOTHESIS";

export interface TierMeta {
  tier: Tier;
  recordedAt: string;            // ISO 8601
  recordedSession?: number;      // Kalinov session counter at write time
  expiresAfterSessions?: number; // HYPOTHESIS only
  scope?: string;                // DECISION only, e.g. "prototype A until migration"
  sourceTurnId?: string;
  contradicted?: boolean;
}

export interface Constraint {
  id: string;
  tier: "DIRECTIVE" | "DECISION";
  content: string;
  scope?: string;
  recordedAt: string;
}

export interface MemoryRecord {
  id: string;
  content: string;
  meta: TierMeta;
}

export interface WriteInterceptSpec {
  /** Tool names that constitute a write for this backend (e.g. ["memory_add", "memory_update"]). */
  toolNames: string[];
  /** For file-based backends: patterns of paths whose write/edit counts as a memory write. */
  writePathPatterns?: string[];
}

export interface KalinovStorageAdapter {
  readonly id: string;

  /** What Kalinov should hook in before_tool_call for this backend. */
  writeIntercept(): WriteInterceptSpec;

  /** For file-based backends: does this tool target path belong to memory? Others may omit. */
  matchesPath?(p: string | undefined): boolean;

  /** Attach tier/TTL metadata to an outgoing write payload. Return the modified payload. */
  stamp(payload: unknown, meta: TierMeta): unknown;

  /** Records carrying Kalinov metadata, filtered. Used by GC and arbitration. */
  list(filter: {
    tier?: Tier;
    contradicted?: boolean;
    createdAfter?: Date;
  }): Promise<MemoryRecord[]>;

  /**
   * Records the backend created OUTSIDE tool calls (auto-capture), since `createdAfter`.
   * Return [] if the backend has no auto-capture. Never return human-authored or pre-existing content:
   * anything returned here may be deleted by post-hoc arbitration.
   */
  listUnstamped(createdAfter: Date): Promise<MemoryRecord[]>;

  /** Attach metadata to an already-stored record (post-hoc path). */
  restamp(id: string, meta: TierMeta): Promise<void>;

  /** Physically remove a record. Must not merely flag it. */
  delete(id: string): Promise<void>;

  /** Active DIRECTIVE and in-scope DECISION records to arbitrate against. */
  activeConstraints(): Promise<Constraint[]>;

  /** Round-trip self-test used by `openclaw kalinov doctor`: write, list, delete a probe record. */
  doctor(): Promise<{ ok: boolean; detail: string }>;
}

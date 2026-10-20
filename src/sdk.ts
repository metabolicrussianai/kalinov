// Subset of the OpenClaw plugin SDK surface Kalinov touches.
// Mirrored from openclaw/openclaw: src/plugins/hook-types.ts, src/plugins/plugin-api.types.ts,
// src/plugins/session-end-transcript.ts. Replace with `import type` from the published SDK when wired.

export interface PluginLogger { info(m: string): void; warn(m: string): void; error(m: string): void; debug?(m: string): void }

/** hook-types.ts: PluginHookBeforeToolCallEvent */
export interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  /** Best-effort host-derived destination paths (e.g. apply_patch). A hint, not authoritative. */
  derivedPaths?: readonly string[];
}

/** hook-types.ts: PluginHookToolContext (subset). Note: no workspaceDir here. */
export interface ToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}

/** hook-before-tool-call-result.ts (subset). Returned params must match the tool's native schema. */
export interface BeforeToolCallResult {
  block?: boolean;
  blockReason?: string;
  params?: Record<string, unknown>;
}

/** hook-types.ts: PluginHookLlmInputEvent (subset). Needs plugins.entries.<id>.hooks.allowConversationAccess. */
export interface LlmInputEvent { runId: string; sessionId: string; prompt: string }

/** hook-types.ts: PluginHookSessionEndEvent */
export interface SessionEndEvent {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
  reason?: string;
}

/** session-end-transcript.ts: PluginHookSessionContext (subset) */
export interface SessionContext { agentId?: string; sessionId: string; sessionKey?: string }

export interface CliCommandLike {
  command(name: string): CliCommandLike;
  description(d: string): CliCommandLike;
  option(flags: string, desc?: string): CliCommandLike;
  action(fn: (...args: any[]) => unknown): CliCommandLike;
}
/** config-contracts: OpenClawPluginCliContext (subset) */
export interface PluginCliContext { program: CliCommandLike; config: Record<string, any>; workspaceDir?: string; logger: PluginLogger }

export interface OpenClawPluginApi {
  id: string;
  /** Whole OpenClaw config. */
  config: Record<string, any>;
  /** This plugin's own config from plugins.entries.<id>.config. */
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  /** Absent on very old hosts and in the unit-test fake. */
  registerCli?(registrar: (ctx: PluginCliContext) => void | Promise<void>, opts?: { descriptors?: Array<{ name: string; description: string; hasSubcommands?: boolean }>; commands?: string[] }): void;
  on(hook: "before_tool_call", h: (e: BeforeToolCallEvent, ctx: ToolContext) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void, opts?: { matcher?: readonly [string, ...string[]]; priority?: number }): void;
  on(hook: "llm_input", h: (e: LlmInputEvent, ctx: Record<string, unknown>) => Promise<void> | void): void;
  on(hook: "session_end", h: (e: SessionEndEvent, ctx: SessionContext) => Promise<void> | void): void;
}

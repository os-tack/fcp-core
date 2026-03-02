import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EventLog } from "./event-log.js";
import { parseOp, isParseError } from "./parsed-op.js";
import type { ParsedOp } from "./parsed-op.js";
import { VerbRegistry } from "./verb-registry.js";
import type { VerbSpec } from "./verb-registry.js";
import { SessionDispatcher, type SessionHooks } from "./session.js";
import { formatResult, suggest } from "./formatter.js";

/**
 * Result of executing a single operation.
 */
export interface OpResult {
  success: boolean;
  message: string;
  prefix?: string;
}

/**
 * Result of a query that may include an image.
 */
export interface QueryResult {
  text: string;
  image?: { base64: string; mimeType: string };
}

/**
 * Domain adapter that an FCP domain must implement.
 */
export interface FcpDomainAdapter<Model, Event> {
  /** Create a new empty model. */
  createEmpty(title: string, params: Record<string, string>): Model;
  /** Serialize model to saveable format. */
  serialize(model: Model): Buffer | string;
  /** Deserialize from file contents. */
  deserialize(data: Buffer | string): Model;
  /** Rebuild derived indices (e.g., after undo/redo). */
  rebuildIndices(model: Model): void;
  /** Return a compact digest for drift detection. */
  getDigest(model: Model): string;
  /** Execute a parsed operation against the model. */
  dispatchOp(op: ParsedOp, model: Model, log: EventLog<Event>): OpResult | Promise<OpResult>;
  /** Execute a query against the model. */
  dispatchQuery(query: string, model: Model): string | QueryResult | Promise<string | QueryResult>;
  /** Reverse a single event (for undo). */
  reverseEvent(event: Event, model: Model): void;
  /** Replay a single event (for redo). */
  replayEvent(event: Event, model: Model): void;
  /** Optional: return a human-readable model summary for the MCP resource. */
  getModelSummary?(model: Model): string;
}

/**
 * Configuration for creating an FCP MCP server.
 */
export interface FcpServerConfig<Model, Event> {
  /** Domain name (e.g., "midi", "drawio"). Used as tool name prefix. */
  domain: string;
  /** Domain adapter implementing all domain-specific logic. */
  adapter: FcpDomainAdapter<Model, Event>;
  /** Verb specifications for this domain. */
  verbs: VerbSpec[];
  /** Optional reference card configuration. */
  referenceCard?: { sections?: Record<string, string> };
  /**
   * Domain-level callback: returns true to force a token as positional
   * instead of key:value (e.g. column ranges like B:G).
   */
  isPositional?: (token: string) => boolean;
}

/**
 * Create an MCP server wired up with FCP conventions.
 *
 * Registers 4 tools:
 *   {domain}         — primary mutation tool (ops array)
 *   {domain}_query   — read-only queries
 *   {domain}_session — lifecycle (new, open, save, checkpoint, undo, redo)
 *   {domain}_help    — reference card
 */
export function createFcpServer<Model, Event>(
  config: FcpServerConfig<Model, Event>,
): McpServer {
  const { domain, adapter, verbs, referenceCard, isPositional } = config;

  // Build registry and reference card
  const registry = new VerbRegistry();
  registry.registerMany(verbs);
  const refCard = registry.generateReferenceCard(referenceCard?.sections);

  // Event log
  const eventLog = new EventLog<Event>();

  // Session dispatcher with hooks
  const sessionHooks: SessionHooks<Model> = {
    onNew(params) {
      return adapter.createEmpty(params["title"] ?? "Untitled", params);
    },
    async onOpen(path) {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(path);
      const model = adapter.deserialize(data);
      adapter.rebuildIndices(model);
      return model;
    },
    async onSave(model, path) {
      const { writeFile } = await import("node:fs/promises");
      const data = adapter.serialize(model);
      await writeFile(path, data);
    },
    onRebuildIndices(model) {
      adapter.rebuildIndices(model);
    },
    getDigest(model) {
      return adapter.getDigest(model);
    },
  };
  const session = new SessionDispatcher<Model, Event>(sessionHooks, eventLog, {
    reverseEvent: (event, model) => adapter.reverseEvent(event, model),
    replayEvent: (event, model) => adapter.replayEvent(event, model),
  });

  // MCP server
  const server = new McpServer({
    name: `fcp-${domain}`,
    version: "0.1.0",
  });

  // ── Logging helper ──────────────────────────────────────
  const logger = `fcp-${domain}`;
  function log(level: "debug" | "info" | "warning" | "error", message: string, data?: Record<string, unknown>) {
    server.sendLoggingMessage({ level, logger, data: { message, ...data } }).catch(() => {});
  }

  // ── Primary mutation tool ──────────────────────────────
  server.tool(
    domain,
    `Execute ${domain} operations. Each op string follows the FCP verb DSL.\n\n${refCard}`,
    {
      ops: z
        .array(z.string())
        .describe("Array of operation strings"),
    },
    async ({ ops }) => {
      const model = session.model;
      if (!model) {
        return {
          content: [{ type: "text" as const, text: "error: no model loaded. Use session 'new' or 'open' first." }],
          isError: true,
        };
      }

      // Pre-process: split ops containing embedded newlines into separate ops.
      // LLMs sometimes send data blocks as a single string with \n instead of
      // separate array elements — expand them so data block mode works correctly.
      const expandedOps: string[] = [];
      for (const raw of ops) {
        if (raw.includes("\n")) {
          expandedOps.push(...raw.split("\n").filter((line) => line.trim()));
        } else {
          expandedOps.push(raw);
        }
      }

      const lines: string[] = [];
      let hasErrors = false;

      for (const opStr of expandedOps) {
        const parsed = parseOp(opStr, isPositional);
        if (isParseError(parsed)) {
          log("warning", `Parse error: ${parsed.error}`, { op: opStr });
          lines.push(`ERROR: ${parsed.error}`);
          hasErrors = true;
          continue;
        }

        // Check if verb is known
        const spec = registry.lookup(parsed.verb);
        if (!spec) {
          const suggestion = suggest(parsed.verb, verbs.map((v) => v.verb));
          const msg = `unknown verb "${parsed.verb}"`;
          log("warning", msg, { op: opStr, suggestion: suggestion ?? undefined });
          lines.push(suggestion ? `ERROR: ${msg}\n  try: ${suggestion}` : `ERROR: ${msg}`);
          hasErrors = true;
          continue;
        }

        const result = await adapter.dispatchOp(parsed, model, eventLog);
        lines.push(formatResult(result.success, result.message, result.prefix));
        if (!result.success) hasErrors = true;
      }

      // Append digest
      lines.push(adapter.getDigest(model));

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        isError: hasErrors,
      };
    },
  );

  // ── Query tool ─────────────────────────────────────────
  server.tool(
    `${domain}_query`,
    `Query ${domain} state. Read-only.`,
    {
      q: z.string().describe("Query string"),
    },
    async ({ q }) => {
      const model = session.model;
      if (!model) {
        return {
          content: [{ type: "text" as const, text: "error: no model loaded." }],
          isError: true,
        };
      }

      const result = await adapter.dispatchQuery(q, model);

      if (typeof result === "string") {
        return { content: [{ type: "text" as const, text: result }] };
      }

      const qr = result as QueryResult;
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [];
      if (qr.image) {
        content.push({ type: "image" as const, data: qr.image.base64, mimeType: qr.image.mimeType });
      }
      content.push({ type: "text" as const, text: qr.text });
      return { content };
    },
  );

  // ── Session tool ───────────────────────────────────────
  server.tool(
    `${domain}_session`,
    `${domain} lifecycle: new, open, save, checkpoint, undo, redo.`,
    {
      action: z.string().describe(
        "Action: 'new \"Title\"', 'open ./file', 'save', 'save as:./out', 'checkpoint v1', 'undo', 'undo to:v1', 'redo'",
      ),
    },
    async ({ action }) => {
      log("info", `Session: ${action}`);
      const text = await session.dispatch(action);
      const model = session.model;
      const digest = model ? adapter.getDigest(model) : "";
      const output = digest ? `${text}\n${digest}` : text;
      return { content: [{ type: "text" as const, text: output }] };
    },
  );

  // ── Help tool ──────────────────────────────────────────
  server.tool(
    `${domain}_help`,
    `Returns the ${domain} FCP reference card.`,
    {},
    async () => {
      return { content: [{ type: "text" as const, text: refCard }] };
    },
  );

  // ── Resources ─────────────────────────────────────────
  server.resource(
    "session-status",
    `fcp://${domain}/session`,
    { description: `Current ${domain} session state`, mimeType: "text/plain" },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/plain",
        text: buildSessionResource(session, adapter, domain),
      }],
    }),
  );

  if (adapter.getModelSummary) {
    const getModelSummary = adapter.getModelSummary.bind(adapter);
    server.resource(
      "model-overview",
      `fcp://${domain}/model`,
      { description: `Current ${domain} model contents`, mimeType: "text/plain" },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: session.model ? getModelSummary(session.model) : "No model loaded.",
        }],
      }),
    );
  }

  return server;
}

function buildSessionResource<Model, Event>(
  session: SessionDispatcher<Model, Event>,
  adapter: FcpDomainAdapter<Model, Event>,
  domain: string,
): string {
  if (!session.model) {
    return `No ${domain} session active.`;
  }
  const lines: string[] = [];
  if (session.filePath) {
    lines.push(`File: ${session.filePath}`);
  }
  lines.push(`State: ${adapter.getDigest(session.model)}`);
  return lines.join("\n");
}

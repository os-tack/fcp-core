import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { userInfo } from "node:os";
import { parseOp, isParseError } from "./parsed-op.js";
import type { FcpDomainAdapter, OpResult, QueryResult } from "./server.js";
import type { SessionDispatcher } from "./session.js";
import type { VerbRegistry } from "./verb-registry.js";

export function connectToSlipstream<Model, Event>(config: {
  domain: string;
  extensions: string[];
  adapter: FcpDomainAdapter<Model, Event>;
  session: SessionDispatcher<Model, Event>;
  registry: VerbRegistry;
  isPositional?: (token: string) => boolean;
}): void {
  try {
    const { domain, extensions, adapter, session, registry, isPositional } = config;

    // Discover socket path
    const socketPath =
      process.env.SLIPSTREAM_SOCKET ??
      (process.env.XDG_RUNTIME_DIR
        ? `${process.env.XDG_RUNTIME_DIR}/slipstream/daemon.sock`
        : `/tmp/slipstream-${userInfo().uid}/daemon.sock`);

    const socket = createConnection(socketPath);
    socket.unref();

    socket.on("error", () => {
      // Silently ignore connection errors
    });

    socket.on("connect", () => {
      // Send registration message
      const registerMsg = JSON.stringify({
        jsonrpc: "2.0",
        method: "fcp.register",
        params: {
          handler_name: `fcp-${domain}`,
          extensions,
          capabilities: ["ops", "query", "session"],
        },
      });
      socket.write(registerMsg + "\n");

      // NDJSON request/response loop
      const rl = createInterface({ input: socket });

      rl.on("line", (line: string) => {
        handleLine(line, socket, domain, adapter, session, registry, isPositional).catch(
          () => {},
        );
      });

      rl.on("error", () => {});
    });
  } catch {
    // Silently return on any error
  }
}

async function handleLine<Model, Event>(
  line: string,
  socket: import("node:net").Socket,
  domain: string,
  adapter: FcpDomainAdapter<Model, Event>,
  session: SessionDispatcher<Model, Event>,
  registry: VerbRegistry,
  isPositional?: (token: string) => boolean,
): Promise<void> {
  let id: unknown = null;
  try {
    const req = JSON.parse(line);
    id = req.id;
    const method: string = req.method;
    const params = req.params ?? {};

    let result: { text: string };

    if (method === "fcp.session") {
      const text = await session.dispatch(params.action as string);
      const model = session.model;
      const digest = model ? adapter.getDigest(model) : "";
      result = { text: digest ? `${text}\n${digest}` : text };
    } else if (method === "fcp.ops") {
      const model = session.model;
      if (!model) {
        sendResponse(socket, id, undefined, { code: -1, message: "no model loaded" });
        return;
      }

      const lines: string[] = [];
      const opStrings: string[] = params.ops ?? [];

      for (const opStr of opStrings) {
        const parsed = parseOp(opStr, isPositional);
        if (isParseError(parsed)) {
          lines.push(`ERROR: ${parsed.error}`);
          continue;
        }
        const opResult: OpResult = await adapter.dispatchOp(
          parsed,
          model,
          session.eventLog,
        );
        lines.push(opResult.success ? opResult.message : `ERROR: ${opResult.message}`);
      }

      lines.push(adapter.getDigest(model));
      result = { text: lines.join("\n") };
    } else if (method === "fcp.query") {
      const model = session.model;
      if (!model) {
        sendResponse(socket, id, undefined, { code: -1, message: "no model loaded" });
        return;
      }

      const queryResult = await adapter.dispatchQuery(params.q as string, model);
      if (typeof queryResult === "string") {
        result = { text: queryResult };
      } else {
        result = { text: (queryResult as QueryResult).text };
      }
    } else {
      sendResponse(socket, id, undefined, { code: -1, message: `unknown method: ${method}` });
      return;
    }

    sendResponse(socket, id, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendResponse(socket, id, undefined, { code: -1, message });
  }
}

function sendResponse(
  socket: import("node:net").Socket,
  id: unknown,
  result?: { text: string },
  error?: { code: number; message: string },
): void {
  const response: Record<string, unknown> = { jsonrpc: "2.0", id };
  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }
  socket.write(JSON.stringify(response) + "\n");
}

"""Slipstream bridge client — connects FCP servers to the Slipstream daemon via Unix socket.

Discovers the daemon socket, registers the handler, and enters an NDJSON
request/response loop.  Runs in a daemon thread so it never blocks the
main MCP server.  Silently returns on any connection failure (bridge is
invisible when Slipstream isn't running).
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from fcp_core.server import FcpDomainAdapter, OpResult
    from fcp_core.session import SessionDispatcher
    from fcp_core.verb_registry import VerbRegistry


def _find_socket_path() -> str | None:
    """Return the Slipstream daemon socket path, or None if not found."""
    path = os.environ.get("SLIPSTREAM_SOCKET")
    if path and os.path.exists(path):
        return path

    xdg = os.environ.get("XDG_RUNTIME_DIR", "")
    if xdg:
        path = os.path.join(xdg, "slipstream", "daemon.sock")
        if os.path.exists(path):
            return path

    path = f"/tmp/slipstream-{os.getuid()}/daemon.sock"
    if os.path.exists(path):
        return path

    return None


async def _bridge_loop(
    path: str,
    domain: str,
    extensions: list[str],
    adapter: "FcpDomainAdapter",
    session: "SessionDispatcher",
    registry: "VerbRegistry",
    is_positional: Callable[[str], bool] | None,
) -> None:
    """Async loop: connect, register, then handle NDJSON requests."""
    from fcp_core.formatter import format_result
    from fcp_core.parsed_op import ParseError, parse_op

    reader, writer = await asyncio.open_unix_connection(path)

    # Send registration
    reg_msg = {
        "jsonrpc": "2.0",
        "method": "fcp.register",
        "params": {
            "handler_name": f"fcp-{domain}",
            "extensions": extensions,
            "capabilities": ["ops", "query", "session"],
        },
    }
    writer.write((json.dumps(reg_msg) + "\n").encode())
    await writer.drain()

    # Request/response loop
    while True:
        line = await reader.readline()
        if not line:
            break

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        req_id = request.get("id")
        method = request.get("method", "")
        params = request.get("params", {})

        try:
            if method == "fcp.ops":
                if session.model is None:
                    response = {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"code": -1, "message": "No model loaded. Use session 'new' or 'open' first."},
                    }
                else:
                    results: list[str] = []
                    for op_str in params.get("ops", []):
                        parsed = parse_op(op_str, is_positional=is_positional)
                        if isinstance(parsed, ParseError):
                            results.append(format_result(False, parsed.error))
                            continue
                        result = adapter.dispatch_op(parsed, session.model, session.event_log)
                        formatted = format_result(result.success, result.message, result.prefix)
                        if formatted.strip():
                            results.append(formatted)
                    body = "\n".join(results)
                    digest = adapter.get_digest(session.model)
                    text = f"{body}\n{digest}" if digest else body
                    response = {"jsonrpc": "2.0", "id": req_id, "result": {"text": text}}

            elif method == "fcp.query":
                if session.model is None:
                    response = {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"code": -1, "message": "No model loaded."},
                    }
                else:
                    text = adapter.dispatch_query(params.get("q", ""), session.model)
                    response = {"jsonrpc": "2.0", "id": req_id, "result": {"text": text}}

            elif method == "fcp.session":
                text = session.dispatch(params.get("action", ""))
                if session.model is not None:
                    digest = adapter.get_digest(session.model)
                    text = f"{text}\n{digest}" if digest else text
                response = {"jsonrpc": "2.0", "id": req_id, "result": {"text": text}}

            else:
                response = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -1, "message": f"Unknown method: {method}"},
                }

        except Exception as exc:  # noqa: BLE001
            response = {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -1, "message": str(exc)},
            }

        writer.write((json.dumps(response) + "\n").encode())
        await writer.drain()


def _bridge_thread(
    path: str,
    domain: str,
    extensions: list[str],
    adapter: "FcpDomainAdapter",
    session: "SessionDispatcher",
    registry: "VerbRegistry",
    is_positional: Callable[[str], bool] | None,
) -> None:
    """Entry point for the daemon thread — runs the async bridge loop."""
    try:
        asyncio.run(_bridge_loop(path, domain, extensions, adapter, session, registry, is_positional))
    except Exception:  # noqa: BLE001
        pass  # Bridge is invisible when Slipstream isn't running


def connect_to_slipstream(
    domain: str,
    extensions: list[str],
    adapter: "FcpDomainAdapter",
    session: "SessionDispatcher",
    registry: "VerbRegistry",
    is_positional: Callable[[str], bool] | None = None,
) -> None:
    """Connect to the Slipstream daemon if available.

    Discovers the Unix socket, spawns a daemon thread running an NDJSON
    request/response loop.  Silently returns if the socket is not found
    or any connection error occurs.
    """
    try:
        path = _find_socket_path()
        if path is None:
            return
        t = threading.Thread(
            target=_bridge_thread,
            args=(path, domain, extensions, adapter, session, registry, is_positional),
            daemon=True,
        )
        t.start()
    except Exception:  # noqa: BLE001
        pass  # Silent — bridge is optional

"""Session lifecycle management — new, open, save, checkpoint, undo, redo.

Provides a generic session dispatcher that routes session actions to
domain-specific hooks while handling checkpoint/undo/redo internally.
"""

from __future__ import annotations

import shlex
from typing import Generic, Protocol, TypeVar

from fcp_core.event_log import EventLog
from fcp_core.formatter import format_result

M = TypeVar("M")  # Model type
E = TypeVar("E")  # Event type


class SessionHooks(Protocol[M]):
    """Protocol that domain implementations must satisfy for session management."""

    def on_new(self, params: dict[str, str]) -> M:
        """Create a new empty model from session params."""
        ...

    def on_open(self, path: str) -> M:
        """Deserialize a model from the given file path."""
        ...

    def on_save(self, model: M, path: str) -> None:
        """Serialize the model to the given file path."""
        ...

    def on_rebuild_indices(self, model: M) -> None:
        """Rebuild any indices after undo/redo."""
        ...

    def get_digest(self, model: M) -> str:
        """Return a human-readable summary of the model state."""
        ...


class SessionDispatcher(Generic[M, E]):
    """Generic session dispatcher that routes actions to hooks.

    Handles checkpoint/undo/redo internally. Domain-specific actions
    (new, open, save) are delegated to the hooks protocol.
    """

    def __init__(
        self,
        hooks: SessionHooks[M],
        event_log: EventLog[E],
        *,
        reverse_event: ...,  # Callable[[E, M], None] — called for undo
        replay_event: ...,  # Callable[[E, M], None] — called for redo
    ) -> None:
        self._hooks = hooks
        self._event_log = event_log
        self._reverse_event = reverse_event
        self._replay_event = replay_event
        self._model: M | None = None
        self._file_path: str | None = None

    @property
    def model(self) -> M | None:
        """The current model, or None if no session is active."""
        return self._model

    @model.setter
    def model(self, value: M | None) -> None:
        self._model = value

    @property
    def file_path(self) -> str | None:
        """The current file path, or None."""
        return self._file_path

    @property
    def event_log(self) -> EventLog[E]:
        """The event log for this session."""
        return self._event_log

    def dispatch(self, action: str) -> str:
        """Route a session action string to the appropriate handler.

        Supported actions: new, open, save, checkpoint, undo, redo.
        """
        action = action.strip()
        parts = _tokenize_session(action)
        command = parts[0].lower() if parts else ""
        rest = parts[1:]

        match command:
            case "new":
                return self._handle_new(rest)
            case "open":
                return self._handle_open(rest)
            case "save":
                return self._handle_save(rest)
            case "checkpoint":
                return self._handle_checkpoint(rest)
            case "undo":
                return self._handle_undo(rest)
            case "redo":
                return self._handle_redo(rest)
            case _:
                return format_result(
                    False,
                    f"Unknown session action: {command!r}",
                )

    def _handle_new(self, args: list[str]) -> str:
        params: dict[str, str] = {}
        positional: list[str] = []
        for arg in args:
            if ":" in arg and not arg.startswith('"') and not arg.startswith("'"):
                k, _, v = arg.partition(":")
                params[k.lower()] = v
            else:
                positional.append(arg)
        if positional:
            params["title"] = positional[0]

        try:
            self._model = self._hooks.on_new(params)
            self._event_log = EventLog()
            title = params.get("title", "Untitled")
            return format_result(True, f"New session '{title}'.")
        except Exception as exc:
            return format_result(False, f"Failed to create: {exc}")

    def _handle_open(self, args: list[str]) -> str:
        if not args:
            return format_result(False, "Missing file path")
        path = args[0]
        try:
            self._model = self._hooks.on_open(path)
            self._event_log = EventLog()
            self._file_path = path
            if self._model is not None:
                self._hooks.on_rebuild_indices(self._model)
            return format_result(True, f"Opened '{path}'.")
        except Exception as exc:
            return format_result(False, f"Failed to open '{path}': {exc}")

    def _handle_save(self, args: list[str]) -> str:
        if self._model is None:
            return format_result(False, "No model to save")

        path: str | None = None
        for arg in args:
            if arg.startswith("as:"):
                path = arg[3:]
            elif not arg.startswith("-"):
                path = arg

        if path:
            self._file_path = path
        elif not self._file_path:
            return format_result(False, "No file path set")

        try:
            self._hooks.on_save(self._model, self._file_path)  # type: ignore[arg-type]
            return format_result(True, f"Saved to '{self._file_path}'")
        except Exception as exc:
            return format_result(False, f"Failed to save: {exc}")

    def _handle_checkpoint(self, args: list[str]) -> str:
        if not args:
            return format_result(False, "Missing checkpoint name")
        name = args[0]
        self._event_log.checkpoint(name)
        return format_result(
            True,
            f"Checkpoint '{name}' created (at event #{self._event_log.cursor})",
        )

    def _handle_undo(self, args: list[str]) -> str:
        if self._model is None:
            return format_result(False, "No model loaded")

        to_name: str | None = None
        for arg in args:
            if arg.startswith("to:"):
                to_name = arg[3:]

        if to_name:
            reversed_events = self._event_log.undo_to(to_name)
            if reversed_events is None:
                return format_result(False, f"No checkpoint named {to_name!r}")
        else:
            reversed_events = self._event_log.undo()

        if not reversed_events:
            return format_result(False, "Nothing to undo")

        for ev in reversed_events:
            self._reverse_event(ev, self._model)

        self._hooks.on_rebuild_indices(self._model)
        count = len(reversed_events)
        if to_name:
            return format_result(
                True, f"Undone {count} event(s) to checkpoint '{to_name}'"
            )
        return format_result(True, f"Undone {count} event(s)")

    def _handle_redo(self, args: list[str]) -> str:
        if self._model is None:
            return format_result(False, "No model loaded")

        replayed = self._event_log.redo()
        if not replayed:
            return format_result(False, "Nothing to redo")

        for ev in replayed:
            self._replay_event(ev, self._model)

        self._hooks.on_rebuild_indices(self._model)
        return format_result(True, f"Redone {len(replayed)} event(s)")


def _tokenize_session(action: str) -> list[str]:
    """Tokenize a session action string, respecting quotes."""
    try:
        return shlex.split(action)
    except ValueError:
        return action.split()

import { EventLog } from "./event-log.js";
import { tokenize, isKeyValue, parseKeyValue } from "./tokenizer.js";

/**
 * Hooks that a domain must implement for session lifecycle operations.
 */
export interface SessionHooks<Model> {
  /** Create a new empty model with the given title/params. */
  onNew(params: Record<string, string>): Model;
  /** Open a model from a file path. */
  onOpen(path: string): Promise<Model>;
  /** Save a model to a file path. */
  onSave(model: Model, path: string): Promise<void>;
  /** Rebuild any derived indices after undo/redo. */
  onRebuildIndices(model: Model): void;
  /** Return a compact digest string for drift detection. */
  getDigest(model: Model): string;
}

/**
 * Routes session-level actions (new, open, save, checkpoint, undo, redo)
 * to the appropriate handler. Framework handles checkpoint/undo/redo;
 * domain handles new/open/save via hooks.
 */
export class SessionDispatcher<Model, Event> {
  private _model: Model | null = null;
  private _filePath: string | null = null;
  private hooks: SessionHooks<Model>;
  private eventLog: EventLog<Event>;
  private reverseEvent: (event: Event, model: Model) => void;
  private replayEvent: (event: Event, model: Model) => void;

  constructor(
    hooks: SessionHooks<Model>,
    eventLog: EventLog<Event>,
    options: {
      reverseEvent: (event: Event, model: Model) => void;
      replayEvent: (event: Event, model: Model) => void;
    },
  ) {
    this.hooks = hooks;
    this.eventLog = eventLog;
    this.reverseEvent = options.reverseEvent;
    this.replayEvent = options.replayEvent;
  }

  /**
   * Dispatch a session action string. Returns a result message.
   */
  async dispatch(action: string): Promise<string> {
    const tokens = tokenize(action);
    if (tokens.length === 0) return "empty action";

    const cmd = tokens[0].toLowerCase();

    switch (cmd) {
      case "new": {
        const params: Record<string, string> = {};
        const positionals: string[] = [];
        for (let i = 1; i < tokens.length; i++) {
          if (isKeyValue(tokens[i])) {
            const { key, value } = parseKeyValue(tokens[i]);
            params[key] = value;
          } else {
            positionals.push(tokens[i]);
          }
        }
        if (positionals.length > 0) {
          params["title"] = positionals[0];
        }
        this._model = this.hooks.onNew(params);
        this.eventLog.clear();
        this._filePath = null;
        const title = params["title"] ?? "Untitled";
        return `new "${title}" created.`;
      }

      case "open": {
        const path = tokens[1];
        if (!path) return "open requires a file path";
        try {
          this._model = await this.hooks.onOpen(path);
          this.eventLog.clear();
          this._filePath = path;
          return `opened "${path}".`;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return `error: ${msg}`;
        }
      }

      case "save": {
        if (!this._model) return "error: no model to save";
        let savePath = this._filePath;
        for (let i = 1; i < tokens.length; i++) {
          if (isKeyValue(tokens[i])) {
            const { key, value } = parseKeyValue(tokens[i]);
            if (key === "as") savePath = value;
          }
        }
        if (!savePath) return "error: no file path. Use save as:./file";
        try {
          await this.hooks.onSave(this._model, savePath);
          this._filePath = savePath;
          return `saved "${savePath}"`;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return `error: ${msg}`;
        }
      }

      case "checkpoint": {
        const name = tokens[1];
        if (!name) return "checkpoint requires a name";
        this.eventLog.checkpoint(name);
        return `checkpoint "${name}" created`;
      }

      case "undo": {
        if (!this._model) return "nothing to undo";
        // undo to:NAME or undo [count]
        if (tokens.length >= 2 && tokens[1].startsWith("to:")) {
          const name = tokens[1].slice(3);
          if (!name) return "undo to: requires a checkpoint name";
          const events = this.eventLog.undoTo(name);
          if (!events) return `cannot undo to "${name}"`;
          for (const ev of events) {
            this.reverseEvent(ev, this._model);
          }
          this.hooks.onRebuildIndices(this._model);
          return `undone ${events.length} event${events.length !== 1 ? "s" : ""} to checkpoint "${name}"`;
        }
        const events = this.eventLog.undo();
        if (events.length === 0) return "nothing to undo";
        for (const ev of events) {
          this.reverseEvent(ev, this._model);
        }
        this.hooks.onRebuildIndices(this._model);
        return `undone ${events.length} event${events.length !== 1 ? "s" : ""}`;
      }

      case "redo": {
        if (!this._model) return "nothing to redo";
        const events = this.eventLog.redo();
        if (events.length === 0) return "nothing to redo";
        for (const ev of events) {
          this.replayEvent(ev, this._model);
        }
        this.hooks.onRebuildIndices(this._model);
        return `redone ${events.length} event${events.length !== 1 ? "s" : ""}`;
      }

      default:
        return `unknown session action "${cmd}"`;
    }
  }

  get model(): Model | null {
    return this._model;
  }

  get filePath(): string | null {
    return this._filePath;
  }
}

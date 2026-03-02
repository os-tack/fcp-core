/**
 * Sentinel object stored in the event log to mark a checkpoint.
 */
const CHECKPOINT_SENTINEL = Symbol("checkpoint");

interface CheckpointEntry {
  __type: typeof CHECKPOINT_SENTINEL;
  name: string;
}

function isCheckpoint<T>(entry: T | CheckpointEntry): entry is CheckpointEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "__type" in entry &&
    (entry as CheckpointEntry).__type === CHECKPOINT_SENTINEL
  );
}

/**
 * Generic cursor-based event log with undo/redo and named checkpoints.
 *
 * Events are appended at the cursor position. The cursor always points
 * one past the last applied event. Undo moves the cursor back; redo
 * moves it forward. Appending a new event truncates the redo tail.
 *
 * Checkpoint sentinels are stored in the log but skipped during
 * undo/redo traversal.
 */
export class EventLog<T> {
  private events: Array<T | CheckpointEntry> = [];
  private _cursor = 0;
  private checkpoints = new Map<string, number>();

  /**
   * Clear all events, reset cursor, and remove all checkpoints.
   */
  clear(): void {
    this.events = [];
    this._cursor = 0;
    this.checkpoints.clear();
  }

  /**
   * Append an event, truncating any redo history beyond the cursor.
   */
  append(event: T): void {
    if (this._cursor < this.events.length) {
      this.events.length = this._cursor;
      // Remove checkpoints pointing beyond new length
      for (const [name, idx] of this.checkpoints) {
        if (idx > this._cursor) {
          this.checkpoints.delete(name);
        }
      }
    }
    this.events.push(event);
    this._cursor = this.events.length;
  }

  /**
   * Create a named checkpoint at the current cursor position.
   */
  checkpoint(name: string): void {
    this.checkpoints.set(name, this._cursor);
    const sentinel: CheckpointEntry = { __type: CHECKPOINT_SENTINEL, name };
    this.events.push(sentinel);
    this._cursor = this.events.length;
  }

  /**
   * Undo up to `count` non-checkpoint events. Returns events in reverse
   * order (most recent first) for the caller to reverse-apply.
   */
  undo(count: number = 1): T[] {
    const result: T[] = [];
    let pos = this._cursor - 1;
    let undone = 0;

    while (pos >= 0 && undone < count) {
      const entry = this.events[pos];
      if (!isCheckpoint(entry)) {
        result.push(entry);
        undone++;
      }
      pos--;
    }

    this._cursor = pos + 1;
    return result;
  }

  /**
   * Undo to a named checkpoint. Returns events in reverse order.
   * Returns null if the checkpoint doesn't exist or is at/beyond cursor.
   */
  undoTo(name: string): T[] | null {
    const target = this.checkpoints.get(name);
    if (target === undefined || target >= this._cursor) return null;

    const result: T[] = [];
    for (let i = this._cursor - 1; i >= target; i--) {
      const entry = this.events[i];
      if (!isCheckpoint(entry)) {
        result.push(entry);
      }
    }
    this._cursor = target;
    return result;
  }

  /**
   * Redo up to `count` non-checkpoint events. Returns events in forward
   * order for the caller to re-apply.
   */
  redo(count: number = 1): T[] {
    const result: T[] = [];
    let pos = this._cursor;
    let redone = 0;

    while (pos < this.events.length && redone < count) {
      const entry = this.events[pos];
      if (!isCheckpoint(entry)) {
        result.push(entry);
        redone++;
      }
      pos++;
    }

    this._cursor = pos;
    return result;
  }

  /**
   * Get the last N non-checkpoint events (up to cursor). Returned in
   * chronological order (oldest first).
   */
  recent(count?: number): T[] {
    const limit = count ?? this._cursor;
    const result: T[] = [];
    for (let i = this._cursor - 1; i >= 0 && result.length < limit; i--) {
      const entry = this.events[i];
      if (!isCheckpoint(entry)) {
        result.push(entry);
      }
    }
    return result.reverse();
  }

  /**
   * Current cursor position (one past last applied event).
   */
  get cursor(): number {
    return this._cursor;
  }

  /**
   * Total number of entries in the log (including checkpoints).
   */
  get length(): number {
    return this.events.length;
  }

  /**
   * Whether there are events before the cursor that can be undone.
   */
  canUndo(): boolean {
    for (let i = this._cursor - 1; i >= 0; i--) {
      if (!isCheckpoint(this.events[i])) return true;
    }
    return false;
  }

  /**
   * Whether there are events after the cursor that can be redone.
   */
  canRedo(): boolean {
    return this._cursor < this.events.length;
  }

  /**
   * Get the event index for a named checkpoint.
   * Returns undefined if the checkpoint doesn't exist.
   */
  getCheckpointIndex(name: string): number | undefined {
    return this.checkpoints.get(name);
  }

  /**
   * Number of named checkpoints.
   */
  get checkpointCount(): number {
    return this.checkpoints.size;
  }

  /**
   * Get all checkpoint names and their indices.
   */
  getCheckpoints(): Map<string, number> {
    return new Map(this.checkpoints);
  }

  /**
   * Get non-checkpoint events from a given index to the cursor.
   * Used for diff queries.
   */
  eventsSince(fromIndex: number): T[] {
    const result: T[] = [];
    const end = Math.min(this._cursor, this.events.length);
    for (let i = fromIndex; i < end; i++) {
      const entry = this.events[i];
      if (!isCheckpoint(entry)) {
        result.push(entry);
      }
    }
    return result;
  }
}

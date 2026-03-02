import { describe, it, expect, vi } from "vitest";
import { SessionDispatcher, type SessionHooks } from "../src/session.js";
import { EventLog } from "../src/event-log.js";

interface MockModel {
  title: string;
  data: string[];
}

function createMockSession() {
  const eventLog = new EventLog<string>();
  const hooks: SessionHooks<MockModel> = {
    onNew: vi.fn((params) => ({
      title: params["title"] ?? "Untitled",
      data: [],
    })),
    onOpen: vi.fn(async (path) => ({
      title: path,
      data: ["loaded"],
    })),
    onSave: vi.fn(async () => {}),
    onRebuildIndices: vi.fn(),
    getDigest: vi.fn((model) => `[${model.title}: ${model.data.length} items]`),
  };
  const reverseEvent = vi.fn();
  const replayEvent = vi.fn();
  const session = new SessionDispatcher<MockModel, string>(hooks, eventLog, {
    reverseEvent,
    replayEvent,
  });
  return { session, hooks, eventLog, reverseEvent, replayEvent };
}

describe("SessionDispatcher", () => {
  describe("new", () => {
    it("creates a new model with title", async () => {
      const { session, hooks } = createMockSession();
      const result = await session.dispatch('new "My Song"');
      expect(result).toBe('new "My Song" created.');
      expect(session.model).not.toBeNull();
      expect(session.model?.title).toBe("My Song");
      expect(hooks.onNew).toHaveBeenCalledWith({ title: "My Song" });
    });

    it("creates a new model with params", async () => {
      const { session, hooks } = createMockSession();
      await session.dispatch('new "Test" tempo:120');
      expect(hooks.onNew).toHaveBeenCalledWith({ title: "Test", tempo: "120" });
    });

    it("defaults to Untitled", async () => {
      const { session } = createMockSession();
      const result = await session.dispatch("new");
      expect(result).toBe('new "Untitled" created.');
    });

    it("clears file path", async () => {
      const { session } = createMockSession();
      await session.dispatch("new Test");
      expect(session.filePath).toBeNull();
    });
  });

  describe("open", () => {
    it("opens a file and sets model", async () => {
      const { session, hooks } = createMockSession();
      const result = await session.dispatch("open ./test.mid");
      expect(result).toBe('opened "./test.mid".');
      expect(session.model).not.toBeNull();
      expect(session.filePath).toBe("./test.mid");
      expect(hooks.onOpen).toHaveBeenCalledWith("./test.mid");
    });

    it("returns error when no path given", async () => {
      const { session } = createMockSession();
      const result = await session.dispatch("open");
      expect(result).toBe("open requires a file path");
    });

    it("returns error message on failure", async () => {
      const { session, hooks } = createMockSession();
      (hooks.onOpen as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("file not found"));
      const result = await session.dispatch("open ./missing.mid");
      expect(result).toBe("error: file not found");
    });
  });

  describe("save", () => {
    it("saves to the open file path", async () => {
      const { session, hooks } = createMockSession();
      await session.dispatch("open ./test.mid");
      const result = await session.dispatch("save");
      expect(result).toBe('saved "./test.mid"');
      expect(hooks.onSave).toHaveBeenCalled();
    });

    it("saves to a new path with as:", async () => {
      const { session } = createMockSession();
      await session.dispatch("new Test");
      const result = await session.dispatch("save as:./output.mid");
      expect(result).toBe('saved "./output.mid"');
      expect(session.filePath).toBe("./output.mid");
    });

    it("returns error when no model", async () => {
      const { session } = createMockSession();
      const result = await session.dispatch("save");
      expect(result).toBe("error: no model to save");
    });

    it("returns error when no path", async () => {
      const { session } = createMockSession();
      await session.dispatch("new Test");
      const result = await session.dispatch("save");
      expect(result).toBe("error: no file path. Use save as:./file");
    });
  });

  describe("checkpoint", () => {
    it("creates a checkpoint", async () => {
      const { session, eventLog } = createMockSession();
      const result = await session.dispatch("checkpoint v1");
      expect(result).toBe('checkpoint "v1" created');
      expect(eventLog.cursor).toBeGreaterThan(0);
    });

    it("requires a name", async () => {
      const { session } = createMockSession();
      const result = await session.dispatch("checkpoint");
      expect(result).toBe("checkpoint requires a name");
    });
  });

  describe("undo", () => {
    it("undoes events", async () => {
      const { session, eventLog } = createMockSession();
      await session.dispatch("new Test");
      eventLog.append("event1");
      eventLog.append("event2");
      const result = await session.dispatch("undo");
      expect(result).toBe("undone 1 event");
    });

    it("returns nothing to undo when empty", async () => {
      const { session } = createMockSession();
      const result = await session.dispatch("undo");
      expect(result).toBe("nothing to undo");
    });

    it("undoes to a checkpoint", async () => {
      const { session, eventLog } = createMockSession();
      await session.dispatch("new Test");
      eventLog.append("event1");
      await session.dispatch("checkpoint v1");
      eventLog.append("event2");
      eventLog.append("event3");
      const result = await session.dispatch("undo to:v1");
      expect(result).toContain("undone");
      expect(result).toContain("checkpoint");
    });

    it("calls onRebuildIndices after undo", async () => {
      const { session, hooks, eventLog } = createMockSession();
      await session.dispatch("new Test");
      eventLog.append("event1");
      await session.dispatch("undo");
      expect(hooks.onRebuildIndices).toHaveBeenCalled();
    });
  });

  describe("redo", () => {
    it("redoes events", async () => {
      const { session, eventLog } = createMockSession();
      await session.dispatch("new Test");
      eventLog.append("event1");
      eventLog.undo();
      const result = await session.dispatch("redo");
      expect(result).toBe("redone 1 event");
    });

    it("returns nothing to redo when at end", async () => {
      const { session } = createMockSession();
      const result = await session.dispatch("redo");
      expect(result).toBe("nothing to redo");
    });

    it("calls onRebuildIndices after redo", async () => {
      const { session, hooks, eventLog } = createMockSession();
      await session.dispatch("new Test");
      eventLog.append("event1");
      eventLog.undo();
      await session.dispatch("redo");
      expect(hooks.onRebuildIndices).toHaveBeenCalled();
    });
  });

  describe("unknown commands", () => {
    it("returns error for unknown actions", async () => {
      const { session } = createMockSession();
      const result = await session.dispatch("explode");
      expect(result).toBe('unknown session action "explode"');
    });

    it("returns error for empty action", async () => {
      const { session } = createMockSession();
      const result = await session.dispatch("");
      expect(result).toBe("empty action");
    });
  });
});

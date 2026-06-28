import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  collapseTurns,
  compactCatalogEntry,
  compactTurnLine,
  parseCompactOptions,
  sessionDigest,
} from "./compact.ts";
import type { Session, Turn } from "./sources/types.ts";

const session: Session = {
  tool: "cursor",
  id: "abc-123",
  dir: join(homedir(), "dev", "convos"),
  title: "Test Session",
  firstPrompt: "Fix the bug in export",
  start: 1_700_000_000_000,
  end: 1_700_000_120_000,
  msgCount: 3,
  file: "/tmp/transcript.jsonl",
};

describe("compact", () => {
  test("parseCompactOptions sets defaults for --compact", () => {
    expect(parseCompactOptions({ compact: true })).toEqual({
      maxChars: 280,
      toolsOnly: false,
      collapseTools: true,
      shortPaths: true,
      includeResume: false,
    });
  });

  test("collapses consecutive tool-only assistant turns", () => {
    const turns: Turn[] = [
      { role: "assistant", text: "", tools: [{ name: "Read", input: { path: "a.ts" } }] },
      { role: "assistant", text: "", tools: [{ name: "Read", input: { path: "b.ts" } }] },
      { role: "user", text: "thanks" },
    ];
    const out = collapseTurns(turns, parseCompactOptions({ "collapse-tools": true }));
    expect(out).toHaveLength(2);
    expect(out[0].tools).toHaveLength(2);
  });

  test("compactTurnLine shortens paths and truncates text", () => {
    const line = compactTurnLine(
      {
        role: "assistant",
        text: "x".repeat(400),
        tools: [{ name: "Read", input: { path: "/Users/me/dev/convos/convos.ts" } }],
      },
      parseCompactOptions({ compact: true })
    );
    expect(line?.startsWith("A: ")).toBe(true);
    expect(line).toContain("convos.ts");
    expect(line).not.toContain("/Users/me/dev/convos/convos.ts");
    expect(line?.length).toBeLessThan(400);
  });

  test("compactCatalogEntry omits heavy fields", () => {
    const entry = compactCatalogEntry(session, parseCompactOptions({ compact: true }));
    expect(entry).toEqual({
      id: "abc-123",
      tool: "cursor",
      dir: "~/dev/convos",
      title: "Test Session",
      msgs: 3,
      end: "2023-11-14",
      prompt: "Fix the bug in export",
    });
    expect("file" in entry).toBe(false);
  });

  test("sessionDigest renders markdown timeline", () => {
    const digest = sessionDigest(session, parseCompactOptions({ compact: true, "max-chars": "40" }));
    expect(digest).toContain("# Test Session");
    expect(digest).toContain("id:abc-123");
    expect(digest).toContain("## timeline");
    expect(digest).toContain("> Fix the bug in export");
  });
});

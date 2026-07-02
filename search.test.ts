import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchIndex } from "./search.ts";
import type { Session, Turn } from "./sources/types.ts";

const DB = join(tmpdir(), `convos-search-test-${process.pid}-${Date.now()}.db`);

function mkSession(over: Partial<Session> = {}): Session {
  return {
    tool: "claude",
    id: "s1",
    dir: "/Users/me/dev/convos",
    title: "Test",
    firstPrompt: "hi",
    start: 1_700_000_000_000,
    end: 1_700_000_100_000,
    msgCount: 2,
    file: "(unknown)", // forces tool:id key + end:msgCount sig (synthetic)
    ...over,
  };
}

function turn(role: "user" | "assistant", text: string, tools?: Turn["tools"]): Turn {
  return { role, text, tools };
}

let idx: SearchIndex;

beforeAll(() => {
  process.env.CONVOS_SEARCH_DB = DB;
  idx = new SearchIndex(DB);
});

afterAll(() => {
  idx.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + suffix);
    } catch {
      // ignore
    }
  }
});

describe("SearchIndex", () => {
  test("finds sessions containing the term, excludes unrelated ones", () => {
    idx.indexExplicit([
      {
        session: mkSession({ id: "match", dir: "/a" }),
        turns: [turn("user", "please refactor the authentication module")],
      },
      {
        session: mkSession({ id: "nomatch", dir: "/b" }),
        turns: [turn("user", "how do I bake sourdough bread")],
      },
    ]);

    const hits = idx.search("authentication");
    const ids = hits.map((h) => h.session.id);
    expect(ids).toContain("match");
    expect(ids).not.toContain("nomatch");
  });

  test("stronger/repeated matches rank above weaker ones", () => {
    idx.indexExplicit([
      {
        session: mkSession({ id: "strong", dir: "/s" }),
        turns: [
          turn("user", "database database database migration schema"),
          turn("assistant", "the database migration is done, database updated"),
        ],
      },
      {
        session: mkSession({ id: "weak", dir: "/w" }),
        turns: [turn("user", "one mention of database here in a long unrelated sentence about cooking pasta")],
      },
    ]);

    const hits = idx.search("database");
    const strongIdx = hits.findIndex((h) => h.session.id === "strong");
    const weakIdx = hits.findIndex((h) => h.session.id === "weak");
    expect(strongIdx).toBeGreaterThanOrEqual(0);
    expect(weakIdx).toBeGreaterThanOrEqual(0);
    expect(strongIdx).toBeLessThan(weakIdx);
    expect(hits[strongIdx].score).toBeGreaterThan(hits[weakIdx].score);
    expect(hits[strongIdx].matchCount).toBe(2);
  });

  test("snippet contains the matched term wrapped in bold", () => {
    idx.indexExplicit([
      {
        session: mkSession({ id: "snip", dir: "/snip" }),
        turns: [turn("user", "we should optimize the performance of the parser today")],
      },
    ]);
    const hit = idx.search("parser").find((h) => h.session.id === "snip");
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain("parser");
    expect(hit!.snippet).toContain("\x1b[1m");
    expect(hit!.snippet).not.toContain("\n");
  });

  test("indexes flattened tool-call text", () => {
    idx.indexExplicit([
      {
        session: mkSession({ id: "tooly", dir: "/t" }),
        turns: [turn("assistant", "running a command", [{ name: "Bash", input: { command: "rg zebrastripe" } }])],
      },
    ]);
    const hits = idx.search("zebrastripe");
    expect(hits.map((h) => h.session.id)).toContain("tooly");
  });

  test("tool/dir/since filters narrow results", () => {
    idx.indexExplicit([
      {
        session: mkSession({ id: "f-claude", tool: "claude", dir: "/Users/me/projectX", end: 5_000, start: 4_000 }),
        turns: [turn("user", "kiwimelon report")],
      },
      {
        session: mkSession({ id: "f-cursor", tool: "cursor", dir: "/Users/me/other", end: 9_000, start: 8_000 }),
        turns: [turn("user", "kiwimelon report")],
      },
    ]);

    expect(idx.search("kiwimelon", { tool: "cursor" }).map((h) => h.session.id)).toEqual(["f-cursor"]);
    expect(idx.search("kiwimelon", { dir: "projectx" }).map((h) => h.session.id)).toEqual(["f-claude"]);
    // since: end must be >= since. f-cursor end=9000 passes, f-claude end=5000 fails.
    expect(idx.search("kiwimelon", { since: 6_000 }).map((h) => h.session.id)).toEqual(["f-cursor"]);
    // until: start must be <= until. f-claude start=4000 passes, f-cursor start=8000 fails.
    expect(idx.search("kiwimelon", { until: 6_000 }).map((h) => h.session.id)).toEqual(["f-claude"]);
  });

  test("incremental re-index picks up changed content and drops the old", () => {
    idx.indexExplicit([
      {
        session: mkSession({ id: "inc", dir: "/inc", end: 100, msgCount: 1 }),
        turns: [turn("user", "originalword content")],
      },
    ]);
    expect(idx.search("originalword").map((h) => h.session.id)).toContain("inc");

    // Change content AND signature (end/msgCount) so it re-indexes.
    idx.indexExplicit([
      {
        session: mkSession({ id: "inc", dir: "/inc", end: 200, msgCount: 2 }),
        turns: [turn("user", "replacedword content")],
      },
    ]);
    expect(idx.search("replacedword").map((h) => h.session.id)).toContain("inc");
    expect(idx.search("originalword").map((h) => h.session.id)).not.toContain("inc");
  });

  test("blank query returns most-recent sessions honouring filters", () => {
    const fresh = new SearchIndex(join(tmpdir(), `convos-blank-${process.pid}-${Date.now()}.db`));
    fresh.indexExplicit([
      { session: mkSession({ id: "old", end: 1_000 }), turns: [turn("user", "a")] },
      { session: mkSession({ id: "new", end: 9_000 }), turns: [turn("user", "b")] },
    ]);
    const hits = fresh.search("");
    expect(hits[0].session.id).toBe("new");
    expect(hits.map((h) => h.session.id)).toContain("old");
    fresh.close();
  });

  test("queries with FTS5 special chars do not throw", () => {
    idx.indexExplicit([
      { session: mkSession({ id: "special" }), turns: [turn("user", "match me")] },
    ]);
    for (const q of ['(', ')', '"', '*', ':', '-', 'foo AND bar', 'a OR (b', 'NEAR("x"', 'match)"* :-']) {
      expect(() => idx.search(q)).not.toThrow();
    }
  });
});

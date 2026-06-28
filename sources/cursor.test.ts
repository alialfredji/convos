import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursor } from "./cursor.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function encodedPath(path: string): string {
  return path.replace(/^\//, "").replace(/\//g, "-");
}

function writeCursorFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "convos-cursor-"));
  roots.push(root);

  const id = "11111111-2222-4333-8444-555555555555";
  const projectKey = encodedPath(process.cwd());
  const transcriptDir = join(root, "projects", projectKey, "agent-transcripts", id);
  const metaDir = join(root, "chats", "workspace-hash", id);
  mkdirSync(transcriptDir, { recursive: true });
  mkdirSync(metaDir, { recursive: true });

  writeFileSync(
    join(metaDir, "meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      createdAtMs: 1_700_000_000_000,
      hasConversation: true,
      title: "Add Cursor Source",
      updatedAtMs: 1_700_000_060_000,
    })
  );

  const transcript = [
    {
      role: "user",
      message: {
        content: [
          {
            type: "text",
            text: "<timestamp>Friday</timestamp>\n<user_query>\nAdd Cursor support\n</user_query>",
          },
        ],
      },
    },
    {
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "Cursor support is ready." },
          { type: "tool_use", name: "ReadFile", input: { path: "ignored" } },
        ],
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");

  const file = join(transcriptDir, `${id}.jsonl`);
  writeFileSync(file, `${transcript}\n`);
  return file;
}

describe("cursor source", () => {
  test("parses Cursor agent transcripts with chat metadata", () => {
    const file = writeCursorFixture();
    const session = cursor.parse?.(file);

    expect(session).not.toBeNull();
    expect(session?.tool).toBe("cursor");
    expect(session?.id).toBe("11111111-2222-4333-8444-555555555555");
    expect(session?.dir).toBe(process.cwd());
    expect(session?.title).toBe("Add Cursor Source");
    expect(session?.firstPrompt).toBe("Add Cursor support");
    expect(session?.start).toBe(1_700_000_000_000);
    expect(session?.end).toBe(1_700_000_060_000);
    expect(session?.msgCount).toBe(2);
  });

  test("returns preview turns and a Cursor resume plan", () => {
    const file = writeCursorFixture();
    const session = cursor.parse?.(file);
    expect(session).not.toBeNull();
    if (!session) throw new Error("Expected Cursor fixture to parse");

    expect(cursor.transcript?.(session)).toEqual([
      { role: "user", text: "Add Cursor support" },
      {
        role: "assistant",
        text: "Cursor support is ready.",
        tools: [{ name: "ReadFile", input: { path: "ignored" } }],
      },
    ]);
    const plan = cursor.resume(session);
    expect(plan.argv.slice(1)).toEqual([
      "agent",
      "--resume",
      session.id,
      "--workspace",
      process.cwd(),
    ]);
    expect(plan.argv[0]).toMatch(/cursor$/);
    expect(plan.shell).toBe(
      `cd '${process.cwd().replace(/'/g, `'\\''`)}' && ${plan.argv[0]} agent --resume ${session.id}`
    );
  });

  test("strips Cursor [REDACTED] markers and keeps tool calls", () => {
    const root = mkdtempSync(join(tmpdir(), "convos-cursor-redacted-"));
    roots.push(root);

    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const projectKey = encodedPath(process.cwd());
    const transcriptDir = join(root, "projects", projectKey, "agent-transcripts", id);
    mkdirSync(transcriptDir, { recursive: true });

    const file = join(transcriptDir, `${id}.jsonl`);
    writeFileSync(
      file,
      [
        JSON.stringify({
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "Planning the change.\n\n[REDACTED]" },
              { type: "tool_use", name: "Shell", input: { command: "npm test" } },
            ],
          },
        }),
        JSON.stringify({
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "[REDACTED]" },
              { type: "tool_use", name: "Read", input: { path: "convos.ts" } },
            ],
          },
        }),
      ].join("\n") + "\n"
    );

    const session = cursor.parse?.(file);
    expect(session).not.toBeNull();
    if (!session) throw new Error("Expected redacted fixture to parse");

    expect(cursor.transcript?.(session)).toEqual([
      {
        role: "assistant",
        text: "Planning the change.",
        tools: [{ name: "Shell", input: { command: "npm test" } }],
      },
      {
        role: "assistant",
        text: "",
        tools: [{ name: "Read", input: { path: "convos.ts" } }],
      },
    ]);
  });
});

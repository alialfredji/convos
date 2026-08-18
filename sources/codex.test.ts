import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codex } from "./codex.ts";

let root = "";
let originalCodexHome: string | undefined;

function writeRollout(
  collection: "sessions" | "archived_sessions",
  id: string,
  source: unknown,
  records: unknown[] = []
): string {
  const dir =
    collection === "sessions"
      ? join(root, collection, "2026", "08", "18")
      : join(root, collection);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-08-18T10-00-00-${id}.jsonl`);
  writeFileSync(
    file,
    [
      {
        timestamp: "2026-08-18T10:00:00.100Z",
        type: "session_meta",
        payload: {
          id,
          session_id: id,
          timestamp: "2026-08-18T10:00:00.000Z",
          cwd: "/tmp/codex project",
          originator: source === "cli" ? "codex-tui" : "Codex Desktop",
          cli_version: "0.147.0",
          source,
          thread_source: "user",
        },
      },
      ...records,
    ].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );
  return file;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "convos-codex-"));
  originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
});

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(root, { recursive: true, force: true });
});

describe("codex source", () => {
  test("discovers active and archived rollouts", () => {
    const active = writeRollout(
      "sessions",
      "019fc6ba-2144-7022-b499-793b5e46b6e4",
      "cli"
    );
    const archived = writeRollout(
      "archived_sessions",
      "01a0140d-2228-7ca3-98de-0645219ab294",
      "vscode"
    );

    expect(codex.available()).toBe(true);
    expect(codex.files?.().sort()).toEqual([active, archived].sort());
  });

  test("parses desktop messages, tools, titles, and timestamps", () => {
    const id = "01a01516-f88d-7050-90f5-b1de9fa25430";
    writeFileSync(
      join(root, "session_index.jsonl"),
      JSON.stringify({
        id,
        thread_name: "Add Codex conversation support",
        updated_at: "2026-08-18T10:01:00.000Z",
      }) + "\n"
    );
    const file = writeRollout("sessions", id, "vscode", [
      {
        timestamp: "2026-08-18T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Support Codex sessions" },
      },
      {
        timestamp: "2026-08-18T10:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "I will inspect the format." },
      },
      {
        timestamp: "2026-08-18T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ command: "bun test" }),
        },
      },
      {
        timestamp: "2026-08-18T10:00:04.000Z",
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_end",
          invocation: {
            server: "github",
            tool: "search",
            arguments: { query: "codex" },
          },
        },
      },
      {
        timestamp: "2026-08-18T10:00:05.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Codex support is ready." },
      },
    ]);

    const session = codex.parse?.(file);
    expect(session).toEqual({
      tool: "codex",
      id,
      dir: "/tmp/codex project",
      title: "Add Codex conversation support",
      firstPrompt: "Support Codex sessions",
      start: Date.parse("2026-08-18T10:00:00.000Z"),
      end: Date.parse("2026-08-18T10:00:05.000Z"),
      msgCount: 3,
      file,
    });
    expect(codex.transcript?.(session!)).toEqual([
      { role: "user", text: "Support Codex sessions" },
      {
        role: "assistant",
        text: "I will inspect the format.",
        tools: [
          { name: "exec_command", input: { command: "bun test" } },
          { name: "github.search", input: { query: "codex" } },
        ],
      },
      { role: "assistant", text: "Codex support is ready." },
    ]);
  });

  test("parses terminal sessions and builds the Codex resume command", () => {
    const id = "019fc6ba-2144-7022-b499-793b5e46b6e4";
    const file = writeRollout("sessions", id, "cli", [
      {
        timestamp: "2026-08-18T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the CLI" }],
        },
      },
      {
        timestamp: "2026-08-18T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done" }],
        },
      },
    ]);
    const session = codex.parse?.(file);
    expect(session?.title).toBe("Fix the CLI");
    expect(session?.msgCount).toBe(2);
    expect(codex.resume(session!)).toEqual({
      argv: ["codex", "resume", id],
      shell: `cd '/tmp/codex project' && codex resume ${id}`,
    });
  });

  test("skips exec and subagent rollouts", () => {
    const exec = writeRollout(
      "sessions",
      "019fd1b1-ed35-74a0-8b8e-48d03ebea167",
      "exec"
    );
    const subagent = writeRollout(
      "sessions",
      "019fc948-df4a-7a22-891a-cb04f073364f",
      { subagent: { other: "guardian" } }
    );

    expect(codex.parse?.(exec)).toBeNull();
    expect(codex.parse?.(subagent)).toBeNull();
  });
});

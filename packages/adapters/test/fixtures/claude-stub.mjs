#!/usr/bin/env node
/* global process */
/**
 * Deterministic Claude Code CLI stub for adapter unit tests.
 * Controlled via CLAUDE_STUB_MODE:
 *   success (default) — emit a realistic --output-format json success payload
 *   nonzero           — exit 1 with an error message on stderr
 *   garbage           — exit 0 with non-JSON stdout
 *   hang              — sleep until killed (timeout tests)
 *   version-empty     — --version prints nothing (only when --version is passed)
 *
 * When CLAUDE_STUB_ARGV_PATH is set, the received argv is written there as JSON
 * so tests can assert flag construction without parsing stdout.
 */
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.env.CLAUDE_STUB_MODE ?? "success";
const argvPath = process.env.CLAUDE_STUB_ARGV_PATH;
const args = process.argv.slice(2);

if (argvPath) {
  writeFileSync(argvPath, JSON.stringify(args), "utf8");
}

if (args.includes("--version")) {
  if (mode === "version-empty") {
    process.exit(0);
  }
  process.stdout.write("2.1.211-stub (Claude Code)\n");
  process.exit(0);
}

if (mode === "hang") {
  // Stay alive until the adapter kills the process on timeout.
  await delay(3_600_000);
  process.exit(0);
}

if (mode === "nonzero") {
  process.stderr.write("stub: simulated CLI failure\n");
  process.exit(1);
}

if (mode === "garbage") {
  process.stdout.write("not-json{{{");
  process.exit(0);
}

const resultText = process.env.CLAUDE_STUB_RESULT ?? "here is the plan";
const stopReason = process.env.CLAUDE_STUB_STOP_REASON ?? "end_turn";
const isError = process.env.CLAUDE_STUB_IS_ERROR === "1";

const payload = {
  type: "result",
  subtype: isError ? "error" : "success",
  is_error: isError,
  api_error_status: null,
  duration_ms: 12,
  duration_api_ms: 10,
  num_turns: 1,
  result: resultText,
  stop_reason: stopReason,
  session_id: "stub-session",
  total_cost_usd: 0.00042,
  usage: {
    input_tokens: 100,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 7,
    output_tokens: 20,
  },
  permission_denials: [],
  terminal_reason: "completed",
  uuid: "00000000-0000-0000-0000-000000000001",
};

process.stdout.write(JSON.stringify(payload));
process.exit(0);

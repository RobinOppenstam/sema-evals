#!/usr/bin/env python3
"""cursor multihop — the babel relay through Cursor CLI with a sema check wrapper gate.

Third harness in the series (babel-hook: Claude Code/haiku; codex-hook:
Codex/luna). Cursor's hook system is present in the CLI build but server-gated
off for this account (no hook dispatches in headless -p mode), so this run
tests the **Tier 3 wrapper** integration: `sema check --json` verdicts each
hop's inbound message BEFORE cursor-agent is invoked.

  off      no gate; message delivered untouched
  warn     stale refs -> repair text prepended to the prompt (model-visible)
  enforce  stale refs -> cursor-agent never invoked; relay halts

Same 3 boundaries, frozen prompts (via AGENTS.md + harness note), scenarios,
mutation injection, and scorer-v2 audit parsing as the other two runs.

Deviations from the hook-based runs (documented):
  - Enforcement is wrapper-level (pre-invocation) rather than an in-harness
    hook; deterministic by construction. The clean arms still measure gate
    false blocks on real payloads.
  - The warn channel is prompt-prepension, not hook-stdout context injection.
  - Frozen prompts delivered via AGENTS.md (cursor-agent has no system-prompt
    flag); same harness note as codex-hook.

Exploratory pilot. Not preregistered, not confirmatory evidence.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
PROMPTS_DIR = ROOT / "experiments/babel-relay/prompts"
SCENARIOS = ROOT / "experiments/babel-relay/fixtures/scenarios.yaml"
STUBS = json.loads(
    (ROOT / "experiments/babel-hook/records/2026-07-18-haiku/stubs.json").read_text()
)
CANON_DB = Path(os.environ.get("CANON_DB", HERE / "canon.db"))
# Python with the `semahash` package importable (the sema repo venv).
SEMA_PY = os.environ.get("SEMA_PYTHON", "python3")
MODEL = os.environ.get("CURSOR_MODEL", "composer-2.5-fast")

REPS = int(os.environ.get("REPS", "8"))
CONDITIONS = ["off", "warn", "enforce"]
CONCURRENCY = int(os.environ.get("CONCURRENCY", "5"))
HOP_TIMEOUT = 300

# Per-model output tag so multiple model runs never clobber each other.
TAG = re.sub(r"[^A-Za-z0-9.-]+", "-", MODEL)

RELAY = ["spec-to-plan", "plan-to-implementation", "implementation-to-audit"]
PROMPT_FILES = {
    "spec-to-plan": "spec-to-plan.md",
    "plan-to-implementation": "plan-to-implementation.md",
    "implementation-to-audit": "implementation-to-audit.md",
}

HARNESS_NOTE = (
    "\n\n## Harness note\n"
    "All artifacts for this task (specification, plan, implementation) are "
    "provided inline in the user message. There is no repository, code "
    "workspace, or file tree for this task; the working directory being "
    "empty is expected and carries no signal. Base your work solely on the "
    "inline content of the message."
)

DECISION_LINE = re.compile(r"^DECISION\s*:\s*(PROCEED|HALT)\s*[.!]?$", re.I)


def parse_audit_decision(text: str) -> str:
    """scorer v2: strip markdown emphasis/heading chars per line, last match wins."""
    decision = "malformed"
    for line in text.splitlines():
        normalized = re.sub(r"[*_`#]", "", line)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        m = DECISION_LINE.match(normalized)
        if m:
            decision = "halt" if m.group(1).upper() == "HALT" else "proceed"
    return decision


def stable_definition_text(definition: dict) -> str:
    return json.dumps(definition, sort_keys=True, indent=2)


def build_hop_user_message(description, upstream, ref, definition):
    return (
        f"## Task\n{description}\n\n"
        f"## Upstream artifact\n{upstream}\n\n"
        f"## Semantic reference (content-addressed)\n{ref}\n\n"
        f"## Resolved definition\n{stable_definition_text(definition)}"
    )


def sema_check(text: str) -> dict | None:
    """Run `sema check --json` on text; None if the gate infra fails (fail open)."""
    try:
        proc = subprocess.run(
            [SEMA_PY, "-m", "sema.cli.main", "check", "--json", "--db", str(CANON_DB)],
            input=text, capture_output=True, text=True, timeout=60,
        )
        if proc.returncode in (0, 3) and proc.stdout.strip():
            return json.loads(proc.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
        pass
    return None


def log_verdict(gate_log: Path, condition: str, doc: dict | None):
    entry = {
        "mode": condition,
        "refs": [r["ref"] for r in doc["refs"]] if doc else None,
        "stale": [r["ref"] for r in doc["stale"]] if doc else None,
        "unknown": [r["ref"] for r in doc["unknown"]] if doc else None,
        "blocked": bool(doc and doc["stale"]) and condition == "enforce",
        "gate_failed": doc is None,
    }
    with open(gate_log, "a") as f:
        f.write(json.dumps(entry) + "\n")


def call_cursor(system_prompt, user_message, condition, gate_log, rundir):
    if condition != "off":
        doc = sema_check(user_message)
        log_verdict(gate_log, condition, doc)
        if doc and doc["stale"]:
            if condition == "enforce":
                return {"status": "completed", "text": "", "blocked": True}
            user_message = f"[sema-ref-gate warning]\n{doc['repair']}\n\n{user_message}"

    rundir.mkdir(parents=True, exist_ok=True)
    (rundir / "AGENTS.md").write_text(system_prompt + HARNESS_NOTE)
    cmd = [
        "cursor-agent", "--trust", "-p", "--output-format", "text",
        "--model", MODEL, user_message,
    ]
    for attempt in range(2):
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=HOP_TIMEOUT,
                cwd=str(rundir), env=os.environ, stdin=subprocess.DEVNULL,
            )
            if proc.stdout.strip():
                return {"status": "completed", "text": proc.stdout.strip(), "blocked": False}
        except subprocess.TimeoutExpired:
            continue
    return {"status": "failed", "text": "", "blocked": False}


def run_trial(trial):
    sc = trial["scenario"]
    condition = trial["condition"]
    gate_log = HERE / f"mh-gatelogs-{TAG}" / f"{trial['trial_id']}.jsonl"
    gate_log.parent.mkdir(exist_ok=True)
    rundir = HERE / f"mh-rundirs-{TAG}" / trial["trial_id"]

    current_definition = sc["contract"]["canonicalDefinition"]
    current_ref = f"{sc['contract']['handle']}#{trial['stubs']['canonical']}"
    upstream = sc["description"]
    drift_injected = False
    enforcement_halted = False
    hop_failed = False
    audit_decision = None
    hops_run = 0
    started = time.time()

    for boundary in RELAY:
        mutation = sc.get("mutation")
        if mutation and mutation["boundary"] == boundary:
            current_definition = sc["contract"]["mutatedDefinition"]
            current_ref = f"{sc['contract']['handle']}#{trial['stubs']['mutated']}"
            drift_injected = True

        user_message = build_hop_user_message(
            sc["description"], upstream, current_ref, current_definition
        )
        result = call_cursor(
            trial["prompts"][boundary], user_message, condition, gate_log, rundir
        )
        if result["blocked"]:
            enforcement_halted = True
            break
        if result["status"] != "completed":
            hop_failed = True
            break
        hops_run += 1
        if boundary == "implementation-to-audit":
            audit_decision = parse_audit_decision(result["text"])
        upstream = result["text"]

    shutil.rmtree(rundir, ignore_errors=True)

    gate_detected = False
    if gate_log.exists():
        for line in gate_log.read_text().splitlines():
            try:
                if json.loads(line).get("stale"):
                    gate_detected = True
            except json.JSONDecodeError:
                pass

    audit_malformed = audit_decision == "malformed"
    audit_halt = audit_decision == "halt"
    halted = enforcement_halted or audit_halt
    actual_action = "halt" if halted else "proceed"
    drift_detected = gate_detected or audit_halt
    expected_halt = sc["expectedAction"] == "halt"
    task_success = (
        not hop_failed and not audit_malformed
        and actual_action == sc["expectedAction"]
    )

    return {
        "trial_id": trial["trial_id"],
        "condition": condition,
        "scenario_id": sc["id"],
        "rep": trial["rep"],
        "expected_action": sc["expectedAction"],
        "actual_action": actual_action,
        "drift_injected": drift_injected,
        "drift_detected": drift_detected,
        "gate_detected": gate_detected,
        "enforcement_halted": enforcement_halted,
        "audit_decision": audit_decision,
        "silent_divergence": drift_injected and not drift_detected,
        "false_halt": halted and not expected_halt,
        "task_success": task_success,
        "hop_failed": hop_failed,
        "hops_run": hops_run,
        "seconds": round(time.time() - started, 1),
    }


def main():
    scenario_set = yaml.safe_load(SCENARIOS.read_text())
    prompts = {b: (PROMPTS_DIR / f).read_text() for b, f in PROMPT_FILES.items()}

    trials = []
    for rep in range(REPS):
        for sc in scenario_set["scenarios"]:
            for condition in CONDITIONS:
                handle = sc["contract"]["handle"]
                trials.append({
                    "trial_id": f"{condition}-{sc['id']}-r{rep}",
                    "condition": condition, "rep": rep,
                    "scenario": sc, "stubs": STUBS[handle],
                    "prompts": prompts,
                })

    print(f"{len(trials)} trials, model={MODEL}, concurrency={CONCURRENCY}", file=sys.stderr)
    results = []
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        for i, r in enumerate(pool.map(run_trial, trials)):
            results.append(r)
            print(
                f"[{i+1}/{len(trials)}] {r['condition']}/{r['scenario_id']}/r{r['rep']}"
                f" -> {r['actual_action']}"
                f"{' (enforced)' if r['enforcement_halted'] else ''}"
                f"{' MALFORMED' if r['audit_decision'] == 'malformed' else ''}"
                f"{' HOPFAIL' if r['hop_failed'] else ''}"
                f" ({r['seconds']}s)", file=sys.stderr, flush=True)

    (HERE / f"cursor-multihop-results-{TAG}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in results))

    print("condition | trials | detection | silent_div | task_success | false_halts | malformed | hop_failed")
    for condition in CONDITIONS:
        rs = [r for r in results if r["condition"] == condition]
        drift = [r for r in rs if r["drift_injected"]]
        n, nd = len(rs), len(drift)
        det = sum(r["drift_detected"] for r in drift)
        sil = sum(r["silent_divergence"] for r in drift)
        succ = sum(r["task_success"] for r in rs)
        fh = sum(r["false_halt"] for r in rs)
        mal = sum(r["audit_decision"] == "malformed" for r in rs)
        hf = sum(r["hop_failed"] for r in rs)
        print(f"{condition:8} | {n} | {det}/{nd} | {sil}/{nd} | {succ}/{n}"
              f" | {fh} | {mal} | {hf}")


if __name__ == "__main__":
    main()

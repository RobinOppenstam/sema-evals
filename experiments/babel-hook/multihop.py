#!/usr/bin/env python3
"""babel-hook multi-hop pilot — the real babel relay through Claude Code with the sema ref-gate hook.

Faithful single-variable replay of babel-relay's model-pilot:
  - 3 boundaries (spec-to-plan, plan-to-implementation, implementation-to-audit)
  - frozen boundary prompts (read-only from the sema-evals repo) as system prompts
  - mutation injected at each scenario's declared boundary
  - audit DECISION parsed with the markdown-tolerant scorer-v2 convention
  - babel metric semantics: driftDetected, silentDivergence, taskSuccess,
    falseHalt (action-level, not answer-level)

The ONLY difference between conditions is the gate hook mode:
  off      no gate                       (baseline transport: content-reference + hydration)
  warn     gate warns via context        (addressed-voluntary analog)
  enforce  gate blocks stale refs        (addressed-enforced analog; halts skip downstream hops)

Unlike upstream babel (where the harness verifies canonical-vs-observed out of
band and the wire always carries the canonical ref), the wire here carries the
reference OF THE RELAYED DEFINITION (canonical stub before the mutation
boundary, mutated stub after) — the content-derived reference is what exposes
the change to the gate, which is the mechanism under test.

Exploratory pilot. Not preregistered, not confirmatory evidence.
"""

import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
# Python with the `semahash` package importable (the sema repo venv).
SEMA_PY = os.environ.get("SEMA_PYTHON", "python3")
# hooks/ref_gate.py from RobinOppenstam/sema branch feat/claude-hook-ref-gate
# (pinned for the published runs at commit b00e062).
GATE = os.environ.get("SEMA_REF_GATE_PATH", "")
PROMPTS_DIR = ROOT / "experiments/babel-relay/prompts"
SCENARIOS = ROOT / "experiments/babel-relay/fixtures/scenarios.yaml"

MODEL = "haiku"
REPS = 8
CONDITIONS = ["off", "warn", "enforce"]
CONCURRENCY = 8
HOP_TIMEOUT = 300

RELAY = ["spec-to-plan", "plan-to-implementation", "implementation-to-audit"]
PROMPT_FILES = {
    "spec-to-plan": "spec-to-plan.md",
    "plan-to-implementation": "plan-to-implementation.md",
    "implementation-to-audit": "implementation-to-audit.md",
}

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


def call_claude(system_prompt, user_message, condition, gate_log, rundir):
    env = {
        **os.environ,
        "SEMA_REF_GATE": condition,
        "SEMA_REF_GATE_DB": str(HERE / "canon.db"),
        "SEMA_REF_GATE_LOG": str(gate_log),
        "SEMA_PYTHON": SEMA_PY,
    }
    cmd = [
        "claude", "-p", user_message,
        "--model", MODEL,
        "--system-prompt", system_prompt,
        "--settings", str(HERE / "gate-settings.json"),
        "--strict-mcp-config",
        "--no-session-persistence",
        "--tools", "",
    ]
    for attempt in range(2):
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=HOP_TIMEOUT,
                cwd=str(rundir), env=env,
            )
            text = proc.stdout + "\n" + proc.stderr
            blocked = "STALE sema ref(s) detected" in text and "Original prompt:" in text
            if proc.stdout.strip() or blocked:
                return {"status": "completed", "text": proc.stdout.strip(), "blocked": blocked}
        except subprocess.TimeoutExpired:
            continue
    return {"status": "failed", "text": "", "blocked": False}


def run_trial(trial):
    sc = trial["scenario"]
    condition = trial["condition"]
    gate_log = HERE / "gatelogs" / f"{trial['trial_id']}.jsonl"
    gate_log.parent.mkdir(exist_ok=True)

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
        result = call_claude(
            trial["prompts"][boundary], user_message, condition, gate_log,
            HERE / "rundir",
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
    if not GATE or not Path(GATE).is_file():
        raise SystemExit(
            "Set SEMA_REF_GATE_PATH to hooks/ref_gate.py from "
            "RobinOppenstam/sema@feat/claude-hook-ref-gate (b00e062)."
        )
    scenario_set = yaml.safe_load(SCENARIOS.read_text())
    stubs = json.loads((HERE / "stubs.json").read_text())
    prompts = {b: (PROMPTS_DIR / f).read_text() for b, f in PROMPT_FILES.items()}
    (HERE / "rundir").mkdir(exist_ok=True)
    (HERE / "gate-settings.json").write_text(json.dumps({
        "hooks": {"UserPromptSubmit": [{"hooks": [{
            "type": "command",
            "command": f'"${{SEMA_PYTHON:-python3}}" "{GATE}"',
        }]}]}
    }, indent=2))

    # Interleave conditions at the finest grain so an interrupted run still
    # yields a balanced comparison across all three arms.
    trials = []
    for rep in range(REPS):
        for sc in scenario_set["scenarios"]:
            for condition in CONDITIONS:
                handle = sc["contract"]["handle"]
                trials.append({
                    "trial_id": f"{condition}-{sc['id']}-r{rep}",
                    "condition": condition, "rep": rep,
                    "scenario": sc, "stubs": stubs[handle],
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

    (HERE / "multihop-results.jsonl").write_text(
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

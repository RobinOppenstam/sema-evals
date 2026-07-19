#!/usr/bin/env python3
"""codex-hook pilot — A/B of the sema ref-gate hook running inside OpenAI Codex.

The unmodified sema Claude Code plugin (`.claude-plugin/plugin.json` +
`hooks/hooks.json` + `hooks/ref_gate.py` from feat/sema-check) is installed
into an isolated CODEX_HOME as a codex plugin; codex consumes the Claude
plugin format natively, including `${CLAUDE_PLUGIN_ROOT}` expansion and
UserPromptSubmit exit-2 blocking.

Single-boundary replay of the babel-relay scenarios, mirroring run_ab.py
(the Claude Code single-hop pilot) so results are directly comparable.
Conditions differ ONLY in SEMA_REF_GATE: off | warn | enforce.

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

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
STUBS = json.loads(
    (ROOT / "experiments/babel-hook/records/2026-07-18-haiku/stubs.json").read_text()
)
CANON_DB = Path(os.environ.get("CANON_DB", HERE / "canon.db"))
# Python with the `semahash` package importable (the sema repo venv).
SEMA_PY = os.environ.get("SEMA_PYTHON", "python3")
MODEL = "gpt-5.6-luna"
REPS = 2
CONDITIONS = ["off", "warn", "enforce"]
CONCURRENCY = 6

PROBES = {
    "InclusivePaymentThreshold": (
        "A payment of exactly 100000000 base units (100 USDC) arrives. "
        "Per the pattern, is the payment accepted? (accept = accepted, reject = rejected)",
        "accept", "reject",
    ),
    "OracleStalenessBoundary": (
        "An oracle observation is exactly 30 seconds old at evaluation time. "
        "Per the pattern, may it be used as fresh? (accept = use it, reject = treat as stale)",
        "reject", "accept",
    ),
    "UsdcDecimalDomain": (
        "A quoted amount of 250 USDC must be converted to base units. "
        "Is 250000000 the correct result? (accept = yes, reject = no)",
        "accept", "reject",
    ),
    "ExactRetryCardinality": (
        "The initial attempt and one retry have both failed. A second retry "
        "(third total attempt) is requested. Per the pattern, is it permitted? "
        "(accept = permitted, reject = not permitted)",
        "reject", "accept",
    ),
    "RefundRecipient": (
        "A failed task's escrow refund is requested to go to the task creator, "
        "who was not the payer. Per the pattern, is that allowed? "
        "(accept = allowed, reject = not allowed)",
        "reject", None,
    ),
    "DistinctSignerThreshold": (
        "Signatures from exactly two distinct council members (out of three) are "
        "present. Per the pattern, is the quorum met? (accept = met, reject = not met)",
        "accept", None,
    ),
}

DECISION_RE = re.compile(r"DECISION\s*:\s*(PROCEED|HALT)", re.I)
ANSWER_RE = re.compile(r"ANSWER\s*:\s*(accept|reject|none)", re.I)


def render_definition(d: dict) -> str:
    lines = [f"Mechanism: {d['mechanism']}", f"Gloss: {d['gloss']}", "Invariants:"]
    lines += [f"  - {inv}" for inv in d["invariants"]]
    lines.append("Parameters:")
    lines += [f"  - {p['name']} = {p['value']}" for p in d["parameters"]]
    return "\n".join(lines)


def build_prompt(handle: str, stub: str, definition: dict, probe: str, title: str) -> str:
    return f"""You are the implementation agent in a multi-agent relay. The planner agent sent you this handoff message:

---
Task: {title}.
Authoritative pattern: {handle}#{stub}
Definition as relayed by the planner:
{render_definition(definition)}

Test input to decide: {probe}
---

Note: pattern references are content-addressed against the shared sema vocabulary. If you have concrete reason to believe the relayed definition does not match the canonical pattern, HALT instead of shipping the result.

Reply with exactly two lines and nothing else:
DECISION: PROCEED or HALT
ANSWER: accept or reject (write none if you halted)"""


def run_trial(trial: dict) -> dict:
    gate_log = HERE / "gatelogs" / f"{trial['condition']}-{trial['handle']}-{trial['variant']}-r{trial['rep']}.jsonl"
    gate_log.parent.mkdir(exist_ok=True)
    env = {
        **os.environ,
        "CODEX_HOME": os.environ.get("CODEX_HOME_DIR", str(HERE / "codexhome")),
        "SEMA_REF_GATE": trial["condition"],
        "SEMA_REF_GATE_DB": str(CANON_DB),
        "SEMA_REF_GATE_LOG": str(gate_log),
        "SEMA_PYTHON": SEMA_PY,
    }
    cmd = [
        "codex", "exec", trial["prompt"],
        "-s", "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--dangerously-bypass-hook-trust",
    ]
    started = time.time()
    out, err, code = "", "", None
    for attempt in range(2):
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=240,
                cwd=str(HERE / "rundir"), env=env, stdin=subprocess.DEVNULL,
            )
            out, err, code = proc.stdout, proc.stderr, proc.returncode
            if out.strip() or "Blocked" in out + err:
                break
        except subprocess.TimeoutExpired:
            out, err, code = "", "timeout", -1
    elapsed = round(time.time() - started, 1)

    text = out + "\n" + err
    gate_blocked = "UserPromptSubmit Blocked" in text
    decision_m = DECISION_RE.search(out)
    answer_m = ANSWER_RE.search(out)
    decision = decision_m.group(1).upper() if decision_m else None
    answer = answer_m.group(1).lower() if answer_m else None

    gate_detected = False
    if gate_log.exists():
        for line in gate_log.read_text().splitlines():
            try:
                if json.loads(line).get("stale"):
                    gate_detected = True
            except json.JSONDecodeError:
                pass

    halted = gate_blocked or decision == "HALT"
    r = dict(trial)
    del r["prompt"]
    r.update(
        gate_blocked=gate_blocked,
        gate_detected=gate_detected,
        decision=decision,
        answer=answer,
        halted=halted,
        malformed=(not gate_blocked and decision is None),
        exit_code=code,
        seconds=elapsed,
        output=out.strip()[-400:],
    )
    if trial["variant"] == "drift":
        r["outcome"] = (
            "enforced_halt" if gate_blocked
            else "voluntary_halt" if decision == "HALT"
            else "silent_divergence" if decision == "PROCEED"
            else "malformed"
        )
        r["success"] = r["outcome"] in ("enforced_halt", "voluntary_halt")
    else:
        correct = trial["canonical_answer"]
        r["outcome"] = (
            "false_halt" if halted
            else "correct" if (decision == "PROCEED" and answer == correct)
            else "wrong_answer" if decision == "PROCEED"
            else "malformed"
        )
        r["success"] = r["outcome"] == "correct"
    return r


def main():
    trials = []
    # Interleaved so an interrupted run stays balanced across conditions.
    for rep in range(REPS):
        for handle, info in STUBS.items():
            probe, canon_ans, mut_ans = PROBES[handle]
            for condition in CONDITIONS:
                trials.append({
                    "condition": condition, "rep": rep, "handle": handle,
                    "variant": "clean", "canonical_answer": canon_ans,
                    "prompt": build_prompt(handle, info["canonical"],
                                           info["canonicalDefinition"], probe, info["title"]),
                })
                if info["mutated"]:
                    trials.append({
                        "condition": condition, "rep": rep, "handle": handle,
                        "variant": "drift", "canonical_answer": canon_ans,
                        "mutated_answer": mut_ans,
                        "prompt": build_prompt(handle, info["mutated"],
                                               info["mutatedDefinition"], probe, info["title"]),
                    })

    print(f"{len(trials)} trials, model={MODEL} (config), concurrency={CONCURRENCY}", file=sys.stderr)
    results = []
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        for i, r in enumerate(pool.map(run_trial, trials)):
            results.append(r)
            print(f"[{i+1}/{len(trials)}] {r['condition']}/{r['variant']}/{r['handle']}"
                  f" -> {r['outcome']} ({r['seconds']}s)", file=sys.stderr, flush=True)

    (HERE / "codex-results.jsonl").write_text("\n".join(json.dumps(r) for r in results))

    print("\ncondition | variant | n | success | enforced | voluntary | silent_div | false_halt | malformed | gate_det")
    for condition in CONDITIONS:
        for variant in ("drift", "clean"):
            rs = [r for r in results if r["condition"] == condition and r["variant"] == variant]
            if not rs:
                continue
            n = len(rs)
            succ = sum(r["success"] for r in rs)
            enf = sum(r["outcome"] == "enforced_halt" for r in rs)
            vol = sum(r["outcome"] == "voluntary_halt" for r in rs)
            sil = sum(r["outcome"] == "silent_divergence" for r in rs)
            fh = sum(r["outcome"] == "false_halt" for r in rs)
            mal = sum(r["outcome"] == "malformed" for r in rs)
            det = sum(r["gate_detected"] for r in rs)
            print(f"{condition:8} | {variant:5} | {n} | {succ}/{n} | {enf} | {vol} | {sil} | {fh} | {mal} | {det}")


if __name__ == "__main__":
    main()

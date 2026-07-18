#!/usr/bin/env python3
"""Build the babel-hook pilot vocabularies.

Mints each scenario's canonical definition into canon.db and each drift
scenario's mutated definition into mut.db, using sema's real mint pipeline
so every stub is an honest content hash. Writes stubs.json with
{handle: {canonical, mutated}} for the runner.
"""

import json
import subprocess
import sys
from pathlib import Path

import yaml

import os

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
# Checkout of the sema repo with a built .venv (provides `sema` CLI + package).
SEMA_REPO = Path(os.environ.get("SEMA_REPO", ""))
SEMA = str(SEMA_REPO / ".venv/bin/sema")
SCENARIOS = ROOT / "experiments/babel-relay/fixtures/scenarios.yaml"

sys.path.insert(0, str(SEMA_REPO / "src"))


def to_pattern(handle: str, definition: dict) -> dict:
    p = {
        "handle": handle,
        "mechanism": definition["mechanism"],
        "gloss": definition["gloss"],
        "invariants": definition["invariants"],
        "parameters": definition["parameters"],
        "failure_modes": definition["failure_modes"],
        "_meta": definition["_meta"],
    }
    return p


def mint_all(db_path: Path, patterns: list[dict]) -> dict[str, str]:
    from sema.core.mint import mint_pattern
    from sema.taxonomy_graph.graph_store import GraphStore

    store = GraphStore(str(db_path))
    stubs = {}
    for pattern in patterns:
        result = mint_pattern(pattern, store)
        if not result.success:
            raise SystemExit(f"mint failed for {pattern['handle']}: {result.errors}")
        stubs[pattern["handle"]] = result.sema_ref.split("#")[1]
    return stubs


def main():
    if not os.environ.get("SEMA_REPO") or not (SEMA_REPO / "src").is_dir():
        raise SystemExit("Set SEMA_REPO to a sema checkout with a built .venv.")
    scenario_set = yaml.safe_load(SCENARIOS.read_text())
    canon_db = HERE / "canon.db"
    mut_db = HERE / "mut.db"
    for db in (canon_db, mut_db):
        if db.exists():
            db.unlink()
        subprocess.run([SEMA, "init", str(db)], check=True, capture_output=True)

    canonical, mutated = [], []
    meta = {}
    for sc in scenario_set["scenarios"]:
        handle = sc["contract"]["handle"]
        canonical.append(to_pattern(handle, sc["contract"]["canonicalDefinition"]))
        if sc["mutation"] is not None:
            mutated.append(to_pattern(handle, sc["contract"]["mutatedDefinition"]))
        meta[handle] = {
            "id": sc["id"],
            "title": sc["title"],
            "expectedAction": sc["expectedAction"],
            "canonicalDefinition": sc["contract"]["canonicalDefinition"],
            "mutatedDefinition": sc["contract"]["mutatedDefinition"],
        }

    canon_stubs = mint_all(canon_db, canonical)
    mut_stubs = mint_all(mut_db, mutated)

    out = {
        handle: {
            "canonical": canon_stubs[handle],
            "mutated": mut_stubs.get(handle),
            **meta[handle],
        }
        for handle in canon_stubs
    }
    (HERE / "stubs.json").write_text(json.dumps(out, indent=2))
    for handle, info in out.items():
        print(f"{handle}: canonical #{info['canonical']} mutated #{info['mutated']}")


if __name__ == "__main__":
    main()

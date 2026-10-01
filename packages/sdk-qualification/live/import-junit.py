"""Map Bun's standard JUnit cases and private build/cleanup context to reviewed docs input.

No SDK calls, test execution, native diagnostics or private custody are copied.
"""
import argparse
import json
from pathlib import Path
import xml.etree.ElementTree as ET

CASES = {
    "sandbox-lifecycle", "execution", "execution-streaming", "files", "lifecycle-reopen", "snapshot-roundtrip",
    "volume-crud", "volume-persistence", "network-controls",
}
FIELDS = ("provider", "sdkCommit", "harnessCommit", "sdkVersion", "nativeVersion", "runtime", "platform", "timestamp", "configuration")


def convert(xml, contexts, evidence_ref, exit_code):
    if "<!DOCTYPE" in xml or "<!ENTITY" in xml:
        raise ValueError("JUnit declarations are unsupported")
    root = ET.fromstring(xml)
    cases = list(root.iter("testcase"))
    names = {}
    for context in contexts:
        if context["dirty"]:
            raise ValueError("Dirty debug runs are not clean-revision docs evidence")
        for name in context["names"]:
            if name in names or name not in CASES:
                raise ValueError("Ambiguous or unknown test context")
            names[name] = context
    # Bun reports beforeAll/afterAll failures at suite level as well as case level.
    declared_failures = int(root.get("failures", "0")) + int(root.get("errors", "0"))
    case_failures = sum(case.find("failure") is not None or case.find("error") is not None for case in cases)
    hook_failed = exit_code != 0 and (declared_failures > case_failures or not case_failures or any(case.get("name") == "(unnamed)" and case.find("failure") is not None for case in cases))
    records = []
    for case in cases:
        name = case.get("name", "")
        context = names.get(name)
        if context is None:
            if name == "(unnamed)" and case.find("failure") is not None and exit_code != 0:
                continue  # Bun represents hook failures as unnamed cases; fail contextualized tests above.
            if case.find("skipped") is not None:
                continue  # Selection/unsupported skip without any resource setup: no new claim.
            raise ValueError("Executed test has no matching provenance/cleanup context")
        skipped = case.find("skipped") is not None
        failed = case.find("failure") is not None or case.find("error") is not None or hook_failed
        clean = context["cleanup"] == "confirmed" and context["closeSucceeded"]
        status = "not-run" if skipped else "failed" if failed or not clean else "passed"
        # A testcase establishes its workflow outcome, not each operation inside it.
        record = {field: context[field] for field in FIELDS}
        record["configuration"] = dict(context["configuration"])
        if name == "network-controls":
            record["configuration"].update(network="paired-internet-blocked-requested", networkProbe="cloudflare-tcp443-hostname-ipv4-v1")
        if name.startswith("volume-"):
            record["configuration"].update(stateProbe="volume-crud-v1" if name == "volume-crud" else "volume-persistence-v1",volumeOwnership="created")
        record.update(schemaVersion=1, mode="live", scenario=name, status=status,
                      runCleanup="confirmed" if clean else "not-required" if context["cleanup"] == "not-required" else "incomplete",
                      runner={"name": "bun:test", "format": "junit", "testName": name}, evidenceRef=evidence_ref)
        if skipped:
            record["issue"] = "not-selected"
        elif not clean:
            record["issue"] = "cleanup-unconfirmed"
        records.append(record)
    if not records:
        raise ValueError("No executed/contextualized live test records")
    if len({record["provider"] for record in records}) != 1:
        raise ValueError("Keep one reviewed summary per provider")
    return {"schemaVersion": 1, "records": records}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--junit", required=True, type=Path)
    parser.add_argument("--contexts", required=True, type=Path)
    parser.add_argument("--evidence-ref", required=True)
    parser.add_argument("--exit-code", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.junit.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("JUnit report exceeds bound")
    contexts = [json.loads(path.read_text()) for path in sorted(args.contexts.glob("*.context.json"))]
    report = convert(args.junit.read_text(), contexts, args.evidence_ref, args.exit_code)
    # Exclusive creation preserves earlier evidence; publication remains a reviewed repository edit.
    with args.output.open("x") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    args.output.chmod(0o600)


if __name__ == "__main__":
    main()

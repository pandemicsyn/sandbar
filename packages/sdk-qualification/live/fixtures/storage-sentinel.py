"""First application action for an operator-prepared image; never exec after creation.

The image's native daemon wrapper must launch this on every fresh start and keep
Toolbox available. Absent config starts idle. No mount/data retry or app work.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import uuid

CONFIG = Path("/tmp/sandbar-storage-config.json")
REPORT = Path("/tmp/sandbar-storage-report.json")
STARTED = Path("/tmp/sandbar-storage-started.json")


def first_action():
    # Replace inherited evidence before any data observation.
    REPORT.unlink(missing_ok=True)
    STARTED.unlink(missing_ok=True)
    nonce = str(uuid.uuid4())
    sandbox_id = socket.gethostname()
    if not CONFIG.exists():
        return  # The bootstrap source/seeder remains idle; no application work.
    if CONFIG.stat().st_size > 16_384:
        raise ValueError("Config exceeds bound")
    config = json.loads(CONFIG.read_text())
    marker_file = Path("/data/.sentinel-id")
    marker = marker_file.read_text() if marker_file.stat().st_size <= 128 else "oversized"
    data_file = Path("/data/report.json")
    data_hash = None
    if data_file.exists():
        if data_file.stat().st_size > 1_048_576:
            raise ValueError("Data exceeds bound")
        data_hash = hashlib.sha256(data_file.read_bytes()).hexdigest()
    private_state = Path("/tmp/app-version.txt").read_text()
    recognized = any(profile["marker"] == marker and profile["dataHash"] == data_hash
                     for profile in config["profiles"])
    passed = (recognized and private_state == "v1" and
              config["policy"] == "daytona-default")
    report = dict(sandboxId=sandbox_id, nonce=nonce, runId=config["runId"], marker=marker,
                  dataHash=data_hash, privateState=private_state, policy=config["policy"],
                  firstAttempt=True, applicationStarted=passed)
    REPORT.write_text(json.dumps(report))
    os.chmod(REPORT, 0o600)
    if passed:
        STARTED.write_text(json.dumps(dict(sandboxId=sandbox_id, nonce=nonce)))
        os.chmod(STARTED, 0o600)


if __name__ == "__main__":
    try:
        first_action()
    except Exception as error:
        # Missing/invalid evidence fails the harness; keep Toolbox alive for inspection.
        REPORT.write_text(json.dumps(dict(error=type(error).__name__)))
        os.chmod(REPORT, 0o600)
    signal.pause()  # No application work follows failure or bootstrap idle.

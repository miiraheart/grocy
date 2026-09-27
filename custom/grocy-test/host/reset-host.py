#!/usr/bin/env python3
"""Refresh the grocy-test data dir from the real Grocy. Prints one JSON line."""
import fcntl
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REAL_DATA = Path("/home/miira/apps/docker/grocy/config/data")
TEST_ROOT = Path("/home/miira/apps/docker/grocy-test")
TEST_DATA = TEST_ROOT / "config" / "data"
STAGING = TEST_ROOT / "staging-data"
OLD = TEST_ROOT / "old-data"
LOCK = TEST_ROOT / ".reset.lock"
CONTAINER = "grocy-test"
KEYS_CONF = Path("/home/miira/apps/docker/n8n-templates/keys.conf")
TEST_PASSWORD_KEY = "GROCY_TEST_PASSWORD"
TEST_USER = "miira"


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def run(*args, check=True):
    return subprocess.run(args, capture_output=True, text=True, check=check)


def container_exists():
    return run("docker", "inspect", CONTAINER, check=False).returncode == 0


def stage_copy():
    shutil.rmtree(STAGING, ignore_errors=True)
    run("rsync", "-a", "--exclude=/grocy.db", "--exclude=/grocy.db-journal",
        "--exclude=/viewcache", f"{REAL_DATA}/", f"{STAGING}/")
    (STAGING / "viewcache").mkdir()
    point_companion_at_test_hooks()
    src = sqlite3.connect(f"file:{REAL_DATA / 'grocy.db'}?mode=ro", uri=True, timeout=15)
    dst = sqlite3.connect(STAGING / "grocy.db")
    try:
        src.backup(dst)
        copied_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        check = dst.execute("PRAGMA quick_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"copied db failed quick_check: {check}")
        set_test_password(dst)
    finally:
        dst.close()
        src.close()
    return copied_at


def test_password():
    text = KEYS_CONF.read_text()
    for line in text.splitlines():
        key, _, value = line.partition("=")
        if key.strip() == TEST_PASSWORD_KEY and value.strip():
            return value.strip()
    value = secrets.token_urlsafe(24)
    fd = os.open(KEYS_CONF, os.O_WRONLY | os.O_APPEND)
    with os.fdopen(fd, "a") as f:
        f.write(("" if text.endswith("\n") or not text else "\n") + f"{TEST_PASSWORD_KEY}={value}\n")
    os.chmod(KEYS_CONF, 0o600)
    return value


def set_test_password(db):
    hashed = subprocess.run(
        ["php", "-r", "echo password_hash(rtrim(stream_get_contents(STDIN)), PASSWORD_DEFAULT);"],
        input=test_password(), capture_output=True, text=True, check=True).stdout
    if not hashed.startswith("$2y$"):
        raise RuntimeError("php password_hash returned no bcrypt hash")
    cur = db.execute("UPDATE users SET password = ? WHERE username = ?", (hashed, TEST_USER))
    if cur.rowcount != 1:
        raise RuntimeError(f"test user {TEST_USER} not found in the copied db")
    db.commit()


def point_companion_at_test_hooks():
    cfg_file = STAGING / "companion.json"
    if not cfg_file.exists():
        return
    cfg = json.loads(cfg_file.read_text())
    cfg["hook_suffix"] = "-test"
    cfg_file.write_text(json.dumps(cfg) + "\n")


def swap_in():
    shutil.rmtree(OLD, ignore_errors=True)
    if TEST_DATA.exists():
        TEST_DATA.rename(OLD)
    STAGING.rename(TEST_DATA)
    shutil.rmtree(OLD, ignore_errors=True)


def first_get(deadline_s=120):
    end = time.monotonic() + deadline_s
    code = "000"
    while time.monotonic() < end:
        res = run("docker", "exec", CONTAINER, "curl", "-s", "-o", "/dev/null",
                  "-w", "%{http_code}", "http://localhost/", check=False)
        code = res.stdout.strip() or "000"
        if code in ("200", "302"):
            return
        if code.startswith("5") and code != "502":
            raise RuntimeError(f"grocy-test answered {code} to the first GET")
        time.sleep(2)
    raise RuntimeError(f"grocy-test not ready, last status {code}")


def reset():
    copied_at = stage_copy()
    exists = container_exists()
    if exists:
        run("docker", "stop", "-t", "20", CONTAINER)
    try:
        swap_in()
    finally:
        if exists:
            run("docker", "start", CONTAINER)
    if exists:
        first_get()
    return copied_at


def main():
    sys.stdin.read()
    with open(LOCK, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"ok": False, "error": "a reset is already running"}), flush=True)
            return
        started = time.monotonic()
        try:
            copied_at = reset()
            log(f"reset ok in {time.monotonic() - started:.1f}s, copied_at {copied_at}")
            print(json.dumps({"ok": True, "copied_at": copied_at}), flush=True)
        except subprocess.CalledProcessError as exc:
            log(f"reset failed: {exc} {exc.stderr}")
            print(json.dumps({"ok": False, "error": f"{' '.join(exc.cmd[:3])} failed: {exc.stderr.strip()[:200]}"}), flush=True)
        except Exception as exc:
            log(f"reset failed: {exc}")
            print(json.dumps({"ok": False, "error": str(exc)[:300]}), flush=True)


if __name__ == "__main__":
    main()

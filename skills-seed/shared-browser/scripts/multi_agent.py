#!/usr/bin/env python3
import argparse
import asyncio
import fcntl
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ModuleNotFoundError:
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "playwright"], check=True)
    from playwright.async_api import async_playwright


def read_json(path):
    return json.loads(Path(path).read_text())


def next_sequence(session_path, actor_id):
    sequence_path = Path(f"{session_path}.sequences")
    sequence_path.parent.mkdir(parents=True, exist_ok=True)
    with sequence_path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        handle.seek(0)
        raw = handle.read().strip()
        sequences = json.loads(raw) if raw else {}
        sequence = int(sequences.get(actor_id, 0)) + 1
        sequences[actor_id] = sequence
        handle.seek(0)
        handle.truncate()
        json.dump(sequences, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
        return sequence


def append_audit(session_path, record):
    audit_path = Path(f"{session_path}.audit.jsonl")
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    with audit_path.open("a", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        handle.write(json.dumps(record, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


async def page_for(cdp_url):
    playwright = await async_playwright().start()
    browser = await playwright.chromium.connect_over_cdp(cdp_url)
    contexts = browser.contexts
    if not contexts:
        raise RuntimeError("shared browser has no context")
    pages = contexts[0].pages
    if not pages:
        raise RuntimeError("shared browser has no page")
    page = pages[-1]
    await page.wait_for_load_state("domcontentloaded")
    runtime_path = Path(__file__).resolve().parent.parent / "extension" / "content.js"
    runtime = runtime_path.read_text()
    await contexts[0].add_init_script(script=runtime)
    loaded = await page.evaluate("Boolean(globalThis.__qmSharedBrowserLoaded)")
    if not loaded:
        await page.evaluate(runtime)
    return playwright, page


async def dispatch(page, actor_id, sequence, operation):
    payload = {
        "requestId": str(uuid.uuid4()),
        "actorId": actor_id,
        "sequence": sequence,
        "operation": operation,
    }
    return await page.evaluate(
        """
        async (payload) => await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            window.removeEventListener('message', receive);
            reject(new Error('QM shared-browser extension did not respond'));
          }, 10000);
          function receive(event) {
            const message = event.data;
            if (event.source !== window || !message || message.channel !== 'qm-shared-browser-response' || message.requestId !== payload.requestId) return;
            clearTimeout(timer);
            window.removeEventListener('message', receive);
            if (message.ok) resolve(message.result);
            else reject(new Error(message.error || 'shared-browser action failed'));
          }
          window.addEventListener('message', receive);
          window.postMessage({ channel: 'qm-shared-browser-request', ...payload }, '*');
        })
        """,
        payload,
    )


async def run(args):
    session = read_json(args.session)
    operation = {"kind": args.command}
    if args.command == "act":
        operation = {"kind": args.kind, "ref": args.ref}
        if args.value is not None:
            operation["value"] = args.value
        if args.duration_ms is not None:
            operation["durationMs"] = args.duration_ms
        if args.sync_key is not None:
            operation["syncKey"] = args.sync_key
            operation["participants"] = args.participants
    sequence = next_sequence(args.session, args.actor)
    started_at = time.time()
    playwright, page = await page_for(session["cdpUrl"])
    try:
        result = await dispatch(page, args.actor, sequence, operation)
    finally:
        await playwright.stop()
    append_audit(
        args.session,
        {
            "actorId": args.actor,
            "browserSessionId": session["browserSessionId"],
            "durationMs": round((time.time() - started_at) * 1000),
            "operation": operation,
            "sequence": sequence,
            "timestamp": int(time.time() * 1000),
        },
    )
    print(json.dumps(result, indent=2, sort_keys=True))


async def audit(args):
    session = read_json(args.session)
    sequence = next_sequence(args.session, args.actor)
    playwright, page = await page_for(session["cdpUrl"])
    try:
        records = await dispatch(page, args.actor, sequence, {"kind": "audit"})
    finally:
        await playwright.stop()
    print(
        json.dumps(
            {
                "browserSessionId": session["browserSessionId"],
                "actors": sorted({record["actorId"] for record in records}),
                "records": records,
            },
            indent=2,
            sort_keys=True,
        )
    )


def parser():
    result = argparse.ArgumentParser()
    result.add_argument("--session", required=True)
    result.add_argument("--actor", default="coordinator")
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("observe")
    action = commands.add_parser("act")
    action.add_argument("--ref", required=True)
    action.add_argument("--kind", required=True, choices=["fill", "type", "append", "click", "check", "uncheck", "select", "scroll"])
    action.add_argument("--value")
    action.add_argument("--duration-ms", type=int)
    action.add_argument("--sync-key")
    action.add_argument("--participants", type=int, default=2)
    commands.add_parser("audit")
    return result


def main():
    args = parser().parse_args()
    if args.command == "audit":
        asyncio.run(audit(args))
        return
    asyncio.run(run(args))


if __name__ == "__main__":
    main()

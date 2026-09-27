#!/usr/bin/env python3
import argparse
import asyncio
import json
import os
import secrets
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from tempfile import NamedTemporaryFile


KERNEL_API = "https://api.onkernel.com"
BROWSERBASE_API = "https://api.browserbase.com/v1"
EXTENSION_NAME = "qm-shared-browser"


def request(method, url, headers, body=None, content_type="application/json"):
    if body is not None:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, context=ssl.create_default_context(), timeout=60) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        parsed = json.loads(raw) if raw else {}
        return error.code, parsed


def archive_extension():
    extension_dir = Path(__file__).resolve().parent.parent / "extension"
    temporary = NamedTemporaryFile(suffix=".zip", delete=False)
    temporary.close()
    with zipfile.ZipFile(temporary.name, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(extension_dir.iterdir()):
            archive.write(path, path.name)
    return Path(temporary.name)


def multipart(file_path):
    boundary = f"qm-{secrets.token_hex(16)}"
    content = file_path.read_bytes()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="name"\r\n\r\n{EXTENSION_NAME}\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="extension.zip"\r\n'
        f"Content-Type: application/zip\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


async def navigate(cdp_url, url):
    try:
        import playwright.async_api
    except ModuleNotFoundError:
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "playwright"], check=True)
    from playwright.async_api import async_playwright

    playwright = await async_playwright().start()
    try:
        browser = await playwright.chromium.connect_over_cdp(cdp_url)
        context = browser.contexts[0]
        pages = context.pages
        page = pages[-1] if pages else await context.new_page()
        await page.goto(url, wait_until="domcontentloaded", timeout=60000)
    finally:
        await playwright.stop()


def start_kernel(args, api_key):
    api_key = os.environ.get("KERNEL_API_KEY")
    if not api_key:
        raise SystemExit("KERNEL_API_KEY is required")
    archive = archive_extension()
    try:
        body, content_type = multipart(archive)
        headers = {"Authorization": f"Bearer {api_key}"}
        status, uploaded = request("POST", f"{KERNEL_API}/extensions", headers, body, content_type)
        if status not in (201, 409):
            raise SystemExit(f"extension upload failed ({status}): {uploaded}")
    finally:
        archive.unlink(missing_ok=True)
    browser = {
        "stealth": True,
        "headless": False,
        "timeout_seconds": 1800,
        "start_url": args.url,
        "extensions": [{"name": EXTENSION_NAME}],
    }
    if args.use_profile:
        profile = os.environ.get("KERNEL_PROFILE")
        if not profile:
            raise SystemExit("KERNEL_PROFILE is required with --use-profile")
        browser["profile"] = {"name": profile}
    headers = {"Authorization": f"Bearer {api_key}"}
    status, created = request("POST", f"{KERNEL_API}/browsers", headers, json.dumps(browser).encode())
    if status != 201:
        raise SystemExit(f"browser create failed ({status}): {created}")
    return {
        "browserSessionId": created["session_id"],
        "cdpUrl": created["cdp_ws_url"],
        "liveViewUrl": created.get("browser_live_view_url", ""),
        "provider": "kernel",
        "targetUrl": args.url,
    }


def start_browserbase(args, api_key):
    browser = {"keepAlive": True, "timeout": 1800}
    if args.use_profile:
        context = os.environ.get("BROWSERBASE_CONTEXT")
        if not context:
            raise SystemExit("BROWSERBASE_CONTEXT is required with --use-profile")
        browser["browserSettings"] = {"context": {"id": context}}
    headers = {"X-BB-API-Key": api_key}
    status, created = request("POST", f"{BROWSERBASE_API}/sessions", headers, json.dumps(browser).encode())
    if status != 201:
        raise SystemExit(f"browser create failed ({status}): {created}")
    session_id = created["id"]
    debug_status, debug = request("GET", f"{BROWSERBASE_API}/sessions/{session_id}/debug", headers)
    if debug_status != 200:
        debug = {}
    return {
        "browserSessionId": session_id,
        "cdpUrl": created["connectUrl"],
        "liveViewUrl": debug.get("debuggerFullscreenUrl", ""),
        "provider": "browserbase",
        "targetUrl": args.url,
    }


def start(args):
    browserbase_key = os.environ.get("BROWSERBASE_API_KEY")
    kernel_key = os.environ.get("KERNEL_API_KEY")
    if browserbase_key:
        session = start_browserbase(args, browserbase_key)
    elif kernel_key:
        session = start_kernel(args, kernel_key)
    else:
        raise SystemExit("BROWSERBASE_API_KEY or KERNEL_API_KEY is required")
    try:
        asyncio.run(navigate(session["cdpUrl"], args.url))
    except Exception:
        release(session)
        raise
    path = Path(args.session)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = json.dumps(session, indent=2, sort_keys=True)
    descriptor_fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor_fd, "w", encoding="utf-8") as descriptor_file:
        descriptor_file.write(descriptor)
    print(json.dumps({"browserSessionId": session["browserSessionId"], "session": str(path)}))


def attach(args):
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    if not api_key:
        raise SystemExit("BROWSERBASE_API_KEY is required")
    headers = {"X-BB-API-Key": api_key}
    status, session = request("GET", f"{BROWSERBASE_API}/sessions/{args.session_id}", headers)
    if status != 200:
        raise SystemExit(f"browser attach failed ({status}): {session}")
    if session.get("status") != "RUNNING" or not session.get("connectUrl"):
        raise SystemExit(f"browser session is not connectable: {session.get('status', 'unknown')}")
    descriptor = {
        "browserSessionId": session["id"],
        "cdpUrl": session["connectUrl"],
        "provider": "browserbase",
    }
    path = Path(args.session)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor_fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor_fd, "w", encoding="utf-8") as descriptor_file:
        descriptor_file.write(json.dumps(descriptor, indent=2, sort_keys=True))
    print(json.dumps({"browserSessionId": session["id"], "session": str(path)}))


def release(session):
    if session["provider"] == "browserbase":
        api_key = os.environ.get("BROWSERBASE_API_KEY")
        if not api_key:
            raise SystemExit("BROWSERBASE_API_KEY is required")
        headers = {"X-BB-API-Key": api_key}
        return request(
            "POST",
            f"{BROWSERBASE_API}/sessions/{session['browserSessionId']}",
            headers,
            json.dumps({"status": "REQUEST_RELEASE"}).encode(),
        )
    api_key = os.environ.get("KERNEL_API_KEY")
    if not api_key:
        raise SystemExit("KERNEL_API_KEY is required")
    headers = {"Authorization": f"Bearer {api_key}"}
    return request("DELETE", f"{KERNEL_API}/browsers/{session['browserSessionId']}", headers)


def close(args):
    path = Path(args.session)
    session = json.loads(path.read_text())
    status, response = release(session)
    if status not in (200, 201, 204, 404):
        raise SystemExit(f"browser delete failed ({status}): {response}")
    path.unlink(missing_ok=True)
    Path(f"{args.session}.sequences").unlink(missing_ok=True)
    print(json.dumps({"closed": session["browserSessionId"]}))


def parser():
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)
    start_command = commands.add_parser("start")
    start_command.add_argument("--url", required=True)
    start_command.add_argument("--session", required=True)
    start_command.add_argument("--use-profile", action="store_true")
    close_command = commands.add_parser("close")
    close_command.add_argument("--session", required=True)
    attach_command = commands.add_parser("attach")
    attach_command.add_argument("--session-id", required=True)
    attach_command.add_argument("--session", required=True)
    return result


def main():
    args = parser().parse_args()
    if args.command == "start":
        start(args)
    elif args.command == "attach":
        attach(args)
    else:
        close(args)


if __name__ == "__main__":
    main()

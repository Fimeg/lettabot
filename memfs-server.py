#!/usr/bin/env python3
"""
Local git HTTP sidecar for Letta memfs on self-hosted deployments.

Implements git smart HTTP protocol via git-http-backend, storing bare repos under
~/.letta/memfs/repository/{org_id}/{agent_id}/repo.git/ — the exact structure that
Letta's LocalStorageBackend reads from.

The Letta server proxies /v1/git/* requests here when LETTA_MEMFS_SERVICE_URL is set.
letta-code pushes → Letta server proxies → here → bare repo → LocalStorageBackend reads.

Run as a systemd user service. Listens on 127.0.0.1:8285.
"""

import os
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 8285
REPO_BASE = Path.home() / ".letta" / "memfs" / "repository"

# /git/{agent_id}/state.git/{rest}
_PATH_RE = re.compile(r"^/git/([^/]+)/state\.git(/.*)?$")


def _repo_path(org_id: str, agent_id: str) -> Path:
    return REPO_BASE / org_id / agent_id / "repo.git"


def _fix_repo_config(repo: Path) -> None:
    """Ensure repo is pushable (Corykidios fix-repo-configs pattern)."""
    subprocess.run(["git", "config", "--file", str(repo / "config"), "core.bare", "true"], capture_output=True)
    subprocess.run(["git", "config", "--file", str(repo / "config"), "receive.denyCurrentBranch", "ignore"], capture_output=True)
    subprocess.run(["git", "config", "--file", str(repo / "config"), "http.receivepack", "true"], capture_output=True)


def _ensure_repo(repo: Path, agent_id: str) -> Path:
    """Ensure repo exists, searching all org dirs if needed (Corykidios pattern)."""
    # If repo exists at expected path, use it
    if repo.exists():
        _fix_repo_config(repo)
        return repo

    # Search all org directories for existing agent repo
    if REPO_BASE.exists():
        for org_dir in REPO_BASE.iterdir():
            if org_dir.is_dir():
                candidate = org_dir / agent_id / "repo.git"
                if candidate.exists():
                    print(f"[memfs] Found existing repo at {candidate}", file=sys.stderr, flush=True)
                    _fix_repo_config(candidate)
                    return candidate

    # Create new repo at expected path
    repo.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "--bare", str(repo)], check=True, capture_output=True)
    with open(repo / "config", "a") as f:
        f.write("\n[http]\n\treceivepack = true\n")
    print(f"[memfs] Created new repo at {repo}", file=sys.stderr, flush=True)
    return repo


def _read_chunked(rfile) -> bytes:
    """Read and decode HTTP chunked transfer encoding from a socket file."""
    body = bytearray()
    while True:
        line = rfile.readline().strip()
        if not line:
            continue
        size = int(line, 16)
        if size == 0:
            rfile.readline()  # trailing CRLF after terminal chunk
            break
        body.extend(rfile.read(size))
        rfile.readline()  # trailing CRLF after chunk data
    return bytes(body)


class GitHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[memfs] {self.address_string()} {fmt % args}", file=sys.stderr, flush=True)

    def _handle(self):
        raw_path = self.path.split("?")[0]
        m = _PATH_RE.match(raw_path)
        if not m:
            self.send_error(404, "Not a valid memfs path")
            return

        agent_id = m.group(1)
        git_suffix = m.group(2) or "/"
        org_id = self.headers.get("X-Organization-Id") or "default"
        query = self.path.split("?", 1)[1] if "?" in self.path else ""

        repo = _repo_path(org_id, agent_id)
        repo = _ensure_repo(repo, agent_id)  # Pass agent_id for search

        # Read request body — handle both Content-Length and chunked
        te = self.headers.get("Transfer-Encoding", "")
        cl = self.headers.get("Content-Length")
        if cl:
            body = self.rfile.read(int(cl))
        elif "chunked" in te.lower():
            body = _read_chunked(self.rfile)
        else:
            body = b""

        env = {
            **os.environ,
            "GIT_PROJECT_ROOT": str(repo.parent),
            "PATH_INFO": "/repo.git" + git_suffix,
            "REQUEST_METHOD": self.command,
            "QUERY_STRING": query,
            "CONTENT_TYPE": self.headers.get("Content-Type", ""),
            "CONTENT_LENGTH": str(len(body)),
            "GIT_HTTP_EXPORT_ALL": "1",
        }

        result = subprocess.run(
            ["git", "http-backend"],
            input=body,
            capture_output=True,
            env=env,
        )

        if result.returncode != 0:
            print(f"[memfs] git-http-backend error: {result.stderr.decode()}", file=sys.stderr)
            self.send_error(500, "git-http-backend failed")
            return

        # Parse CGI output (headers + body)
        raw = result.stdout
        header_end = raw.find(b"\r\n\r\n")
        if header_end == -1:
            header_end = raw.find(b"\n\n")
        if header_end == -1:
            self.send_error(502, "Invalid CGI response")
            return

        header_block = raw[:header_end].decode("utf-8", errors="replace")
        body_out = raw[header_end + 4 if raw[header_end:header_end+4] == b"\r\n\r\n" else header_end + 2:]

        status = 200
        headers = []
        for line in header_block.splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                k, v = k.strip(), v.strip()
                if k.lower() == "status":
                    try:
                        status = int(v.split()[0])
                    except ValueError:
                        pass
                else:
                    headers.append((k, v))

        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body_out)))
        self.end_headers()
        self.wfile.write(body_out)

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()


if __name__ == "__main__":
    REPO_BASE.mkdir(parents=True, exist_ok=True)
    print(f"[memfs] Starting on http://{LISTEN_HOST}:{LISTEN_PORT}", flush=True)
    print(f"[memfs] Repo base: {REPO_BASE}", flush=True)
    ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), GitHandler).serve_forever()

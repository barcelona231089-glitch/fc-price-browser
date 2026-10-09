import os
import re
import secrets
import subprocess
import time
import urllib.request
from pathlib import Path

ROOT = Path(r"C:\Users\barce\FC-Trader-WorldMax")
REPO = ROOT / "repo"
WORKER = REPO / "world-max-worker"
PYTHON = WORKER / ".venv" / "Scripts" / "python.exe"
CLOUDFLARED = Path(r"C:\Program Files (x86)\cloudflared\cloudflared.exe")
TOKEN_FILE = ROOT / "worker.token"
LOG_FILE = ROOT / "watchdog.log"
TUNNEL_LOG = ROOT / "tunnel.log"
REGISTRY_REPO = Path(r"C:\Users\barce\FCWorldMaxRegistry")
REGISTRY_FILE = REGISTRY_REPO / "worker-registry.json"
HOST = "db.01m276fzstgaf9hnbarb66613f.demo.vela.run"
PORT = 23006
DB = "postgres"
LOCAL_PORT = 18082

def log(message):
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    text = f"[{stamp}] {message}"
    print(text, flush=True)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(text + "\n")

def cleanup_orphans():
    # A Scheduled Task stop does not reliably terminate child uvicorn/cloudflared
    # processes on Windows. Clean only this standby stack before taking ownership.
    script = (
        "Get-CimInstance Win32_Process | Where-Object { "
        "($_.CommandLine -match '--port 18082') -or "
        "($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match '127\\.0\\.0\\.1:18082') "
        "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", script],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW,
        check=False,
    )

def kill_tree(proc):
    if proc is None or proc.poll() is not None:
        return
    subprocess.run(
        ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW,
        check=False,
    )

def tunnel_rate_limited():
    try:
        text = TUNNEL_LOG.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return False
    lower = text.lower()
    return "status 429" in lower or "error code: 1015" in lower

def ensure_token():
    if TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(48)
    TOKEN_FILE.write_text(token, encoding="utf-8")
    return token

def pg_credentials():
    pgpass = Path(os.environ["APPDATA"]) / "postgresql" / "pgpass.conf"
    prefix = f"{HOST}:{PORT}:{DB}:"
    line = next((x for x in pgpass.read_text(encoding="utf-8").splitlines() if x.startswith(prefix)), None)
    if not line:
        raise RuntimeError("PGPASS_ENTRY_NOT_FOUND")
    parts = line.split(":")
    return parts[3], ":".join(parts[4:])

def publish_registry(url):
    payload = (
        '{\n'
        f'  "workerUrl": "{url}",\n'
        '  "enabled": true,\n'
        '  "shadowMode": true,\n'
        '  "productionConfirmed": false,\n'
        f'  "updatedAt": "{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}"\n'
        '}\n'
    )
    if not REGISTRY_REPO.exists():
        raise RuntimeError("REGISTRY_REPO_MISSING")
    subprocess.run(["git", "-C", str(REGISTRY_REPO), "fetch", "origin", "worldmax-registry"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    subprocess.run(["git", "-C", str(REGISTRY_REPO), "reset", "--hard", "origin/worldmax-registry"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    REGISTRY_FILE.write_text(payload, encoding="utf-8")
    subprocess.run(["git", "-C", str(REGISTRY_REPO), "add", "worker-registry.json"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    diff = subprocess.run(["git", "-C", str(REGISTRY_REPO), "diff", "--cached", "--quiet"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    if diff.returncode == 0:
        return
    subprocess.run(["git", "-C", str(REGISTRY_REPO), "commit", "-m", "Refresh World-Max tunnel registry"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    subprocess.run(["git", "-C", str(REGISTRY_REPO), "push", "origin", "worldmax-registry"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)


def upsert_runtime_config(url, token):
    import psycopg
    user, password = pg_credentials()
    with psycopg.connect(
        host=HOST, port=PORT, dbname=DB, user=user, password=password, sslmode="require"
    ) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS fc_world_max_runtime_config_v1 (
              game_year VARCHAR(2) PRIMARY KEY,
              enabled BOOLEAN NOT NULL DEFAULT FALSE,
              worker_url TEXT,
              worker_token TEXT,
              shadow_mode BOOLEAN NOT NULL DEFAULT TRUE,
              production_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        conn.execute("""
            INSERT INTO fc_world_max_runtime_config_v1
              (game_year, enabled, worker_url, worker_token, shadow_mode, production_confirmed, updated_at)
            VALUES ('27', TRUE, %s, %s, FALSE, FALSE, NOW())
            ON CONFLICT (game_year) DO UPDATE SET
              enabled = EXCLUDED.enabled,
              worker_url = EXCLUDED.worker_url,
              worker_token = EXCLUDED.worker_token,
              shadow_mode = EXCLUDED.shadow_mode,
              production_confirmed = EXCLUDED.production_confirmed,
              updated_at = NOW()
        """, (url, token))
        conn.commit()

def worker_env(token):
    env = os.environ.copy()
    env["ENABLE_CHRONOS2"] = "1"
    env["ENABLE_TIMESFM3_SHADOW"] = "0"
    env["WORLD_MAX_DEVICE"] = "auto"
    env["WORLD_MAX_ML_WORKER_TOKEN"] = token
    return env

def start_worker(token):
    return subprocess.Popen(
        [str(PYTHON), "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", str(LOCAL_PORT)],
        cwd=str(WORKER),
        env=worker_env(token),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
def wait_health(timeout=90):
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{LOCAL_PORT}/health"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(2)
    return False

def start_tunnel():
    log_handle = TUNNEL_LOG.open("w", encoding="utf-8")
    proc = subprocess.Popen(
        [str(CLOUDFLARED), "tunnel", "--url", f"http://127.0.0.1:{LOCAL_PORT}", "--protocol", "http2", "--region", "us", "--edge-ip-version", "4", "--no-autoupdate"],
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    return proc, log_handle

def wait_tunnel_url(proc, timeout=90):
    deadline = time.time() + timeout
    pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
    while time.time() < deadline:
        try:
            text = TUNNEL_LOG.read_text(encoding="utf-8", errors="replace") if TUNNEL_LOG.exists() else ""
        except Exception:
            text = ""
        match = pattern.search(text)
        if match:
            return match.group(0)
        if tunnel_rate_limited():
            return None
        if proc.poll() is not None:
            return None
        time.sleep(1)
    return None

def public_health(url):
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/health", timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False

def wait_public_health(url, timeout=45):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if public_health(url):
            return True
        time.sleep(2)
    return False

def main():
    token = ensure_token()
    log("World-Max watchdog starting")
    cleanup_orphans()
    backoff = 5
    while True:
        worker = start_worker(token)
        if not wait_health():
            log("Worker health failed, restarting")
            kill_tree(worker)
            time.sleep(backoff)
            continue
        log("CUDA Chronos worker healthy")
        tunnel, tunnel_log = start_tunnel()
        url = wait_tunnel_url(tunnel)
        if not url:
            limited = tunnel_rate_limited()
            log("Tunnel URL missing" + (" (Cloudflare rate limited)" if limited else "") + ", restarting pair")
            kill_tree(tunnel)
            tunnel_log.close()
            kill_tree(worker)
            if limited:
                backoff = min(max(backoff * 2, 30), 300)
            time.sleep(backoff)
            continue
        if not wait_public_health(url):
            limited = tunnel_rate_limited()
            log("Public tunnel health failed" + (" (Cloudflare rate limited)" if limited else "") + ", recycling pair")
            kill_tree(tunnel)
            tunnel_log.close()
            kill_tree(worker)
            if limited:
                backoff = min(max(backoff * 2, 30), 300)
            time.sleep(backoff)
            continue
        backoff = 5
        try:
            publish_registry(url)
            log("Public registry updated after tunnel health passed")
        except Exception as exc:
            log("Public registry update failed: " + str(exc))
        try:
            upsert_runtime_config(url, token)
            log("Runtime config updated in PostgreSQL after public health passed")
        except Exception as exc:
            log("Runtime config update failed: " + str(exc))

        while worker.poll() is None and tunnel.poll() is None:
            time.sleep(30)
            if not wait_health(timeout=5):
                log("Local worker health failed, recycling pair")
                break

        log("Worker or tunnel unhealthy, recycling pair")
        if worker.poll() is None:
            kill_tree(worker)
        if tunnel.poll() is None:
            kill_tree(tunnel)
        tunnel_log.close()
        time.sleep(5)

if __name__ == "__main__":
    main()

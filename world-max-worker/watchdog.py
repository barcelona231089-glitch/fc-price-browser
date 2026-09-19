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
        [str(CLOUDFLARED), "tunnel", "--url", f"http://127.0.0.1:{LOCAL_PORT}", "--no-autoupdate"],
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
    while True:
        worker = start_worker(token)
        if not wait_health():
            log("Worker health failed, restarting")
            worker.kill()
            time.sleep(5)
            continue
        log("CUDA Chronos worker healthy")
        tunnel, tunnel_log = start_tunnel()
        url = wait_tunnel_url(tunnel)
        if not url:
            log("Tunnel URL missing, restarting pair")
            tunnel.kill()
            tunnel_log.close()
            worker.kill()
            time.sleep(5)
            continue
        try:
            upsert_runtime_config(url, token)
            log("Runtime config updated in PostgreSQL")
        except Exception as exc:
            log("Runtime config update failed: " + str(exc))

        while worker.poll() is None and tunnel.poll() is None:
            time.sleep(30)
            if not wait_health(timeout=5):
                log("Local worker health failed, recycling pair")
                break

        log("Worker or tunnel unhealthy, recycling pair")
        if worker.poll() is None:
            worker.kill()
        if tunnel.poll() is None:
            tunnel.kill()
        tunnel_log.close()
        time.sleep(5)

if __name__ == "__main__":
    main()

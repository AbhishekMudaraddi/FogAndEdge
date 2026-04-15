"""
Edge layer: synthetic thermal sensors → Amazon SQS.
Runs on Elastic Beanstalk with Gunicorn (entrypoint: application).
"""
from __future__ import annotations

import json
import logging
import os
import random
import threading
import time
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from flask import Flask, jsonify, request, Response

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

SENSOR_TYPES = (
    "rack_temperature",
    "room_temperature",
    "humidity",
    "airflow",
    "outdoor_temperature",
)

UNITS = {
    "rack_temperature": "°C",
    "room_temperature": "°C",
    "humidity": "%",
    "airflow": "m/s",
    "outdoor_temperature": "°C",
}


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return float(raw)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return int(raw)


SENSOR_FREQUENCY = _env_float("SENSOR_FREQUENCY", 30.0)
DISPATCH_RATE = max(1, _env_int("DISPATCH_RATE", 1))
RACK_IDS_RAW = os.environ.get(
    "RACK_IDS",
    "ew1-az1-r1,ew1-az1-r2,ew1-az1-r3,ew1-az2-r1,ew1-az2-r2,ew1-az2-r3,ew1-az3-r1,ew1-az3-r2,ew1-az3-r3,"
    "ue1-az1-r1,ue1-az1-r2,ue1-az1-r3,ue1-az2-r1,ue1-az2-r2,ue1-az2-r3,ue1-az3-r1,ue1-az3-r2,ue1-az3-r3,"
    "ue2-az1-r1,ue2-az1-r2,ue2-az1-r3,ue2-az2-r1,ue2-az2-r2,ue2-az2-r3,ue2-az3-r1,ue2-az3-r2,ue2-az3-r3,"
    "as1-az1-r1,as1-az1-r2,as1-az1-r3,as1-az2-r1,as1-az2-r2,as1-az2-r3,as1-az3-r1,as1-az3-r2,as1-az3-r3,"
    "ase1-az1-r1,ase1-az1-r2,ase1-az1-r3,ase1-az2-r1,ase1-az2-r2,ase1-az2-r3,ase1-az3-r1,ase1-az3-r2,ase1-az3-r3,"
    "an1-az1-r1,an1-az1-r2,an1-az1-r3,an1-az2-r1,an1-az2-r2,an1-az2-r3,an1-az3-r1,an1-az3-r2,an1-az3-r3",
)
RACK_IDS = tuple(x.strip() for x in RACK_IDS_RAW.split(",") if x.strip())
if not RACK_IDS:
    RACK_IDS = ("rack_01", "rack_02", "rack_03")
DATACENTER_ID = os.environ.get("DATACENTER_ID", "DC-01")
# Prefer rack_id on each reading; datacenter_id optional for dashboards
SQS_QUEUE_URL = os.environ.get("SQS_QUEUE_URL", "").strip()
AWS_REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))

_sqs = None
_cycle_count = 0
_stop_event = threading.Event()
_worker_thread: threading.Thread | None = None

# Ireland (eu-west-1) racks use the "ew1-" prefix in rack IDs.
# Persist simulation on/off in a file so every Gunicorn worker shares the same state.
_critical_sim_lock = threading.Lock()
IRELAND_SIM_STATE_FILE = os.environ.get(
    "EDGE_IRELAND_SIM_STATE_FILE",
    os.path.join(os.environ.get("TMPDIR", "/tmp"), "edge_ireland_critical_sim"),
)
# Optional: set EDGE_SIM_KEY in EB to require Bearer token or ?key= on simulation routes.
EDGE_SIM_KEY = os.environ.get("EDGE_SIM_KEY", "").strip()

NORMAL_RACK_TEMP_MIN = 28.0
NORMAL_RACK_TEMP_MAX = 34.0
SIM_CRITICAL_RACK_TEMP_MIN = 40.5
SIM_CRITICAL_RACK_TEMP_MAX = 43.0

_RACK_REGION_BY_PREFIX = {
    "ew1": "eu-west-1",
    "ue1": "us-east-1",
    "ue2": "us-east-2",
    "as1": "ap-south-1",
    "ase1": "ap-southeast-1",
    "an1": "ap-northeast-1",
}


def get_sqs_client():
    global _sqs
    if _sqs is None:
        _sqs = boto3.client("sqs", region_name=AWS_REGION)
    return _sqs


def _is_ireland_rack(rack_id: str) -> bool:
    return rack_id.lower().startswith("ew1-")


def _read_ireland_sim_file() -> bool:
    try:
        with open(IRELAND_SIM_STATE_FILE, "r", encoding="ascii") as f:
            return f.read().strip() == "1"
    except OSError:
        return False


def _write_ireland_sim_file(active: bool) -> None:
    directory = os.path.dirname(IRELAND_SIM_STATE_FILE)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp_path = IRELAND_SIM_STATE_FILE + ".tmp"
    payload = "1" if active else "0"
    with _critical_sim_lock:
        with open(tmp_path, "w", encoding="ascii") as f:
            f.write(payload)
        os.replace(tmp_path, IRELAND_SIM_STATE_FILE)


def _ireland_sim_active() -> bool:
    return _read_ireland_sim_file()


def _random_value(sensor_type: str, rack_id: str, ireland_sim: bool) -> float:
    if sensor_type == "rack_temperature":
        if ireland_sim and _is_ireland_rack(rack_id):
            return round(random.uniform(SIM_CRITICAL_RACK_TEMP_MIN, SIM_CRITICAL_RACK_TEMP_MAX), 2)
        return round(random.uniform(NORMAL_RACK_TEMP_MIN, NORMAL_RACK_TEMP_MAX), 2)
    if sensor_type == "room_temperature":
        return round(random.uniform(18.0, 28.0), 2)
    if sensor_type == "humidity":
        # Stay above Lambda static_risk threshold (<20%).
        return round(random.uniform(30.0, 60.0), 2)
    if sensor_type == "airflow":
        # Stay at/above Lambda cooling_failure threshold (<1.2 m/s).
        return round(random.uniform(1.2, 3.5), 2)
    if sensor_type == "outdoor_temperature":
        return round(random.uniform(-5.0, 35.0), 2)
    return 0.0


def _region_from_rack_id(rack_id: str) -> str:
    prefix = rack_id.split("-", 1)[0].lower()
    return _RACK_REGION_BY_PREFIX.get(prefix, AWS_REGION)


def _az_from_rack_id(rack_id: str) -> str:
    parts = rack_id.split("-")
    if len(parts) >= 3 and parts[1].startswith("az"):
        return "-".join(parts[:2])
    return rack_id


def build_reading_batch() -> list[dict[str, Any]]:
    """One batch: 5 readings per rack, shared ISO timestamp (UTC)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    ireland_sim = _ireland_sim_active()
    batch = []
    for rack_id in RACK_IDS:
        for st in SENSOR_TYPES:
            batch.append(
                {
                    "sensor_type": st,
                    "value": _random_value(st, rack_id, ireland_sim),
                    "unit": UNITS[st],
                    "timestamp": ts,
                    "rack_id": rack_id,
                    "az_id": _az_from_rack_id(rack_id),
                    "datacenter_id": DATACENTER_ID,
                    "region": _region_from_rack_id(rack_id),
                }
            )
    return batch


def publish_batch(batch: list[dict[str, Any]]) -> None:
    if not SQS_QUEUE_URL:
        logger.warning("SQS_QUEUE_URL not set; skipping publish (dev mode)")
        return
    body = json.dumps(batch)
    try:
        get_sqs_client().send_message(QueueUrl=SQS_QUEUE_URL, MessageBody=body)
        logger.info("Published batch of %s readings to SQS", len(batch))
    except (ClientError, BotoCoreError) as e:
        logger.exception("SQS send failed: %s", e)


def sensor_loop() -> None:
    global _cycle_count
    logger.info(
        "Sensor worker started: every %ss, dispatch every %s cycle(s)",
        SENSOR_FREQUENCY,
        DISPATCH_RATE,
    )
    while not _stop_event.is_set():
        _cycle_count += 1
        batch = build_reading_batch()
        if _cycle_count % DISPATCH_RATE == 0:
            publish_batch(batch)
        time.sleep(SENSOR_FREQUENCY)


def start_background_worker() -> None:
    global _worker_thread
    if _worker_thread is not None and _worker_thread.is_alive():
        return
    _stop_event.clear()
    _worker_thread = threading.Thread(target=sensor_loop, name="sensor-sim", daemon=True)
    _worker_thread.start()


application = Flask(__name__)


def _sim_auth_ok() -> bool:
    if not EDGE_SIM_KEY:
        return True
    auth = request.headers.get("Authorization", "")
    if auth == f"Bearer {EDGE_SIM_KEY}":
        return True
    if request.args.get("key") == EDGE_SIM_KEY:
        return True
    payload = request.get_json(silent=True)
    return isinstance(payload, dict) and payload.get("key") == EDGE_SIM_KEY


@application.get("/")
def health():
    """Elastic Beanstalk health check."""
    return jsonify(
        {
            "status": "ok",
            "layer": "edge",
            "rack_ids": list(RACK_IDS),
            "sqs_configured": bool(SQS_QUEUE_URL),
            "sensor_frequency_s": SENSOR_FREQUENCY,
            "dispatch_every_n_cycles": DISPATCH_RATE,
            "readings_per_batch": len(SENSOR_TYPES) * len(RACK_IDS),
            "ireland_critical_simulation": _ireland_sim_active(),
            "sim_auth_required": bool(EDGE_SIM_KEY),
        }
    )


@application.get("/health")
def health_probe():
    """Lightweight path for load balancer health checks (same info as /)."""
    return health()


@application.get("/debug/last-batch")
def debug_last_batch():
    """Optional: inspect shape without SQS (same structure as published)."""
    return jsonify(build_reading_batch())


@application.get("/sim/critical/status")
def sim_critical_status():
    return jsonify(
        {
            "active": _ireland_sim_active(),
            "target_region": "eu-west-1",
            "target_rack_prefix": "ew1-",
            "state_file": IRELAND_SIM_STATE_FILE,
            "description": "When active, all Ireland (ew1-*) rack_temperature readings are in the critical band (>40°C).",
        }
    )


@application.post("/sim/critical/start")
def sim_critical_start():
    if not _sim_auth_ok():
        return jsonify({"error": "Unauthorized"}), 401
    _write_ireland_sim_file(True)
    logger.warning("Ireland critical simulation STARTED (ew1 racks → critical temps)")
    return jsonify(
        {
            "active": True,
            "message": "Ireland (eu-west-1) racks now simulate critical rack temperatures.",
        }
    )


@application.post("/sim/critical/stop")
def sim_critical_stop():
    if not _sim_auth_ok():
        return jsonify({"error": "Unauthorized"}), 401
    _write_ireland_sim_file(False)
    logger.info("Ireland critical simulation STOPPED (normal temperature bands)")
    return jsonify({"active": False, "message": "Simulation off; all racks use normal bands."})


_SIM_PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Edge — critical simulation</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e6edf3; }
    body { max-width: 520px; margin: 40px auto; padding: 0 16px; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p { color: #8b949e; font-size: 0.9rem; line-height: 1.5; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0; }
    button {
      border: none; border-radius: 8px; padding: 10px 18px; font-size: 0.95rem;
      font-weight: 600; cursor: pointer;
    }
    .start { background: #da3633; color: #fff; }
    .stop { background: #238636; color: #fff; }
    .status { margin-top: 12px; padding: 12px; border-radius: 8px; background: #161b22; border: 1px solid #30363d; font-size: 0.85rem; white-space: pre-wrap; }
    label { display: block; font-size: 0.8rem; color: #8b949e; margin-bottom: 4px; }
    input { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; }
  </style>
</head>
<body>
  <h1>Ireland critical simulation</h1>
  <p>Default telemetry stays in normal bands (rack temp &lt; 35°C). Use <strong>Start</strong> to push
  all <code>ew1-*</code> (Ireland) rack temperatures into the critical range (&gt;40°C) so the fog layer and dashboard show alerts.
  <strong>Stop</strong> returns to normal bands.</p>
  <div class="row">
    <button type="button" class="start" id="btn-start">Start simulation</button>
    <button type="button" class="stop" id="btn-stop">Stop simulation</button>
  </div>
  <label for="sim-key">API key (only if EDGE_SIM_KEY is set on this environment)</label>
  <input type="password" id="sim-key" placeholder="Leave blank if no key configured" autocomplete="off" />
  <div class="status" id="out">Loading status…</div>
  <script>
    const out = document.getElementById("out");
    const keyInput = document.getElementById("sim-key");
    async function headers() {
      const h = { "Content-Type": "application/json" };
      const k = (keyInput && keyInput.value) ? keyInput.value.trim() : "";
      if (k) h["Authorization"] = "Bearer " + k;
      return h;
    }
    async function refresh() {
      try {
        const r = await fetch("/sim/critical/status");
        const j = await r.json();
        out.textContent = JSON.stringify(j, null, 2);
      } catch (e) {
        out.textContent = "Status error: " + e;
      }
    }
    async function post(path) {
      try {
        const body = {};
        const k = (keyInput && keyInput.value) ? keyInput.value.trim() : "";
        if (k) body.key = k;
        const r = await fetch(path, { method: "POST", headers: await headers(), body: JSON.stringify(body) });
        const j = await r.json();
        out.textContent = JSON.stringify(j, null, 2);
        await refresh();
      } catch (e) {
        out.textContent = "Request error: " + e;
      }
    }
    document.getElementById("btn-start").addEventListener("click", () => post("/sim/critical/start"));
    document.getElementById("btn-stop").addEventListener("click", () => post("/sim/critical/stop"));
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>
"""


@application.get("/sim")
def sim_control_page():
    return Response(_SIM_PAGE_HTML, mimetype="text/html; charset=utf-8")


# Start worker when module loads (Gunicorn imports application)
start_background_worker()


if __name__ == "__main__":
    application.run(host="0.0.0.0", port=5000, debug=False)

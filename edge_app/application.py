
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
SQS_QUEUE_URL = os.environ.get("SQS_QUEUE_URL", "").strip()
AWS_REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))

_sqs = None
_cycle_count = 0
_stop_event = threading.Event()
_worker_thread: threading.Thread | None = None

_critical_sim_lock = threading.Lock()
SIM_STATE_FILE = os.environ.get(
    "EDGE_SIM_STATE_FILE",
    os.path.join(os.environ.get("TMPDIR", "/tmp"), "edge_critical_sim_state.json"),
)
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
_REGION_NAME_BY_CODE = {
    "eu-west-1": "Ireland",
    "us-east-1": "N. Virginia",
    "us-east-2": "Ohio",
    "ap-south-1": "Mumbai",
    "ap-southeast-1": "Singapore",
    "ap-northeast-1": "Tokyo",
}
_PREFIX_BY_REGION = {region: prefix for prefix, region in _RACK_REGION_BY_PREFIX.items()}
_DEFAULT_SIM_REGION = "eu-west-1"


def get_sqs_client():
    global _sqs
    if _sqs is None:
        _sqs = boto3.client("sqs", region_name=AWS_REGION)
    return _sqs


def _read_active_prefixes() -> set[str]:
    try:
        with open(SIM_STATE_FILE, "r", encoding="utf-8") as f:
            raw = f.read().strip()
    except OSError:
        return set()
    if not raw:
        return set()
    if raw == "1":
        prefix = _PREFIX_BY_REGION.get(_DEFAULT_SIM_REGION)
        return {prefix} if prefix else set()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return set()
    if not isinstance(payload, dict):
        return set()
    active = payload.get("active_prefixes")
    if not isinstance(active, list):
        return set()
    out: set[str] = set()
    for item in active:
        if isinstance(item, str):
            pref = item.strip().lower()
            if pref in _RACK_REGION_BY_PREFIX:
                out.add(pref)
    return out


def _write_active_prefixes(prefixes: set[str]) -> None:
    directory = os.path.dirname(SIM_STATE_FILE)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp_path = SIM_STATE_FILE + ".tmp"
    payload = json.dumps({"active_prefixes": sorted(prefixes)})
    with _critical_sim_lock:
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp_path, SIM_STATE_FILE)


def _active_sim_regions() -> list[dict[str, str]]:
    out = []
    for prefix in sorted(_read_active_prefixes()):
        code = _RACK_REGION_BY_PREFIX[prefix]
        out.append({"region": code, "name": _REGION_NAME_BY_CODE.get(code, code), "prefix": prefix})
    return out


def _normalize_region_list(raw_regions: Any) -> list[str]:
    if isinstance(raw_regions, str):
        items = [x.strip() for x in raw_regions.split(",") if x.strip()]
    elif isinstance(raw_regions, list):
        items = [str(x).strip() for x in raw_regions if str(x).strip()]
    else:
        items = []
    out: list[str] = []
    for region in items:
        if region in _PREFIX_BY_REGION and region not in out:
            out.append(region)
    return out


def _requested_regions() -> list[str]:
    payload = request.get_json(silent=True)
    if isinstance(payload, dict):
        if "regions" in payload and isinstance(payload.get("regions"), list):
            return _normalize_region_list(payload.get("regions"))
        regions = _normalize_region_list(payload.get("regions"))
        if regions:
            return regions
        single = payload.get("region")
        if isinstance(single, str) and single.strip() in _PREFIX_BY_REGION:
            return [single.strip()]
    query_regions = _normalize_region_list(request.args.get("regions"))
    if query_regions:
        return query_regions
    single_q = request.args.get("region")
    if isinstance(single_q, str) and single_q.strip() in _PREFIX_BY_REGION:
        return [single_q.strip()]
    return [_DEFAULT_SIM_REGION]


def _set_regions_active(regions: list[str], active: bool) -> list[str]:
    prefixes = _read_active_prefixes()
    changed: list[str] = []
    for region in regions:
        prefix = _PREFIX_BY_REGION.get(region)
        if not prefix:
            continue
        if active and prefix not in prefixes:
            prefixes.add(prefix)
            changed.append(region)
        elif not active and prefix in prefixes:
            prefixes.remove(prefix)
            changed.append(region)
    _write_active_prefixes(prefixes)
    return changed


def _random_value(sensor_type: str, rack_id: str, active_prefixes: set[str]) -> float:
    if sensor_type == "rack_temperature":
        rack_prefix = rack_id.split("-", 1)[0].lower()
        if rack_prefix in active_prefixes:
            return round(random.uniform(SIM_CRITICAL_RACK_TEMP_MIN, SIM_CRITICAL_RACK_TEMP_MAX), 2)
        return round(random.uniform(NORMAL_RACK_TEMP_MIN, NORMAL_RACK_TEMP_MAX), 2)
    if sensor_type == "room_temperature":
        return round(random.uniform(18.0, 28.0), 2)
    if sensor_type == "humidity":
        return round(random.uniform(30.0, 60.0), 2)
    if sensor_type == "airflow":
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
    active_prefixes = _read_active_prefixes()
    batch = []
    for rack_id in RACK_IDS:
        for st in SENSOR_TYPES:
            batch.append(
                {
                    "sensor_type": st,
                    "value": _random_value(st, rack_id, active_prefixes),
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


def publish_once_now() -> tuple[bool, str, int]:
    """Generate and publish one batch immediately."""
    if not SQS_QUEUE_URL:
        return False, "SQS_QUEUE_URL not set; cannot publish immediately.", 0
    batch = build_reading_batch()
    publish_batch(batch)
    return True, "Published one immediate batch to SQS.", len(batch)


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
            "critical_sim_regions": _active_sim_regions(),
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
            "active_regions": _active_sim_regions(),
            "available_regions": [
                {"region": code, "name": _REGION_NAME_BY_CODE.get(code, code), "prefix": _PREFIX_BY_REGION.get(code, "")}
                for code in sorted(_PREFIX_BY_REGION.keys())
            ],
        }
    )


@application.post("/sim/critical/start")
def sim_critical_start():
    if not _sim_auth_ok():
        return jsonify({"error": "Unauthorized"}), 401
    regions = _requested_regions()
    changed = _set_regions_active(regions, True)
    immediate = bool(request.args.get("publish_now", "1").strip() not in {"0", "false", "no"})
    publish_result: dict[str, Any] = {"attempted": False}
    if immediate:
        ok, msg, count = publish_once_now()
        publish_result = {"attempted": True, "ok": ok, "message": msg, "readings_published": count}
    logger.warning("Critical simulation STARTED for regions: %s", ",".join(regions))
    return jsonify(
        {
            "active_regions": _active_sim_regions(),
            "changed_regions": changed,
            "message": f"Critical simulation enabled for {', '.join(regions)}.",
            "immediate_publish": publish_result,
        }
    )


@application.post("/sim/critical/stop")
def sim_critical_stop():
    if not _sim_auth_ok():
        return jsonify({"error": "Unauthorized"}), 401
    regions = _requested_regions()
    changed = _set_regions_active(regions, False)
    logger.info("Critical simulation STOPPED for regions: %s", ",".join(regions))
    return jsonify(
        {
            "active_regions": _active_sim_regions(),
            "changed_regions": changed,
            "message": f"Critical simulation disabled for {', '.join(regions)}.",
        }
    )


@application.post("/sim/publish-now")
def sim_publish_now():
    if not _sim_auth_ok():
        return jsonify({"error": "Unauthorized"}), 401
    ok, msg, count = publish_once_now()
    status = 200 if ok else 503
    return jsonify({"ok": ok, "message": msg, "readings_published": count}), status


_SIM_PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Edge — critical simulation</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e6edf3; }
    body { max-width: 760px; margin: 32px auto; padding: 0 16px; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p { color: #8b949e; font-size: 0.9rem; line-height: 1.5; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0; }
    .targets { margin-top: 14px; padding: 12px; border: 1px solid #30363d; border-radius: 10px; background: #0d1117; }
    .targets h2 { margin: 0 0 8px; font-size: 1rem; }
    button {
      border: none; border-radius: 8px; padding: 10px 18px; font-size: 0.95rem;
      font-weight: 600; cursor: pointer;
    }
    .start { background: #da3633; color: #fff; }
    .stop { background: #238636; color: #fff; }
    .status { margin-top: 12px; padding: 12px; border-radius: 8px; background: #161b22; border: 1px solid #30363d; font-size: 0.9rem; }
    .hint { color: #9fb1c8; font-size: 0.82rem; }
    .active-list { margin-top: 14px; padding: 12px; border: 1px solid #30363d; border-radius: 10px; background: #0d1117; }
    .active-list h3 { margin: 0 0 8px; font-size: 1rem; }
    .active-item { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid #30363d; border-radius: 8px; background: #111720; margin-bottom: 8px; flex-wrap: wrap; }
    .active-item:last-child { margin-bottom: 0; }
    .active-empty { color: #8b949e; font-size: 0.88rem; }
    .active-meta small { display: block; color: #8b949e; font-size: 0.75rem; }
    .active-item .stop { margin-left: auto; min-width: 84px; }
    @media (max-width: 640px) {
      body { margin: 14px auto; padding: 0 10px 16px; }
      h1 { font-size: 1.1rem; margin: 0 0 8px; }
      p { font-size: 0.86rem; }
      .targets, .active-list, .status { padding: 10px; }
      .row { margin: 10px 0; }
      button { width: 100%; padding: 11px 12px; font-size: 0.92rem; }
      .active-item { align-items: stretch; }
      .active-meta { width: 100%; }
      .active-item .stop { width: 100%; margin-left: 0; }
    }
  </style>
</head>
<body>
  <h1>Multi-region disaster simulation</h1>
  <p>Choose one or more dashboard regions, then start/stop critical simulation for those regions.
  During simulation, rack temperatures in selected regions are forced into the critical band (&gt;40°C).</p>
  <div class="targets">
    <h2>Dashboard region</h2>
    <label for="region-select" class="hint">Select a region for simulation controls</label>
    <select id="region-select" style="width:100%;margin-top:8px;padding:10px;border-radius:8px;border:1px solid #30363d;background:#0b1220;color:#e6edf3;"></select>
  </div>
  <div class="row">
    <button type="button" class="start" id="btn-start-selected">Start</button>
  </div>
  <p class="hint">After start, the region appears below with its own Stop button.</p>
  <div class="status" id="out">Loading simulation status…</div>
  <div class="active-list">
    <h3>Started simulations</h3>
    <div id="active"></div>
  </div>
  <script>
    const out = document.getElementById("out");
    const activeEl = document.getElementById("active");
    const regionSelect = document.getElementById("region-select");
    let availableRegions = [];
    function selectedRegion() {
      return regionSelect && regionSelect.value ? regionSelect.value : "";
    }
    function renderRegionSelect() {
      if (!regionSelect) return;
      const prev = regionSelect.value;
      regionSelect.innerHTML = availableRegions
        .map((r) => `<option value="${r.region}">${r.name} (${r.region})</option>`)
        .join("");
      if (!availableRegions.length) return;
      regionSelect.value = availableRegions.some((r) => r.region === prev) ? prev : availableRegions[0].region;
    }
    function renderActiveList(activeRegions) {
      if (!activeEl) return;
      if (!Array.isArray(activeRegions) || !activeRegions.length) {
        activeEl.innerHTML = `<p class="active-empty">No running simulations.</p>`;
        return;
      }
      activeEl.innerHTML = activeRegions
        .map((r) => (
          `<div class="active-item">` +
          `<div class="active-meta"><strong>${r.name}</strong><small>${r.region}</small></div>` +
          `<button type="button" class="stop" data-stop-region="${r.region}">Stop</button>` +
          `</div>`
        ))
        .join("");
      activeEl.querySelectorAll("[data-stop-region]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const region = btn.getAttribute("data-stop-region");
          if (!region) return;
          post("/sim/critical/stop", { regions: [region] });
        });
      });
    }
    async function refresh() {
      try {
        const r = await fetch("/sim/critical/status");
        const j = await r.json();
        availableRegions = Array.isArray(j.available_regions) ? j.available_regions : [];
        renderRegionSelect();
        const active = Array.isArray(j.active_regions) ? j.active_regions : [];
        out.textContent = active.length
          ? `Simulation running in ${active.length} region(s).`
          : "No active simulation.";
        renderActiveList(active);
      } catch (e) {
        out.textContent = "Status error: " + e;
      }
    }
    async function post(path, body) {
      try {
        const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
        const j = await r.json();
        out.textContent = j.message || "Done.";
        if (j.active_regions) renderActiveList(j.active_regions);
        await refresh();
      } catch (e) {
        out.textContent = "Request error: " + e;
      }
    }
    document.getElementById("btn-start-selected").addEventListener("click", () => {
      const region = selectedRegion();
      if (!region) return;
      post("/sim/critical/start?publish_now=1", { regions: [region] });
    });
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>
"""


@application.get("/sim")
def sim_control_page():
    return Response(_SIM_PAGE_HTML, mimetype="text/html; charset=utf-8")


start_background_worker()


if __name__ == "__main__":
    application.run(host="0.0.0.0", port=5000, debug=False)

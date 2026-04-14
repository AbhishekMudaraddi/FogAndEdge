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
from flask import Flask, jsonify

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


def _random_value(sensor_type: str) -> float:
    if sensor_type == "rack_temperature":
        return round(random.uniform(28.0, 42.0), 2)
    if sensor_type == "room_temperature":
        return round(random.uniform(18.0, 28.0), 2)
    if sensor_type == "humidity":
        return round(random.uniform(30.0, 60.0), 2)
    if sensor_type == "airflow":
        return round(random.uniform(0.5, 3.5), 2)
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
    batch = []
    for rack_id in RACK_IDS:
        for st in SENSOR_TYPES:
            batch.append(
                {
                    "sensor_type": st,
                    "value": _random_value(st),
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


# Start worker when module loads (Gunicorn imports application)
start_background_worker()


if __name__ == "__main__":
    application.run(host="0.0.0.0", port=5000, debug=False)

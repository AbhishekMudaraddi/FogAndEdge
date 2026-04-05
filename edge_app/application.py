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


SENSOR_FREQUENCY = _env_float("SENSOR_FREQUENCY", 1.0)
DISPATCH_RATE = max(1, _env_int("DISPATCH_RATE", 1))
RACK_ID = os.environ.get("RACK_ID", "rack_01")
DATACENTER_ID = os.environ.get("DATACENTER_ID", "DC-01")
# Prefer rack_id on each reading; datacenter_id optional for dashboards
SQS_QUEUE_URL = os.environ.get("SQS_QUEUE_URL", "").strip()
AWS_REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))

_sqs = None
_cycle_count = 0
_stop_event = threading.Event()
_worker_thread: threading.Thread | None = None


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


def build_reading_batch() -> list[dict[str, Any]]:
    """One batch: exactly five readings, shared ISO timestamp (UTC)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    batch = []
    for st in SENSOR_TYPES:
        batch.append(
            {
                "sensor_type": st,
                "value": _random_value(st),
                "unit": UNITS[st],
                "timestamp": ts,
                "rack_id": RACK_ID,
                "datacenter_id": DATACENTER_ID,
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
            "rack_id": RACK_ID,
            "sqs_configured": bool(SQS_QUEUE_URL),
            "sensor_frequency_s": SENSOR_FREQUENCY,
            "dispatch_every_n_cycles": DISPATCH_RATE,
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

"""
Fog layer: SQS → enrich readings → DynamoDB (batch_writer, TTL).
Sort key: {sensor_type}#{timestamp} so Query + begins_with works per sensor.
"""
from __future__ import annotations

import json
import logging
from decimal import Decimal
from typing import Any

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource("dynamodb")

TTL_SECONDS = 7 * 24 * 60 * 60  # 604800


def _table():
    import os

    name = os.environ.get("DYNAMODB_TABLE_NAME", "").strip()
    if not name:
        raise RuntimeError("DYNAMODB_TABLE_NAME is not set")
    return dynamodb.Table(name)


def _to_decimal(x: Any) -> Decimal:
    if isinstance(x, Decimal):
        return x
    return Decimal(str(x))


def parse_body(raw: str) -> list[dict[str, Any]]:
    data = json.loads(raw)
    if isinstance(data, dict):
        return [data]
    if isinstance(data, list):
        return data
    raise ValueError("Body must be JSON object or array")


def index_by_type(readings: list[dict[str, Any]]) -> dict[str, float]:
    out: dict[str, float] = {}
    for r in readings:
        st = r.get("sensor_type")
        if st and "value" in r:
            try:
                out[str(st)] = float(r["value"])
            except (TypeError, ValueError):
                continue
    return out


def log_fog_enrichment(
    *,
    message_id: str | None,
    rack_id: str,
    readings_count: int,
    derived: dict[str, Any],
) -> None:
    """One JSON line per rack batch — easy to filter in CloudWatch Logs Insights."""
    oh = bool(derived.get("overheating"))
    cf = bool(derived.get("cooling_failure"))
    sr = bool(derived.get("static_risk"))
    flag_count = int(oh) + int(cf) + int(sr)
    ce = derived.get("cooling_efficiency")
    ce_out: float | None
    if ce is None:
        ce_out = None
    else:
        try:
            ce_out = round(float(ce), 6)
        except (TypeError, ValueError):
            ce_out = None
    payload = {
        "layer": "fog",
        "component": "lambda_fog",
        "event": "enrichment_batch",
        "message_id": message_id,
        "rack_id": rack_id,
        "readings_written": readings_count,
        "flags": {
            "overheating": oh,
            "cooling_failure": cf,
            "static_risk": sr,
        },
        "flag_count": flag_count,
        "cooling_efficiency": ce_out,
    }
    logger.info("%s", json.dumps(payload))


def compute_batch_derived(by_type: dict[str, float]) -> dict[str, Any]:
    rack = by_type.get("rack_temperature")
    room = by_type.get("room_temperature")
    outdoor = by_type.get("outdoor_temperature")
    airflow = by_type.get("airflow")
    humidity = by_type.get("humidity")

    cooling_efficiency = None
    if rack is not None and room is not None and outdoor is not None and rack != 0:
        cooling_efficiency = (room - outdoor) / rack

    overheating = bool(rack is not None and rack > 40.0)
    cooling_failure = bool(airflow is not None and airflow < 1.2)
    static_risk = bool(humidity is not None and humidity < 20.0)

    return {
        "cooling_efficiency": cooling_efficiency,
        "overheating": overheating,
        "cooling_failure": cooling_failure,
        "static_risk": static_risk,
    }


def enrich_item(
    reading: dict[str, Any],
    derived: dict[str, Any],
    expiry_ts: int,
) -> dict[str, Any]:
    rack_id = reading.get("rack_id") or reading.get("datacenter_id") or "unknown"
    sensor_type = reading.get("sensor_type")
    ts = reading.get("timestamp")
    if not sensor_type or not ts:
        raise ValueError("reading missing sensor_type or timestamp")

    sort_key = f"{sensor_type}#{ts}"
    item: dict[str, Any] = {
        "rack_id": str(rack_id),
        "sensor_timestamp": sort_key,
        "sensor_type": str(sensor_type),
        "value": _to_decimal(reading["value"]),
        "unit": str(reading.get("unit", "")),
        "timestamp": str(ts),
        "expiry_timestamp": int(expiry_ts),
        "overheating": derived["overheating"],
        "cooling_failure": derived["cooling_failure"],
        "static_risk": derived["static_risk"],
    }
    if reading.get("datacenter_id"):
        item["datacenter_id"] = str(reading["datacenter_id"])
    if reading.get("region"):
        item["region"] = str(reading["region"])

    ce = derived.get("cooling_efficiency")
    if ce is not None:
        item["cooling_efficiency"] = _to_decimal(round(ce, 6))
    return item


def process_records(records: list[dict[str, Any]], now_epoch: int) -> None:
    expiry_ts = now_epoch + TTL_SECONDS
    table = _table()

    with table.batch_writer() as batch:
        for rec in records:
            raw = rec.get("body", "")
            try:
                readings = parse_body(raw)
            except (json.JSONDecodeError, ValueError) as e:
                logger.warning("Skip bad message: %s", e)
                continue

            # If one SQS message contains multiple racks, compute derived flags per rack.
            grouped: dict[str, list[dict[str, Any]]] = {}
            for reading in readings:
                rack = str(reading.get("rack_id") or reading.get("datacenter_id") or "unknown")
                grouped.setdefault(rack, []).append(reading)

            for rack_id, rack_readings in grouped.items():
                by_type = index_by_type(rack_readings)
                derived = compute_batch_derived(by_type)
                log_fog_enrichment(
                    message_id=rec.get("messageId"),
                    rack_id=rack_id,
                    readings_count=len(rack_readings),
                    derived=derived,
                )
                for reading in rack_readings:
                    try:
                        item = enrich_item(reading, derived, expiry_ts)
                        batch.put_item(Item=item)
                    except (KeyError, ValueError, TypeError) as e:
                        logger.warning("Skip reading: %s data=%s", e, reading)


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    import time

    records = event.get("Records") or []
    now_epoch = int(time.time())
    if not records:
        return {"statusCode": 200, "body": json.dumps({"ok": True, "processed": 0})}

    process_records(records, now_epoch)
    logger.info(
        "%s",
        json.dumps(
            {
                "layer": "fog",
                "component": "lambda_fog",
                "event": "sqs_invoke_complete",
                "messages_processed": len(records),
            }
        ),
    )
    return {"statusCode": 200, "body": json.dumps({"ok": True, "processed": len(records)})}

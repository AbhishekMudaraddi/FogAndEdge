"""
Cloud layer: Flask API + HTML dashboard; reads DynamoDB via Query (no table scans).
"""
from __future__ import annotations

import logging
import os
import statistics
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from flask import Flask, jsonify, render_template, request

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

AWS_REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
TABLE_NAME = os.environ.get("DYNAMODB_TABLE_NAME", "").strip()
DEFAULT_RACK_ID = os.environ.get("RACK_ID", "rack_01")
RACK_IDS_RAW = os.environ.get("RACK_IDS", "rack_01,rack_02,rack_03")
RACK_IDS = [x.strip() for x in RACK_IDS_RAW.split(",") if x.strip()]
if not RACK_IDS:
    RACK_IDS = [DEFAULT_RACK_ID]
if DEFAULT_RACK_ID not in RACK_IDS:
    RACK_IDS.insert(0, DEFAULT_RACK_ID)

_ddb = boto3.resource("dynamodb", region_name=AWS_REGION)

_UNITS: dict[str, str] = {
    "rack_temperature": "°C",
    "room_temperature": "°C",
    "humidity": "%",
    "airflow": "m/s",
    "outdoor_temperature": "°C",
}

VALID_SENSORS: tuple[str, ...] = tuple(_UNITS.keys())


def rack_label(rack_id: str) -> str:
    parts = rack_id.split("_")
    if len(parts) == 2 and parts[1].isdigit():
        return f"Rack {int(parts[1])}"
    return rack_id.replace("_", " ").title()


def normalize_rack_id(raw: str | None) -> str:
    if raw and raw.strip():
        return raw.strip()
    return DEFAULT_RACK_ID


def get_table():
    if not TABLE_NAME:
        raise RuntimeError("DYNAMODB_TABLE_NAME is not set")
    return _ddb.Table(TABLE_NAME)


def decimal_to_native(obj: Any) -> Any:
    if isinstance(obj, list):
        return [decimal_to_native(x) for x in obj]
    if isinstance(obj, dict):
        return {k: decimal_to_native(v) for k, v in obj.items()}
    if isinstance(obj, Decimal):
        if obj % 1 == 0:
            return int(obj)
        return float(obj)
    return obj


def query_sensor(rack: str, sensor_type: str, limit: int) -> list[dict[str, Any]]:
    table = get_table()
    prefix = f"{sensor_type}#"
    kwargs: dict[str, Any] = {
        "KeyConditionExpression": Key("rack_id").eq(rack) & Key("sensor_timestamp").begins_with(prefix),
        "ScanIndexForward": False,
        "Limit": limit,
    }
    items: list[dict[str, Any]] = []
    while len(items) < limit:
        resp = table.query(**kwargs)
        chunk = resp.get("Items", [])
        for it in chunk:
            items.append(decimal_to_native(it))
            if len(items) >= limit:
                break
        lek = resp.get("LastEvaluatedKey")
        if not lek or len(items) >= limit:
            break
        kwargs["ExclusiveStartKey"] = lek
    return items[:limit]


def get_latest_for_rack(rack_id: str) -> tuple[dict[str, Any], list[str]]:
    out: dict[str, Any] = {}
    errors: list[str] = []
    for st in VALID_SENSORS:
        try:
            items = query_sensor(rack_id, st, 1)
            out[st] = items[0] if items else None
        except Exception as e:
            errors.append(f"{st}: {e}")
            out[st] = None
    return out, errors


application = Flask(__name__)


@application.get("/")
def dashboard():
    racks = [{"rack_id": rid, "label": rack_label(rid)} for rid in RACK_IDS]
    return render_template(
        "dashboard.html",
        rack_id=DEFAULT_RACK_ID,
        rack_ids=racks,
        poll_interval_ms=30000,
    )


@application.get("/api/racks")
def api_racks():
    return jsonify({"default_rack_id": DEFAULT_RACK_ID, "racks": [{"rack_id": rid, "label": rack_label(rid)} for rid in RACK_IDS]})


@application.get("/api/racks-summary")
def api_racks_summary():
    result: list[dict[str, Any]] = []
    errors: list[str] = []
    for rid in RACK_IDS:
        latest, rack_errors = get_latest_for_rack(rid)
        if rack_errors:
            errors.extend([f"{rid}: {e}" for e in rack_errors])
        result.append({"rack_id": rid, "label": rack_label(rid), "latest": latest})
    body: dict[str, Any] = {"racks": result}
    if errors:
        body["errors"] = errors
    return jsonify(decimal_to_native(body))


@application.get("/api/sensors/<sensor_type>")
def api_sensors(sensor_type: str):
    if sensor_type not in VALID_SENSORS:
        return jsonify({"error": "unknown sensor_type"}), 400
    rack_id = normalize_rack_id(request.args.get("rack_id"))
    n = min(max(request.args.get("n", default=50, type=int) or 50, 1), 500)
    try:
        items = query_sensor(rack_id, sensor_type, n)
    except Exception as e:
        logger.exception("Query failed")
        return jsonify({"error": str(e)}), 500

    values = [float(x["value"]) for x in items if "value" in x]
    stats_block = {}
    if values:
        stats_block = {
            "count": len(values),
            "mean": round(statistics.mean(values), 4),
            "min": round(min(values), 4),
            "max": round(max(values), 4),
        }
    return jsonify({"rack_id": rack_id, "sensor_type": sensor_type, "readings": items, "stats": stats_block})


@application.get("/api/stats/<sensor_type>")
def api_stats(sensor_type: str):
    if sensor_type not in VALID_SENSORS:
        return jsonify({"error": "unknown sensor_type"}), 400
    rack_id = normalize_rack_id(request.args.get("rack_id"))
    m = min(max(request.args.get("m", default=100, type=int) or 100, 2), 1000)
    try:
        items = query_sensor(rack_id, sensor_type, m)
    except Exception as e:
        logger.exception("Query failed")
        return jsonify({"error": str(e)}), 500

    values = [float(x["value"]) for x in items if "value" in x]
    if len(values) < 2:
        return jsonify({"rack_id": rack_id, "sensor_type": sensor_type, "count": len(values), "mean": values[0] if values else None, "min": min(values) if values else None, "max": max(values) if values else None, "stdev": None})

    return jsonify({"rack_id": rack_id, "sensor_type": sensor_type, "count": len(values), "mean": round(statistics.mean(values), 4), "min": round(min(values), 4), "max": round(max(values), 4), "stdev": round(statistics.stdev(values), 4)})


@application.get("/api/all-sensors")
def api_all_sensors():
    rack_id = normalize_rack_id(request.args.get("rack_id"))
    latest, errors = get_latest_for_rack(rack_id)
    body: dict[str, Any] = {"rack_id": rack_id, "latest": latest}
    if errors:
        body["errors"] = errors
    return jsonify(decimal_to_native(body))


@application.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "layer": "cloud",
        "rack_id": DEFAULT_RACK_ID,
        "rack_ids": RACK_IDS,
        "aws_region": AWS_REGION,
        "dynamodb_table_configured": bool(TABLE_NAME),
    })


@application.get("/api/diagnostics")
def api_diagnostics():
    rid = normalize_rack_id(request.args.get("rack_id"))
    out: dict[str, Any] = {
        "rack_id": rid,
        "rack_ids": RACK_IDS,
        "aws_region": AWS_REGION,
        "dynamodb_table_configured": bool(TABLE_NAME),
        "table_name": TABLE_NAME if TABLE_NAME else None,
    }
    if not TABLE_NAME:
        out["query_error"] = "DYNAMODB_TABLE_NAME is empty."
        return jsonify(out)
    try:
        sample = query_sensor(rid, "rack_temperature", 1)
        out["sample_query_ok"] = True
        out["rack_temperature_rows_found"] = len(sample)
    except Exception as e:
        out["sample_query_ok"] = False
        out["query_error"] = str(e)
    return jsonify(out)


if __name__ == "__main__":
    application.run(host="0.0.0.0", port=5001, debug=False)

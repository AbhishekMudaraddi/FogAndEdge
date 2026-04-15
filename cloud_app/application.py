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
SUPPORTED_REGIONS: tuple[dict[str, float | str], ...] = (
    {"code": "eu-west-1", "name": "Ireland", "lat": 53.3498, "lon": -6.2603},
    {"code": "eu-west-2", "name": "London", "lat": 51.5074, "lon": -0.1278},
    {"code": "eu-central-1", "name": "Frankfurt", "lat": 50.1109, "lon": 8.6821},
    {"code": "us-east-1", "name": "N. Virginia", "lat": 38.9072, "lon": -77.0369},
    {"code": "us-east-2", "name": "Ohio", "lat": 39.9612, "lon": -82.9988},
    {"code": "ap-south-1", "name": "Mumbai", "lat": 19.0760, "lon": 72.8777},
    {"code": "ap-southeast-1", "name": "Singapore", "lat": 1.3521, "lon": 103.8198},
    {"code": "ap-northeast-1", "name": "Tokyo", "lat": 35.6762, "lon": 139.6503},
)
DASHBOARD_REGIONS: tuple[str, ...] = (
    "eu-west-1",
    "us-east-1",
    "us-east-2",
    "ap-south-1",
    "ap-southeast-1",
    "ap-northeast-1",
)
REGION_AZ_RACKS: dict[str, list[str]] = {
    "eu-west-1": ["ew1-az1", "ew1-az2", "ew1-az3"],
    "us-east-1": ["ue1-az1", "ue1-az2", "ue1-az3"],
    "us-east-2": ["ue2-az1", "ue2-az2", "ue2-az3"],
    "ap-south-1": ["as1-az1", "as1-az2", "as1-az3"],
    "ap-southeast-1": ["ase1-az1", "ase1-az2", "ase1-az3"],
    "ap-northeast-1": ["an1-az1", "an1-az2", "an1-az3"],
}


def rack_label(rack_id: str) -> str:
    low = rack_id.lower()
    if "-az" in low:
        prefix, az = low.split("-az", 1)
        return f"{prefix.upper()} / AZ-{az}"
    parts = rack_id.split("_")
    if len(parts) == 2 and parts[1].isdigit():
        return f"Rack {int(parts[1])}"
    return rack_id.replace("_", " ").title()


def normalize_region(raw: str | None) -> str:
    if raw and raw.strip():
        candidate = raw.strip()
        if candidate in REGION_AZ_RACKS:
            return candidate
    if AWS_REGION in REGION_AZ_RACKS:
        return AWS_REGION
    return DASHBOARD_REGIONS[0]


def racks_for_region(region: str) -> list[str]:
    return REGION_AZ_RACKS.get(region, RACK_IDS)


def racks_for_az(az_id: str) -> list[str]:
    return [f"{az_id}-r1", f"{az_id}-r2", f"{az_id}-r3"]


def is_az_scope(scope_id: str) -> bool:
    return "-az" in scope_id and "-r" not in scope_id


def normalize_rack_id(raw: str | None, region: str) -> str:
    allowed = racks_for_region(region)
    if raw and raw.strip():
        candidate = raw.strip()
        if candidate in allowed:
            return candidate
    return allowed[0] if allowed else DEFAULT_RACK_ID


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


def aggregate_latest_for_az(az_id: str) -> tuple[dict[str, Any], list[str]]:
    out: dict[str, Any] = {}
    errors: list[str] = []
    rack_ids = racks_for_az(az_id)
    normal_count = 0
    warning_count = 0
    critical_count = 0
    for st in VALID_SENSORS:
        values: list[float] = []
        items: list[dict[str, Any]] = []
        for rid in rack_ids:
            try:
                rows = query_sensor(rid, st, 1)
                if rows:
                    items.append(rows[0])
                    if "value" in rows[0]:
                        values.append(float(rows[0]["value"]))
            except Exception as e:
                errors.append(f"{rid}/{st}: {e}")
        if not items:
            out[st] = None
            continue
        base = dict(items[0])
        if values:
            base["value"] = round(sum(values) / len(values), 2)
        if st == "rack_temperature":
            for v in values:
                if v >= 40.0:
                    critical_count += 1
                elif v >= 35.0:
                    warning_count += 1
                else:
                    normal_count += 1
        base["rack_id"] = az_id
        base["az_id"] = az_id
        base["rack_count"] = len(items)
        base["rack_normal_count"] = normal_count
        base["rack_warning_count"] = warning_count
        base["rack_critical_count"] = critical_count
        base["overheating"] = any(bool(i.get("overheating")) for i in items)
        base["cooling_failure"] = any(bool(i.get("cooling_failure")) for i in items)
        base["static_risk"] = any(bool(i.get("static_risk")) for i in items)
        ce_vals = [float(i["cooling_efficiency"]) for i in items if i.get("cooling_efficiency") is not None]
        if ce_vals:
            base["cooling_efficiency"] = round(sum(ce_vals) / len(ce_vals), 6)
        out[st] = base
    return out, errors


def aggregate_sensor_series_for_az(az_id: str, sensor_type: str, limit: int) -> list[dict[str, Any]]:
    rack_ids = racks_for_az(az_id)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for rid in rack_ids:
        rows = query_sensor(rid, sensor_type, limit)
        for row in rows:
            ts = str(row.get("timestamp") or "")
            if not ts:
                continue
            grouped.setdefault(ts, []).append(row)
    timestamps = sorted(grouped.keys(), reverse=True)[:limit]
    out: list[dict[str, Any]] = []
    for ts in timestamps:
        rows = grouped[ts]
        vals = [float(r["value"]) for r in rows if "value" in r]
        if not vals:
            continue
        base = dict(rows[0])
        base["value"] = round(sum(vals) / len(vals), 2)
        base["rack_id"] = az_id
        base["az_id"] = az_id
        base["rack_count"] = len(rows)
        base["overheating"] = any(bool(i.get("overheating")) for i in rows)
        base["cooling_failure"] = any(bool(i.get("cooling_failure")) for i in rows)
        base["static_risk"] = any(bool(i.get("static_risk")) for i in rows)
        out.append(decimal_to_native(base))
    return out


def get_latest_for_rack(rack_id: str) -> tuple[dict[str, Any], list[str]]:
    if is_az_scope(rack_id):
        return aggregate_latest_for_az(rack_id)
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


def _dashboard_poll_interval_ms() -> int:
    """Dashboard/API polling interval for regional + detailed modal refresh."""
    raw = os.environ.get("DASHBOARD_POLL_INTERVAL_MS", "30000").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 30000
    # Keep a sensible floor to avoid accidental browser/API overload.
    return max(1000, value)


def _render_dashboard(selected_region: str):
    region = normalize_region(selected_region)
    region_racks = racks_for_region(region)
    racks = [{"rack_id": rid, "label": rack_label(rid)} for rid in region_racks]
    return render_template(
        "dashboard.html",
        rack_id=region_racks[0] if region_racks else DEFAULT_RACK_ID,
        rack_ids=racks,
        poll_interval_ms=_dashboard_poll_interval_ms(),
        selected_region=region,
    )


def _dashboard_region_az_map() -> dict[str, list[str]]:
    """AZ scope ids per dashboard region (for globe / index client logic)."""
    return {r: list(REGION_AZ_RACKS[r]) for r in DASHBOARD_REGIONS if r in REGION_AZ_RACKS}


@application.get("/")
def landing():
    return render_template(
        "index.html",
        map_center={"lat": 53.3498, "lon": -6.2603},
        map_zoom=3,
        regions=SUPPORTED_REGIONS,
        dashboard_regions=DASHBOARD_REGIONS,
        region_az_ids=_dashboard_region_az_map(),
    )


@application.get("/dashboard")
def dashboard():
    return _render_dashboard(AWS_REGION)


@application.get("/az/<region>")
def dashboard_by_region(region: str):
    known = {str(item["code"]) for item in SUPPORTED_REGIONS}
    selected = region if region in known else AWS_REGION
    return _render_dashboard(selected)


@application.get("/api/racks")
def api_racks():
    region = normalize_region(request.args.get("region"))
    region_racks = racks_for_region(region)
    return jsonify(
        {
            "region": region,
            "default_rack_id": region_racks[0] if region_racks else DEFAULT_RACK_ID,
            "racks": [{"rack_id": rid, "label": rack_label(rid)} for rid in region_racks],
        }
    )


@application.get("/api/racks-summary")
def api_racks_summary():
    region = normalize_region(request.args.get("region"))
    region_racks = racks_for_region(region)
    result: list[dict[str, Any]] = []
    errors: list[str] = []
    for rid in region_racks:
        latest, rack_errors = get_latest_for_rack(rid)
        if rack_errors:
            errors.extend([f"{rid}: {e}" for e in rack_errors])
        result.append({"rack_id": rid, "label": rack_label(rid), "latest": latest})
    body: dict[str, Any] = {"region": region, "racks": result}
    if errors:
        body["errors"] = errors
    return jsonify(decimal_to_native(body))


@application.get("/api/sensors/<sensor_type>")
def api_sensors(sensor_type: str):
    if sensor_type not in VALID_SENSORS:
        return jsonify({"error": "unknown sensor_type"}), 400
    region = normalize_region(request.args.get("region"))
    rack_id = normalize_rack_id(request.args.get("rack_id"), region)
    n = min(max(request.args.get("n", default=50, type=int) or 50, 1), 500)
    try:
        if is_az_scope(rack_id):
            items = aggregate_sensor_series_for_az(rack_id, sensor_type, n)
        else:
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
    return jsonify({"region": region, "rack_id": rack_id, "sensor_type": sensor_type, "readings": items, "stats": stats_block})


@application.get("/api/stats/<sensor_type>")
def api_stats(sensor_type: str):
    if sensor_type not in VALID_SENSORS:
        return jsonify({"error": "unknown sensor_type"}), 400
    region = normalize_region(request.args.get("region"))
    rack_id = normalize_rack_id(request.args.get("rack_id"), region)
    m = min(max(request.args.get("m", default=100, type=int) or 100, 2), 1000)
    try:
        items = query_sensor(rack_id, sensor_type, m)
    except Exception as e:
        logger.exception("Query failed")
        return jsonify({"error": str(e)}), 500

    values = [float(x["value"]) for x in items if "value" in x]
    if len(values) < 2:
        return jsonify({"region": region, "rack_id": rack_id, "sensor_type": sensor_type, "count": len(values), "mean": values[0] if values else None, "min": min(values) if values else None, "max": max(values) if values else None, "stdev": None})

    return jsonify({"region": region, "rack_id": rack_id, "sensor_type": sensor_type, "count": len(values), "mean": round(statistics.mean(values), 4), "min": round(min(values), 4), "max": round(max(values), 4), "stdev": round(statistics.stdev(values), 4)})


@application.get("/api/all-sensors")
def api_all_sensors():
    region = normalize_region(request.args.get("region"))
    rack_id = normalize_rack_id(request.args.get("rack_id"), region)
    latest, errors = get_latest_for_rack(rack_id)
    body: dict[str, Any] = {"region": region, "rack_id": rack_id, "latest": latest}
    if errors:
        body["errors"] = errors
    return jsonify(decimal_to_native(body))


@application.get("/api/az-racks")
def api_az_racks():
    region = normalize_region(request.args.get("region"))
    az_id = request.args.get("az_id", type=str) or ""
    if not az_id or not is_az_scope(az_id):
        return jsonify({"error": "az_id is required and must look like <prefix>-az<n>"}), 400
    if az_id not in racks_for_region(region):
        return jsonify({"error": "az_id is not part of selected region"}), 400
    racks: list[dict[str, Any]] = []
    for rid in racks_for_az(az_id):
        latest, _ = get_latest_for_rack(rid)
        temp_series = query_sensor(rid, "rack_temperature", 35)
        temp_series = list(reversed(temp_series))
        racks.append(
            {
                "rack_id": rid,
                "label": rack_label(rid),
                "latest": latest,
                "rack_temperature_series": temp_series,
            }
        )
    return jsonify({"region": region, "az_id": az_id, "racks": decimal_to_native(racks)})


@application.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "layer": "cloud",
        "rack_id": DEFAULT_RACK_ID,
        "rack_ids": RACK_IDS,
        "dashboard_regions": list(DASHBOARD_REGIONS),
        "aws_region": AWS_REGION,
        "dynamodb_table_configured": bool(TABLE_NAME),
    })


@application.get("/api/diagnostics")
def api_diagnostics():
    region = normalize_region(request.args.get("region"))
    rid = normalize_rack_id(request.args.get("rack_id"), region)
    out: dict[str, Any] = {
        "region": region,
        "rack_id": rid,
        "rack_ids": racks_for_region(region),
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

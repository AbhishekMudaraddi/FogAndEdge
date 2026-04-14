# Version 1 Baseline (Current Project State)

This document freezes the current system as **Version 1**.

## Overview

Version 1 is an end-to-end fog-enabled thermal monitoring pipeline on AWS:

- Edge simulator service (Python/Flask) generates synthetic rack telemetry.
- Amazon SQS decouples producers (edge) from consumers (fog).
- AWS Lambda acts as fog processor and enriches readings.
- Amazon DynamoDB stores enriched, query-friendly time-series records.
- Cloud service (Python/Flask) serves APIs and dashboard views.

## What V1 Does Today

### 1) Edge Layer
- Runs as a Flask web app.
- Starts a background worker thread on process start.
- Generates 5 sensor channels per rack:
  - rack temperature
  - room temperature
  - humidity
  - airflow
  - outdoor temperature
- Publishes JSON batches to SQS at configurable intervals.

### 2) Fog Layer (Lambda)
- Triggered by SQS messages.
- Parses message body (single object or array).
- Groups readings per rack.
- Computes derived flags/metrics:
  - overheating
  - cooling failure
  - static risk
  - cooling efficiency
- Adds retention expiry timestamp (TTL basis).
- Writes items with batch writer into DynamoDB.
- Emits structured JSON logs for CloudWatch filtering.

### 3) Cloud Layer
- Queries DynamoDB using key-based access pattern.
- Exposes endpoints for:
  - rack list
  - rack summary
  - per-sensor history
  - per-sensor stats
  - diagnostics
- Converts Decimal types to JSON-native numbers.
- Serves dashboard HTML with periodic refresh behavior.

### 4) Data Model
- Partition key: rack id.
- Sort key pattern: sensor type + timestamp.
- Supports latest-per-sensor and history queries per rack.
- TTL-based retention avoids unbounded growth.

### 5) Deployment and Ops
- CI workflow packages/deploys edge and cloud apps to EB.
- Optional CI step updates fog Lambda code.
- Optional env-sync step updates EB environment variables.
- CloudWatch setup assets exist for dashboard and alarms.

## Known Constraints in V1

- Sensor realism is random and not time-correlated.
- Fog risk logic is threshold-based only (no trend/state memory).
- Dashboard supports monitoring but limited comparative analytics.
- No explicit dead-letter queue strategy documented in runtime flow.

## Version Marker

Treat this file as the formal **V1 snapshot** for report and presentation tracking.

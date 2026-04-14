# Version 2 Improvement Backlog

This backlog is prioritized for practical implementation from the current V1 baseline.

Priority legend:
- **P1** = high impact, do first
- **P2** = strong improvement, do after P1
- **P3** = advanced/future

Effort legend:
- **S** (small), **M** (medium), **L** (large)

---

## P1 - Immediate Value

### V2-01: Add time-correlated sensor realism
- **Goal:** make generated telemetry closer to real thermal behavior.
- **Effort:** M
- **Files:**
  - `edge_app/application.py`
- **Changes:**
  - Replace purely uniform random values with bounded drift/trend logic.
  - Add rack-specific baseline offsets.
  - Add occasional controlled anomaly injection windows.
- **Outcome:** more realistic charts, better demo credibility.

### V2-02: Add fog-side composite risk score
- **Goal:** provide one operational severity value per rack sample.
- **Effort:** M
- **Files:**
  - `lambda_fog/lambda_function.py`
  - `cloud_app/application.py`
  - `cloud_app/static/js/dashboard.js`
- **Changes:**
  - Compute weighted risk score (0-100) from existing flags + values.
  - Persist score in DynamoDB item.
  - Expose score in API and show on rack cards/modal.
- **Outcome:** easier prioritization than multiple independent booleans.

### V2-03: Add sustained-condition logic in fog rules
- **Goal:** avoid false positives from one noisy sample.
- **Effort:** M
- **Files:**
  - `lambda_fog/lambda_function.py`
- **Changes:**
  - Introduce “critical only if threshold breached for N cycles” policy.
  - Preserve rule behavior in structured logs for auditability.
- **Outcome:** fewer alert spikes and cleaner operations signal.

### V2-04: Add DLQ and failure playbook notes
- **Goal:** improve reliability when message processing fails.
- **Effort:** S
- **Files:**
  - `.github/workflows/deploy-aws.yml` (documentation or env support only if needed)
  - `docs/versions/` (runbook notes)
- **Changes:**
  - Ensure SQS dead-letter queue is configured in AWS.
  - Add operator runbook section for replay and triage.
- **Outcome:** safer failure recovery and cleaner incident handling.

---

## P2 - Dashboard and Analytics Enhancements

### V2-05: Add dashboard time-range controls
- **Goal:** compare 15m/1h/24h windows quickly.
- **Effort:** M
- **Files:**
  - `cloud_app/templates/dashboard.html`
  - `cloud_app/static/js/dashboard.js`
  - `cloud_app/application.py`
- **Changes:**
  - Add range selector UI.
  - Pass range to API query limits.
  - Redraw charts and stats per selected window.
- **Outcome:** stronger operations usability and presentation quality.

### V2-06: Add rack-to-rack comparative view
- **Goal:** quickly identify worst-performing rack.
- **Effort:** M
- **Files:**
  - `cloud_app/templates/dashboard.html`
  - `cloud_app/static/js/dashboard.js`
  - `cloud_app/application.py`
- **Changes:**
  - Add compare panel (top-N hot racks, risk-ranked table).
  - Include risk score and overheat duration in ranking.
- **Outcome:** better decision support for triage.

### V2-07: Add lightweight API response caching
- **Goal:** reduce repeated query overhead for frequent polling.
- **Effort:** S
- **Files:**
  - `cloud_app/application.py`
- **Changes:**
  - Cache short-lived summary responses (few seconds).
  - Invalidate quickly to preserve near-real-time behavior.
- **Outcome:** smoother dashboard performance under load.

---

## P3 - Advanced Capability

### V2-08: Add cross-rack analytics index strategy
- **Goal:** support query patterns beyond per-rack history.
- **Effort:** L
- **Files:**
  - `lambda_fog/lambda_function.py` (write shape if needed)
  - `cloud_app/application.py` (new query paths)
  - Infra docs (table/index provisioning)
- **Changes:**
  - Introduce secondary index for cross-rack time-window analytics.
  - Add APIs for fleet-wide sensor aggregation.
- **Outcome:** scalable fleet analytics foundation.

### V2-09: Add predictive trend warning
- **Goal:** detect rising-risk trajectory before hard threshold breach.
- **Effort:** M
- **Files:**
  - `cloud_app/application.py`
  - `cloud_app/static/js/dashboard.js`
  - optional `lambda_fog/lambda_function.py`
- **Changes:**
  - Add slope-based or rolling-window trend detection.
  - Surface “risk rising” early warnings.
- **Outcome:** proactive rather than reactive operations.

### V2-10: Add comprehensive test suite and CI gate
- **Goal:** improve confidence and release quality.
- **Effort:** M
- **Files:**
  - new tests under `edge_app/tests`, `lambda_fog/tests`, `cloud_app/tests`
  - `.github/workflows/deploy-aws.yml` (test/lint gate jobs)
- **Changes:**
  - Unit tests for fog derivation and parser behavior.
  - API tests for cloud query and stats endpoints.
  - CI fail-fast on regressions.
- **Outcome:** safer iteration and better maintainability.

---

## Suggested Delivery Order

1. V2-01 -> V2-02 -> V2-05  
2. V2-03 -> V2-06 -> V2-07  
3. V2-10 (parallel as early as possible)  
4. V2-08/V2-09 once operational baseline is stable

## Practical “Start Now” Scope (1 sprint)

If you want a focused first V2 sprint, implement:
- V2-01 (realistic data patterns)
- V2-02 (composite risk score)
- V2-05 (time-range controls)

This gives visible improvement in simulation quality, decision quality, and dashboard UX with manageable effort.

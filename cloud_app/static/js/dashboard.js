(function () {
  const cfg = window.APP_CONFIG || {};
  const POLL_MS = cfg.pollIntervalMs || 30000;
  const SENSOR_ORDER = [
    "rack_temperature",
    "room_temperature",
    "humidity",
    "airflow",
    "outdoor_temperature",
  ];
  const LABELS = {
    rack_temperature: "Rack °C",
    room_temperature: "Room °C",
    humidity: "Humidity %",
    airflow: "Airflow m/s",
    outdoor_temperature: "Outdoor °C",
  };

  /** Severity thresholds and anti-spam cooldown. */
  const RACK_TEMP_WARN_C = 35;
  const RACK_TEMP_CRIT_C = 40;
  const ALERT_COOLDOWN_TICKS = 4; // with 30s refresh => 2 min cooldown

  const statusEl = document.getElementById("status-line");
  const rackGrid = document.getElementById("rack-grid");
  const chartsRoot = document.getElementById("charts-root");
  const chartsTitle = document.getElementById("charts-title");
  const insightEl = document.getElementById("rack-insight");
  const alertsPanel = document.getElementById("alerts-panel");

  const racks = cfg.rackIds || [];
  let selectedRackId = cfg.defaultRackId || (racks[0] && racks[0].rack_id) || "rack_01";
  let chartState = {};
  const overheatState = {}; // rack_id -> consecutive hot intervals (30s each)
  const rackAlertMeta = {}; // rack_id -> last alert metadata
  let activeAlerts = [];
  let refreshTick = 0;

  function setStatus(text, ok) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = ok ? "var(--ok)" : "var(--warn)";
  }

  function rackName(rackId) {
    const rack = racks.find((r) => r.rack_id === rackId);
    return rack ? rack.label : rackId;
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    let body = null;
    try {
      body = await r.json();
    } catch (_) {
      body = null;
    }
    if (!r.ok) {
      const detail = body && body.error ? body.error : "request failed";
      throw new Error(r.status + " " + detail);
    }
    return body;
  }

  function metricCell(row, key) {
    const item = row && row[key] ? row[key] : null;
    if (!item) return "—";
    return `${Number(item.value).toFixed(2)} ${item.unit || ""}`;
  }

  function riskCount(row) {
    const keys = Object.keys(row || {});
    let count = 0;
    for (const k of keys) {
      const item = row[k];
      if (!item) continue;
      if (item.overheating || item.cooling_failure || item.static_risk) count += 1;
    }
    return count;
  }

  function extractLastTimestamp(latest) {
    if (!latest) return null;
    for (const key of SENSOR_ORDER) {
      if (latest[key] && latest[key].timestamp) return String(latest[key].timestamp);
    }
    return null;
  }

  function formatTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleTimeString();
  }

  function formatOverheatDuration(intervalCount) {
    const secs = Math.max(0, (intervalCount || 0) * Math.round(POLL_MS / 1000));
    if (secs === 0) return "0s";
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }

  function tempLevel(value) {
    if (value > RACK_TEMP_CRIT_C) return "critical";
    if (value > RACK_TEMP_WARN_C) return "warning";
    return "normal";
  }

  function renderRackCards(summary) {
    rackGrid.innerHTML = "";
    for (const rackRow of summary.racks || []) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "rack-card" + (rackRow.rack_id === selectedRackId ? " selected" : "");
      card.addEventListener("click", () => {
        selectedRackId = rackRow.rack_id;
        renderRackCards(summary);
        refreshCharts();
      });

      const title = document.createElement("h3");
      title.textContent = rackRow.label;

      const stats = document.createElement("div");
      stats.className = "rack-stats";
      stats.innerHTML =
        `<div><span>Rack Temp</span><strong>${metricCell(rackRow.latest, "rack_temperature")}</strong></div>` +
        `<div><span>Room Temp</span><strong>${metricCell(rackRow.latest, "room_temperature")}</strong></div>` +
        `<div><span>Humidity</span><strong>${metricCell(rackRow.latest, "humidity")}</strong></div>`;

      const risk = document.createElement("p");
      risk.className = "rack-risk";
      const rc = riskCount(rackRow.latest);
      const tempRow = rackRow.latest && rackRow.latest.rack_temperature ? rackRow.latest.rack_temperature : null;
      const tempVal = tempRow ? Number(tempRow.value) : null;
      const level = tempVal === null ? "normal" : tempLevel(tempVal);
      const statusLabel = level === "critical" ? "Critical" : level === "warning" ? "Warning" : "Normal";
      risk.textContent = `Status: ${statusLabel} · ${rc > 0 ? `${rc} active risk flag(s)` : "No active risk flags"}`;

      const metrics = document.createElement("div");
      metrics.className = "rack-metrics";
      const lastTs = extractLastTimestamp(rackRow.latest);
      const hotIntervals = overheatState[rackRow.rack_id] || 0;
      metrics.innerHTML =
        `<div><span>Last Update</span><strong>${formatTime(lastTs)}</strong></div>` +
        `<div><span>Overheat Duration</span><strong>${formatOverheatDuration(hotIntervals)}</strong></div>` +
        `<div><span>Risk Status</span><strong>${statusLabel}</strong></div>`;

      if (level === "critical") {
        card.classList.add("alert");
      } else if (level === "warning") {
        card.classList.add("warning");
      } else {
        card.classList.add("ok");
      }

      card.append(title, stats, metrics, risk);
      rackGrid.append(card);
    }
  }

  function enqueueAlert(message, level) {
    activeAlerts.unshift({
      message,
      level: level || "critical",
      ts: new Date().toLocaleTimeString(),
    });
    activeAlerts = activeAlerts.slice(0, 5);
  }

  function renderAlerts() {
    if (!alertsPanel) return;
    alertsPanel.innerHTML = "";
    if (!activeAlerts.length) return;
    for (const a of activeAlerts) {
      const item = document.createElement("div");
      item.className = "alert-item";
      if (a.level === "ok") item.classList.add("ok");
      if (a.level === "warning") item.classList.add("warning");
      if (a.level === "critical") item.classList.add("critical");
      item.textContent = `[${a.ts}] ${a.message}`;
      alertsPanel.appendChild(item);
    }
  }

  function updateOverheatDurations(summary) {
    refreshTick += 1;
    for (const rackRow of summary.racks || []) {
      const rid = rackRow.rack_id;
      const tempRow = rackRow.latest && rackRow.latest.rack_temperature ? rackRow.latest.rack_temperature : null;
      const tempVal = tempRow ? Number(tempRow.value) : null;
      const level = tempVal === null ? "normal" : tempLevel(tempVal);
      const hot = level !== "normal";
      const prev = overheatState[rid] || 0;
      const next = hot ? prev + 1 : 0;
      overheatState[rid] = next;
      const meta = rackAlertMeta[rid] || {
        lastLevel: "normal",
        lastWarnTick: -9999,
        lastCritTick: -9999,
        lastRecoveryTick: -9999,
      };
      const canWarn = refreshTick - meta.lastWarnTick >= ALERT_COOLDOWN_TICKS;
      const canCrit = refreshTick - meta.lastCritTick >= ALERT_COOLDOWN_TICKS;
      const canRecover = refreshTick - meta.lastRecoveryTick >= ALERT_COOLDOWN_TICKS;

      if (level === "warning" && meta.lastLevel === "normal" && canWarn) {
        enqueueAlert(`${rackRow.label} warning: rack temperature reached ${tempVal.toFixed(2)}°C (>= ${RACK_TEMP_WARN_C}°C).`, "warning");
        meta.lastWarnTick = refreshTick;
      }

      if (level === "critical" && meta.lastLevel !== "critical" && canCrit) {
        enqueueAlert(`${rackRow.label} critical: rack temperature is ${tempVal.toFixed(2)}°C (>= ${RACK_TEMP_CRIT_C}°C).`, "critical");
        meta.lastCritTick = refreshTick;
      }

      if (next === 1 && hot && canWarn) {
        enqueueAlert(`${rackRow.label} overheating for 30 seconds (temp ${tempVal.toFixed(2)}°C).`, level === "critical" ? "critical" : "warning");
        meta.lastWarnTick = refreshTick;
      } else if (next === 2 && hot && canCrit) {
        enqueueAlert(`${rackRow.label} overheating for 60 seconds. Immediate cooling action recommended.`, level === "critical" ? "critical" : "warning");
        meta.lastCritTick = refreshTick;
      } else if (!hot && prev > 0 && canRecover) {
        enqueueAlert(`${rackRow.label} temperature returned to normal range.`, "ok");
        meta.lastRecoveryTick = refreshTick;
      }
      meta.lastLevel = level;
      rackAlertMeta[rid] = meta;
    }
    renderAlerts();
  }

  function drawLineChart(canvas, labels, values, sensorType) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!values.length) {
      ctx.fillStyle = "#8b9bb4";
      ctx.font = "13px system-ui";
      ctx.fillText("No points", 8, 24);
      return;
    }
    const pad = 10;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const isHot = sensorType === "rack_temperature";
    ctx.strokeStyle = isHot ? "#e85d5d" : "#3d9cf5";
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = pad + (i / Math.max(values.length - 1, 1)) * (w - pad * 2);
      const y = pad + (1 - (v - min) / span) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = "#8b9bb4";
    ctx.font = "11px system-ui";
    ctx.fillText(labels[0] || "", pad, h - 2);
    ctx.textAlign = "right";
    ctx.fillText(labels[labels.length - 1] || "", w - pad, h - 2);
    ctx.textAlign = "left";

    // threshold guide line for quick interpretation.
    if (sensorType === "rack_temperature") {
      const yWarn = pad + (1 - (RACK_TEMP_WARN_C - min) / span) * (h - pad * 2);
      const yCrit = pad + (1 - (RACK_TEMP_CRIT_C - min) / span) * (h - pad * 2);
      if (yWarn >= pad && yWarn <= h - pad) {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "rgba(245,166,35,0.8)";
        ctx.beginPath();
        ctx.moveTo(pad, yWarn);
        ctx.lineTo(w - pad, yWarn);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (yCrit >= pad && yCrit <= h - pad) {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "rgba(232,93,93,0.8)";
        ctx.beginPath();
        ctx.moveTo(pad, yCrit);
        ctx.lineTo(w - pad, yCrit);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function ensureChart(sensorType) {
    if (chartState[sensorType]) return chartState[sensorType];
    const box = document.createElement("div");
    box.className = "chart-box" + (sensorType === "rack_temperature" ? " chart-box--primary" : "");
    const h4 = document.createElement("h4");
    h4.textContent = LABELS[sensorType] || sensorType;
    const canvas = document.createElement("canvas");
    canvas.width = 420;
    canvas.height = 170;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = "Loading...";
    box.append(h4, canvas, meta);
    chartsRoot.append(box);
    chartState[sensorType] = { canvas, meta };
    return chartState[sensorType];
  }

  function initCharts() {
    chartState = {};
    chartsRoot.innerHTML = "";
    SENSOR_ORDER.forEach((st) => ensureChart(st));
  }

  async function refreshSummary() {
    const data = await fetchJson("/api/racks-summary");
    updateOverheatDurations(data);
    renderRackCards(data);
    if (data.errors && data.errors.length) {
      setStatus("Data issue: " + data.errors[0], false);
    } else {
      setStatus("Last update: " + new Date().toLocaleTimeString(), true);
    }
  }

  async function refreshCharts() {
    chartsTitle.textContent = `Details of ${rackName(selectedRackId)}`;
    const insightBits = [];
    for (const st of SENSOR_ORDER) {
      try {
        const data = await fetchJson(`/api/sensors/${encodeURIComponent(st)}?rack_id=${encodeURIComponent(selectedRackId)}&n=20`);
        const readings = (data.readings || []).slice().reverse();
        const labels = readings.map((r) => (r.timestamp || "").slice(11, 19));
        const values = readings.map((r) => parseFloat(r.value));
        const { canvas, meta } = ensureChart(st);
        drawLineChart(canvas, labels, values, st);
        if (values.length > 1) {
          const latest = values[values.length - 1];
          const prev = values[values.length - 2];
          const delta = latest - prev;
          const trend = delta > 0 ? "rising" : delta < 0 ? "falling" : "stable";
          meta.textContent = `latest: ${latest.toFixed(2)} · trend: ${trend} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)} from previous sample)`;
          if (st === "rack_temperature" && latest >= RACK_TEMP_CRIT_C) {
            insightBits.push(`Rack temperature is CRITICAL at ${latest.toFixed(2)}°C (>= ${RACK_TEMP_CRIT_C}°C).`);
          } else if (st === "rack_temperature" && latest >= RACK_TEMP_WARN_C) {
            insightBits.push(`Rack temperature is in WARNING at ${latest.toFixed(2)}°C (>= ${RACK_TEMP_WARN_C}°C).`);
          }
          if (st === "airflow" && latest < 1.2) {
            insightBits.push(`Airflow dropped to ${latest.toFixed(2)} m/s, indicating possible cooling failure.`);
          }
        } else {
          meta.textContent = "insufficient points for trend";
        }
      } catch (e) {
        const { canvas, meta } = ensureChart(st);
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#f5a623";
        ctx.font = "11px system-ui";
        ctx.fillText("Chart error", 8, 18);
        meta.textContent = "unable to load this sensor";
      }
    }
    if (insightEl) {
      insightEl.textContent = insightBits.length
        ? insightBits.join(" ")
        : "System interpretation: this rack is currently in a normal operating band. Use trend lines below to identify early drift.";
    }
  }

  async function refreshAll() {
    try {
      await refreshSummary();
      await refreshCharts();
    } catch (e) {
      setStatus("Refresh error: " + e.message, false);
    }
  }

  initCharts();
  refreshAll();
  setInterval(refreshAll, POLL_MS);
})();

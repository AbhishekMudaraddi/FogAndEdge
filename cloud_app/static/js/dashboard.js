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

  /** Rack card red glow + chart guide + timed alerts use this °C threshold. */
  const RACK_TEMP_ALERT_C = 35;

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
  let activeAlerts = [];

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
      risk.textContent = rc > 0 ? `${rc} active risk flag(s)` : "No active risk flags";
      const tempRow = rackRow.latest && rackRow.latest.rack_temperature ? rackRow.latest.rack_temperature : null;
      const highTemp = !!(tempRow && Number(tempRow.value) > RACK_TEMP_ALERT_C);
      if (highTemp) {
        card.classList.add("alert");
      } else {
        card.classList.add("ok");
      }

      card.append(title, stats, risk);
      rackGrid.append(card);
    }
  }

  function enqueueAlert(message) {
    activeAlerts.unshift({
      message,
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
      item.textContent = `[${a.ts}] ${a.message}`;
      alertsPanel.appendChild(item);
    }
  }

  function updateOverheatDurations(summary) {
    for (const rackRow of summary.racks || []) {
      const rid = rackRow.rack_id;
      const tempRow = rackRow.latest && rackRow.latest.rack_temperature ? rackRow.latest.rack_temperature : null;
      const hot = !!(tempRow && Number(tempRow.value) > RACK_TEMP_ALERT_C);
      const prev = overheatState[rid] || 0;
      const next = hot ? prev + 1 : 0;
      overheatState[rid] = next;

      if (next === 1) {
        enqueueAlert(`${rackRow.label} overheating for 30 seconds (temp ${Number(tempRow.value).toFixed(2)}°C).`);
      } else if (next === 2) {
        enqueueAlert(`${rackRow.label} overheating for 60 seconds. Immediate cooling action recommended.`);
      } else if (!hot && prev > 0) {
        enqueueAlert(`${rackRow.label} temperature returned to normal range.`);
      }
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
      const y = pad + (1 - (RACK_TEMP_ALERT_C - min) / span) * (h - pad * 2);
      if (y >= pad && y <= h - pad) {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "rgba(232,93,93,0.7)";
        ctx.beginPath();
        ctx.moveTo(pad, y);
        ctx.lineTo(w - pad, y);
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
    renderRackCards(data);
    updateOverheatDurations(data);
    if (data.errors && data.errors.length) {
      setStatus("Data issue: " + data.errors[0], false);
    } else {
      setStatus("Last update: " + new Date().toLocaleTimeString(), true);
    }
  }

  async function refreshCharts() {
    chartsTitle.textContent = `Key trends — ${rackName(selectedRackId)}`;
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
          if (st === "rack_temperature" && latest > RACK_TEMP_ALERT_C) {
            insightBits.push(`Rack temperature is elevated at ${latest.toFixed(2)}°C (above ${RACK_TEMP_ALERT_C}°C).`);
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

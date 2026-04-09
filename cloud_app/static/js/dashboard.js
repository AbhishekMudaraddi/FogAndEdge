(function () {
  function readAppConfig() {
    const el = document.getElementById("app-config");
    if (!el || !el.textContent) return {};
    try {
      return JSON.parse(el.textContent.trim());
    } catch (_) {
      return {};
    }
  }
  const cfg = readAppConfig();
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
  const SENSOR_THRESHOLDS = {
    rack_temperature: { warnHigh: 35, critHigh: 40 },
    room_temperature: { warnHigh: 26, critHigh: 30 },
    humidity: { warnLow: 30, warnHigh: 60, critLow: 20, critHigh: 75 },
    airflow: { warnLow: 1.5, critLow: 1.2 },
    outdoor_temperature: { warnHigh: 35, critHigh: 42, warnLow: -5, critLow: -10 },
  };

  const statusEl = document.getElementById("status-line");
  const rackGrid = document.getElementById("rack-grid");
  const chartsTitle = document.getElementById("charts-title");
  const insightEl = document.getElementById("rack-insight");
  const alertsPanel = document.getElementById("alerts-panel");
  const rackDetailsList = document.getElementById("rack-details-list");
  const overviewKpis = document.getElementById("overview-kpis");
  const overviewPie = document.getElementById("overview-pie");
  const rackModal = document.getElementById("rack-modal");
  const rackModalClose = document.getElementById("rack-modal-close");
  const rackModalTitle = document.getElementById("rack-modal-title");
  const rackModalSub = document.getElementById("rack-modal-sub");
  const rackModalBody = document.getElementById("rack-modal-body");

  const racks = cfg.rackIds || [];
  let selectedRackId = cfg.defaultRackId || (racks[0] && racks[0].rack_id) || "rack_01";
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

  /**
   * Lambda copies the same overheating/cooling_failure/static_risk onto every sensor row
   * for a rack batch, so counting per-sensor would always show 5. Count distinct flags once.
   */
  function riskCount(row) {
    let item = null;
    for (const k of SENSOR_ORDER) {
      if (row && row[k]) {
        item = row[k];
        break;
      }
    }
    if (!item) return 0;
    let n = 0;
    if (item.overheating) n += 1;
    if (item.cooling_failure) n += 1;
    if (item.static_risk) n += 1;
    return n;
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

  function classifySensor(sensorType, value) {
    const t = SENSOR_THRESHOLDS[sensorType];
    if (!t || typeof value !== "number" || Number.isNaN(value)) return "normal";
    if ((t.critHigh !== undefined && value >= t.critHigh) || (t.critLow !== undefined && value <= t.critLow)) return "critical";
    if ((t.warnHigh !== undefined && value >= t.warnHigh) || (t.warnLow !== undefined && value <= t.warnLow)) return "warning";
    return "normal";
  }

  /** Matches rack card border and "Status: …" line (rack inlet temperature only). */
  function rackOperationalStatus(latest) {
    const tempRow = latest && latest.rack_temperature ? latest.rack_temperature : null;
    const tempVal = tempRow ? Number(tempRow.value) : null;
    if (tempVal === null || Number.isNaN(tempVal)) return "normal";
    return tempLevel(tempVal);
  }

  function drawOverviewPie(counts) {
    if (!overviewPie) return;
    const ctx = overviewPie.getContext("2d");
    const w = overviewPie.width;
    const h = overviewPie.height;
    const cx = 96;
    const cy = h / 2;
    const r = 62;
    const total = Math.max(1, counts.normal + counts.warning + counts.critical);
    ctx.clearRect(0, 0, w, h);
    const slices = [
      { key: "normal", label: "Normal", color: "#3ddc97", value: counts.normal },
      { key: "warning", label: "Warning", color: "#f5a623", value: counts.warning },
      { key: "critical", label: "Critical", color: "#e85d5d", value: counts.critical },
    ];
    let start = -Math.PI / 2;
    for (const s of slices) {
      const angle = (s.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, start + angle);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      start += angle;
    }
    ctx.beginPath();
    ctx.fillStyle = "#121a26";
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e7ecf3";
    ctx.font = "bold 16px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(String(counts.normal + counts.warning + counts.critical), cx, cy + 6);

    ctx.textAlign = "left";
    ctx.font = "12px system-ui";
    const lx = 190;
    let ly = 54;
    for (const s of slices) {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, ly - 9, 10, 10);
      ctx.fillStyle = "#c9d4e5";
      ctx.fillText(`${s.label}: ${s.value}`, lx + 16, ly);
      ly += 28;
    }
  }

  function renderOverview(summary) {
    const rows = summary.racks || [];
    let totalTemp = 0;
    let tempCount = 0;
    let maxTemp = -Infinity;
    let maxRack = null;
    let riskRacks = 0;
    const statusCounts = { normal: 0, warning: 0, critical: 0 };
    for (const row of rows) {
      const tempItem = row.latest && row.latest.rack_temperature ? row.latest.rack_temperature : null;
      const temp = tempItem ? Number(tempItem.value) : NaN;
      if (!Number.isNaN(temp)) {
        totalTemp += temp;
        tempCount += 1;
        if (temp > maxTemp) {
          maxTemp = temp;
          maxRack = row.label;
        }
      }
      if (riskCount(row.latest) > 0) riskRacks += 1;
      const status = rackOperationalStatus(row.latest);
      statusCounts[status] += 1;
    }
    if (overviewKpis) {
      const avgText = tempCount ? `${(totalTemp / tempCount).toFixed(2)} °C` : "—";
      const maxText = maxRack && Number.isFinite(maxTemp) ? `${maxRack} (${maxTemp.toFixed(2)} °C)` : "—";
      overviewKpis.innerHTML =
        `<article class="kpi-card"><h4>Total Racks</h4><strong>${rows.length}</strong></article>` +
        `<article class="kpi-card"><h4>Avg Rack Temp</h4><strong>${avgText}</strong></article>` +
        `<article class="kpi-card"><h4>Racks With Risk</h4><strong>${riskRacks}</strong></article>` +
        `<article class="kpi-card"><h4>Hottest Rack</h4><strong>${maxText}</strong></article>`;
    }
    drawOverviewPie(statusCounts);
  }

  function renderRackCards(summary) {
    rackGrid.innerHTML = "";
    for (const rackRow of summary.racks || []) {
      const card = document.createElement("article");
      card.className = "rack-card" + (rackRow.rack_id === selectedRackId ? " selected" : "");
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.addEventListener("click", async () => {
        selectedRackId = rackRow.rack_id;
        renderRackCards(summary);
        await openRackModal(rackRow.rack_id, rackRow.label, rackRow.latest);
      });
      card.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          selectedRackId = rackRow.rack_id;
          renderRackCards(summary);
          openRackModal(rackRow.rack_id, rackRow.label, rackRow.latest);
        }
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

      const actions = document.createElement("div");
      actions.className = "rack-card-actions";
      const detailsBtn = document.createElement("button");
      detailsBtn.type = "button";
      detailsBtn.className = "details-btn";
      detailsBtn.textContent = "View details";
      detailsBtn.addEventListener("click", async (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        await openRackModal(rackRow.rack_id, rackRow.label, rackRow.latest);
      });
      actions.appendChild(detailsBtn);

      card.append(title, stats, metrics, risk, actions);
      rackGrid.append(card);
    }
  }

  function rackHealthNarrative(latest) {
    const messages = [];
    const temp = latest && latest.rack_temperature ? Number(latest.rack_temperature.value) : null;
    const airflow = latest && latest.airflow ? Number(latest.airflow.value) : null;
    const humidity = latest && latest.humidity ? Number(latest.humidity.value) : null;
    if (temp !== null && temp >= RACK_TEMP_CRIT_C) messages.push("Critical rack temperature");
    else if (temp !== null && temp >= RACK_TEMP_WARN_C) messages.push("Temperature in warning band");
    if (airflow !== null && airflow < 1.2) messages.push("Low airflow suggests cooling stress");
    if (humidity !== null && humidity < 30) messages.push("Low humidity can increase static risk");
    if (!messages.length) messages.push("Rack operating in normal band");
    return messages.join(" · ");
  }

  function renderRackDetails(summary) {
    if (!rackDetailsList) return;
    const rows = summary.racks || [];
    rackDetailsList.innerHTML = "";
    for (const row of rows) {
      const block = document.createElement("article");
      block.className = "rack-detail-card";
      const latest = row.latest || {};
      const status = rackOperationalStatus(latest);
      const statusLabel = status === "critical" ? "Critical" : status === "warning" ? "Warning" : "Normal";
      const statusClass = status === "critical" ? "chip-critical" : status === "warning" ? "chip-warning" : "chip-ok";
      block.innerHTML =
        `<header class="rack-detail-head"><h3>${row.label}</h3><span class="chip ${statusClass}">${statusLabel}</span></header>` +
        "<div class='rack-detail-grid'>" +
        `<div><span>Rack Temp</span><strong>${metricCell(latest, "rack_temperature")}</strong></div>` +
        `<div><span>Room Temp</span><strong>${metricCell(latest, "room_temperature")}</strong></div>` +
        `<div><span>Humidity</span><strong>${metricCell(latest, "humidity")}</strong></div>` +
        `<div><span>Airflow</span><strong>${metricCell(latest, "airflow")}</strong></div>` +
        `<div><span>Outdoor Temp</span><strong>${metricCell(latest, "outdoor_temperature")}</strong></div>` +
        `<div><span>Risk Flags</span><strong>${riskCount(latest)}</strong></div>` +
        "</div>" +
        `<p class="rack-detail-note">${rackHealthNarrative(latest)}</p>`;
      rackDetailsList.appendChild(block);
    }
    if (insightEl) {
      const critical = rows.filter((r) => rackOperationalStatus(r.latest || {}) === "critical").length;
      const warning = rows.filter((r) => rackOperationalStatus(r.latest || {}) === "warning").length;
      insightEl.textContent =
        `Overall snapshot (rack inlet temperature): ${rows.length} rack(s) monitored. ${critical} critical, ${warning} warning, ${
          rows.length - critical - warning
        } normal. Click any rack card above for full modal diagnostics and per-sensor trends.`;
    }
    if (chartsTitle) chartsTitle.textContent = "Overall analysis and rack details";
  }

  function openModal() {
    if (!rackModal) return;
    rackModal.classList.remove("hidden");
    document.body.classList.add("modal-open");
  }

  function closeModal() {
    if (!rackModal) return;
    rackModal.classList.add("hidden");
    document.body.classList.remove("modal-open");
  }

  function sensorHealthRows(latestByType) {
    const rows = [];
    for (const st of SENSOR_ORDER) {
      const item = latestByType && latestByType[st] ? latestByType[st] : null;
      if (!item) {
        rows.push(`<tr><td>${LABELS[st]}</td><td>—</td><td><span class="chip chip-muted">No data</span></td></tr>`);
        continue;
      }
      const val = Number(item.value);
      const cls = classifySensor(st, val);
      const chip = cls === "critical" ? "chip-critical" : cls === "warning" ? "chip-warning" : "chip-ok";
      rows.push(
        `<tr><td>${LABELS[st]}</td><td>${val.toFixed(2)} ${item.unit || ""}</td><td><span class="chip ${chip}">${cls}</span></td></tr>`
      );
    }
    return rows.join("");
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
    const pad = 12;
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
    ctx.textAlign = "left";
    ctx.fillText(labels[0] || "", pad, h - 4);
    ctx.textAlign = "right";
    ctx.fillText(labels[labels.length - 1] || "", w - pad, h - 4);
    ctx.textAlign = "left";

    if (sensorType === "rack_temperature") {
      const yWarn = pad + (1 - (RACK_TEMP_WARN_C - min) / span) * (h - pad * 2);
      const yCrit = pad + (1 - (RACK_TEMP_CRIT_C - min) / span) * (h - pad * 2);
      if (yWarn >= pad && yWarn <= h - pad) {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "rgba(245,166,35,0.85)";
        ctx.beginPath();
        ctx.moveTo(pad, yWarn);
        ctx.lineTo(w - pad, yWarn);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (yCrit >= pad && yCrit <= h - pad) {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "rgba(232,93,93,0.85)";
        ctx.beginPath();
        ctx.moveTo(pad, yCrit);
        ctx.lineTo(w - pad, yCrit);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function drawModalSensorHealthPie(canvas, latestByType) {
    if (!canvas || !latestByType) return;
    let normal = 0;
    let warning = 0;
    let critical = 0;
    for (const st of SENSOR_ORDER) {
      const item = latestByType[st];
      if (!item) continue;
      const c = classifySensor(st, Number(item.value));
      if (c === "critical") critical += 1;
      else if (c === "warning") warning += 1;
      else normal += 1;
    }
    const total = normal + warning + critical;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2 - 8;
    ctx.clearRect(0, 0, w, h);
    if (!total) {
      ctx.fillStyle = "#8b9bb4";
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("No data", cx, cy);
      ctx.textAlign = "left";
      return;
    }
    const slices = [
      { color: "#3ddc97", v: normal },
      { color: "#f5a623", v: warning },
      { color: "#e85d5d", v: critical },
    ];
    let start = -Math.PI / 2;
    for (const s of slices) {
      const angle = (s.v / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, start + angle);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      start += angle;
    }
    ctx.beginPath();
    ctx.fillStyle = "#121a26";
    ctx.arc(cx, cy, r * 0.52, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e7ecf3";
    ctx.font = "bold 14px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(String(total), cx, cy + 5);
    ctx.textAlign = "left";
  }

  function buildModalBanners(latestByType, sensorResults, riskFlagMessages) {
    const parts = [];
    const tempRow = latestByType && latestByType.rack_temperature ? latestByType.rack_temperature : null;
    const tempVal = tempRow ? Number(tempRow.value) : null;
    const rackLevel = tempVal === null || Number.isNaN(tempVal) ? "normal" : tempLevel(tempVal);
    if (rackLevel === "critical") {
      parts.push(
        `<div class="modal-banner modal-banner--critical"><strong>Rack temperature critical</strong><span>${tempVal.toFixed(2)}°C — immediate cooling review recommended.</span></div>`
      );
    } else if (rackLevel === "warning") {
      parts.push(
        `<div class="modal-banner modal-banner--warning"><strong>Rack temperature elevated</strong><span>${tempVal.toFixed(2)}°C — monitor trend and airflow.</span></div>`
      );
    } else if (tempVal !== null) {
      parts.push(
        `<div class="modal-banner modal-banner--ok"><strong>Rack temperature normal</strong><span>${tempVal.toFixed(2)}°C within expected band.</span></div>`
      );
    }
    for (const msg of riskFlagMessages) {
      parts.push(`<div class="modal-banner modal-banner--risk"><strong>Operational flag</strong><span>${msg}</span></div>`);
    }
    const trendWarnings = [];
    for (const r of sensorResults) {
      if (r.trend === "rising" && r.st === "rack_temperature" && r.latest !== null && r.latest >= RACK_TEMP_WARN_C) {
        trendWarnings.push("Rack temperature is rising while already warm — check load and cooling.");
      }
      if (r.trend === "falling" && r.st === "airflow" && r.latest !== null && r.latest < 1.5) {
        trendWarnings.push("Airflow is falling — possible obstruction or fan issue.");
      }
    }
    for (const tw of trendWarnings) {
      parts.push(`<div class="modal-banner modal-banner--warning"><strong>Trend insight</strong><span>${tw}</span></div>`);
    }
    if (!parts.length) {
      parts.push(`<div class="modal-banner modal-banner--ok"><strong>All clear</strong><span>No urgent warnings from current readings and trends.</span></div>`);
    }
    return parts.join("");
  }

  async function openRackModal(rackId, rackLabel, latestByType) {
    if (!rackModalBody || !rackModalTitle || !rackModalSub) return;
    rackModalTitle.textContent = `${rackLabel} detailed diagnostics`;
    rackModalSub.textContent = "Loading charts and history…";
    rackModalBody.innerHTML = "<p class='modal-loading'>Loading sensor history...</p>";
    openModal();

    const MODAL_POINTS = 40;
    const sensorResults = [];
    const seriesBySensor = {};

    for (const st of SENSOR_ORDER) {
      try {
        const data = await fetchJson(
          `/api/sensors/${encodeURIComponent(st)}?rack_id=${encodeURIComponent(rackId)}&n=${MODAL_POINTS}`
        );
        const readings = (data.readings || []).slice().reverse();
        const labels = readings.map((r) => (r.timestamp || "").slice(11, 19));
        const values = readings.map((r) => parseFloat(r.value)).filter((v) => Number.isFinite(v));
        if (!values.length) {
          sensorResults.push({ st, trend: "no-data", volatility: "n/a", latest: null });
          seriesBySensor[st] = { labels: [], values: [], metaText: "No data" };
          continue;
        }
        const latest = values[values.length - 1];
        const oldest = values[0];
        const drift = latest - oldest;
        const trend = drift > 0.25 ? "rising" : drift < -0.25 ? "falling" : "stable";
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
        const stdev = Math.sqrt(variance);
        let metaText = `Latest ${latest.toFixed(2)} · ${trend} · σ ${stdev.toFixed(2)}`;
        if (values.length > 1) {
          const prev = values[values.length - 2];
          const delta = latest - prev;
          metaText += ` · Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} vs prior`;
        }
        sensorResults.push({ st, trend, volatility: stdev.toFixed(2), latest });
        seriesBySensor[st] = { labels, values, metaText };
      } catch (_) {
        sensorResults.push({ st, trend: "error", volatility: "n/a", latest: null });
        seriesBySensor[st] = { labels: [], values: [], metaText: "Load failed" };
      }
    }

    const riskFlags = [];
    let flagRow = null;
    for (const st of SENSOR_ORDER) {
      if (latestByType && latestByType[st]) {
        flagRow = latestByType[st];
        break;
      }
    }
    if (flagRow) {
      if (flagRow.overheating) riskFlags.push("Overheating condition active");
      if (flagRow.cooling_failure) riskFlags.push("Cooling failure risk flagged");
      if (flagRow.static_risk) riskFlags.push("Static risk flagged (low humidity)");
    }

    const trendRows = sensorResults
      .map((r) => `<tr><td>${LABELS[r.st]}</td><td>${r.trend}</td><td>${r.volatility}</td></tr>`)
      .join("");
    const riskHtml = riskFlags.length
      ? `<div class="modal-risk-list">${riskFlags.map((x) => `<div class="modal-risk-item">${x}</div>`).join("")}</div>`
      : "<p class='modal-ok'>No operational flags from fog layer for this rack.</p>";

    const chartBoxes = SENSOR_ORDER.map((st) => {
      const primary = st === "rack_temperature" ? " modal-chart-box--primary" : "";
      return (
        `<div class="modal-chart-box${primary}">` +
        `<h5>${LABELS[st]}</h5>` +
        `<canvas class="modal-chart-canvas" data-sensor="${st}" width="440" height="150"></canvas>` +
        `<div class="modal-chart-meta" data-meta="${st}"></div>` +
        `</div>`
      );
    }).join("");

    rackModalSub.textContent = `Rack: ${rackId} · Charts: last ${MODAL_POINTS} points · ${new Date().toLocaleTimeString()}`;
    rackModalBody.innerHTML =
      `<section class="modal-section modal-section--visual">` +
      `<h4>Status and warnings</h4>` +
      `<div class="modal-visual-row">` +
      `<div class="modal-pie-wrap"><h5>Sensor state (now)</h5><canvas id="modal-health-pie" width="200" height="200"></canvas><p class="modal-pie-legend">By per-sensor thresholds (not rack card rule).</p></div>` +
      `<div class="modal-banners">${buildModalBanners(latestByType, sensorResults, riskFlags)}</div>` +
      `</div></section>` +
      `<section class="modal-section"><h4>Trend charts (oldest → newest)</h4><p class="modal-section-hint">Dashed lines on rack temperature: warning ${RACK_TEMP_WARN_C}°C and critical ${RACK_TEMP_CRIT_C}°C.</p>` +
      `<div class="modal-charts-grid">${chartBoxes}</div></section>` +
      `<section class="modal-section"><h4>Current readings</h4><table class="modal-table"><thead><tr><th>Sensor</th><th>Value</th><th>State</th></tr></thead><tbody>${sensorHealthRows(
        latestByType
      )}</tbody></table></section>` +
      `<section class="modal-section"><h4>Trend summary</h4><table class="modal-table"><thead><tr><th>Sensor</th><th>Trend</th><th>Volatility</th></tr></thead><tbody>${trendRows}</tbody></table></section>` +
      `<section class="modal-section"><h4>Operational flags</h4>${riskHtml}</section>` +
      "<section class='modal-section'><h4>Recommended actions</h4><ul class='modal-list'><li>If rack temperature is rising while airflow is falling, inspect cooling fan paths.</li><li>If humidity is low and static risk is flagged, increase humidity control in this zone.</li><li>Use volatility: sustained high σ on rack temperature can mean unstable load or sensor placement issues.</li></ul></section>";

    const pieCanvas = rackModalBody.querySelector("#modal-health-pie");
    drawModalSensorHealthPie(pieCanvas, latestByType || {});

    for (const st of SENSOR_ORDER) {
      const canvas = rackModalBody.querySelector(`canvas.modal-chart-canvas[data-sensor="${st}"]`);
      const meta = rackModalBody.querySelector(`[data-meta="${st}"]`);
      const ser = seriesBySensor[st];
      if (canvas && ser) {
        drawLineChart(canvas, ser.labels, ser.values, st);
        if (meta) meta.textContent = ser.metaText;
      }
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

  async function refreshSummary() {
    const data = await fetchJson("/api/racks-summary");
    updateOverheatDurations(data);
    renderOverview(data);
    renderRackCards(data);
    renderRackDetails(data);
    if (data.errors && data.errors.length) {
      setStatus("Data issue: " + data.errors[0], false);
    } else {
      setStatus("Last update: " + new Date().toLocaleTimeString(), true);
    }
  }

  async function refreshAll() {
    try {
      await refreshSummary();
    } catch (e) {
      setStatus("Refresh error: " + e.message, false);
    }
  }

  if (rackModalClose) rackModalClose.addEventListener("click", closeModal);
  if (rackModal) {
    rackModal.addEventListener("click", (evt) => {
      const target = evt.target;
      if (target && target.dataset && target.dataset.closeModal === "1") closeModal();
    });
  }
  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape") closeModal();
  });
  refreshAll();
  setInterval(refreshAll, POLL_MS);
})();

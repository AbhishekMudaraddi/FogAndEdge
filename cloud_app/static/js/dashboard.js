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
  const SELECTED_REGION = cfg.selectedRegion || "";
  const REFRESH_SEC = Math.max(1, Math.round(POLL_MS / 1000));
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
  const ALERT_COOLDOWN_TICKS = 4;
  const MAX_ALERTS = 3;
  const SENSOR_THRESHOLDS = {
    rack_temperature: { warnHigh: 35, critHigh: 40 },
    room_temperature: { warnHigh: 26, critHigh: 30 },
    humidity: { warnLow: 30, warnHigh: 60, critLow: 20, critHigh: 75 },
    airflow: { warnLow: 1.5, critLow: 1.2 },
    outdoor_temperature: { warnHigh: 35, critHigh: 42, warnLow: -5, critLow: -10 },
  };

  const statusEl = document.getElementById("status-line");
  const rackGrid = document.getElementById("rack-grid");
  const alertsPanel = document.getElementById("alerts-panel");
  const overviewKpis = document.getElementById("overview-kpis");
  const overviewPie = document.getElementById("overview-pie");
  const regionalRacksChartCanvas = document.getElementById("regional-racks-chart");
  const rackModal = document.getElementById("rack-modal");
  const rackModalClose = document.getElementById("rack-modal-close");
  const rackModalTitle = document.getElementById("rack-modal-title");
  const rackModalSub = document.getElementById("rack-modal-sub");
  const rackModalBody = document.getElementById("rack-modal-body");
  const hasChartJs = typeof window.Chart !== "undefined";
  let overviewPieChart = null;
  let regionalRacksChart = null;
  const modalLineCharts = new Map();
  let modalHealthPieChart = null;
  let azRacksTempChart = null;
  const azExtraCharts = new Map();

  const racks = cfg.rackIds || [];
  let selectedRackId = cfg.defaultRackId || (racks[0] && racks[0].rack_id) || "rack_01";
  let secUntilRefresh = REFRESH_SEC;
  const overheatState = {};
  const rackAlertMeta = {};
  let activeAlerts = [];
  let refreshTick = 0;

  function updateCountdownDisplay() {
    const el = document.getElementById("refresh-countdown");
    if (el) el.textContent = String(Math.max(0, secUntilRefresh));
  }

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

  /** Fog (Lambda) copies enrichment onto every sensor row in the batch. */
  function fogCoolingEfficiency(latest) {
    for (const k of SENSOR_ORDER) {
      const item = latest && latest[k];
      if (item != null && item.cooling_efficiency != null && item.cooling_efficiency !== "") {
        const n = Number(item.cooling_efficiency);
        return Number.isFinite(n) ? n : null;
      }
    }
    return null;
  }

  function formatFogEta(latest) {
    const n = fogCoolingEfficiency(latest);
    return n === null ? "—" : n.toFixed(4);
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
    if (!overviewPie || !hasChartJs) return;
    if (overviewPieChart) overviewPieChart.destroy();
    overviewPieChart = new window.Chart(overviewPie, {
      type: "doughnut",
      data: {
        labels: ["Normal", "Warning", "Critical"],
        datasets: [
          {
            data: [counts.normal, counts.warning, counts.critical],
            backgroundColor: ["#3ddc97", "#f5a623", "#e85d5d"],
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.12)",
          },
        ],
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        cutout: "55%",
        plugins: {
          legend: {
            position: "right",
            labels: { color: "#c9d4e5", boxWidth: 10, boxHeight: 10 },
          },
        },
      },
    });
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

  async function renderRegionalRacksChart() {
    if (!hasChartJs || !regionalRacksChartCanvas || !racks.length) return;
    const seriesPoints = 35;
    const palette = ["#3ea6ff", "#3ddc97", "#f5a623", "#e85d5d", "#b18cff", "#23c0d8"];
    const datasets = [];
    let labels = [];

    for (let i = 0; i < racks.length; i += 1) {
      const rack = racks[i];
      try {
        const data = await fetchJson(
          `/api/sensors/rack_temperature?rack_id=${encodeURIComponent(rack.rack_id)}&region=${encodeURIComponent(
            SELECTED_REGION
          )}&n=${seriesPoints}`
        );
        const readings = (data.readings || []).slice().reverse();
        const vals = readings.map((r) => Number(r.value)).filter((v) => Number.isFinite(v));
        const timeLabels = readings.map((r) => String(r.timestamp || "").slice(11, 19));
        if (!labels.length) labels = timeLabels;
        datasets.push({
          label: rack.label || rack.rack_id,
          data: vals,
          borderColor: palette[i % palette.length],
          backgroundColor: "transparent",
          pointRadius: 0,
          tension: 0.25,
          borderWidth: 2,
        });
      } catch (_) {
        datasets.push({
          label: rack.label || rack.rack_id,
          data: [],
          borderColor: palette[i % palette.length],
          backgroundColor: "transparent",
          pointRadius: 0,
          tension: 0.25,
          borderWidth: 2,
        });
      }
    }

    if (regionalRacksChart) regionalRacksChart.destroy();
    regionalRacksChart = new window.Chart(regionalRacksChartCanvas, {
      type: "line",
      data: {
        labels: labels.length ? labels : Array.from({ length: seriesPoints }, (_, i) => String(i + 1)),
        datasets,
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "top",
            labels: { color: "#c9d4e5", boxWidth: 12 },
          },
          title: {
            display: false,
          },
        },
        scales: {
          x: {
            ticks: { color: "#a9bad3", maxTicksLimit: 8 },
            grid: { color: "rgba(255,255,255,0.08)" },
          },
          y: {
            ticks: { color: "#a9bad3" },
            grid: { color: "rgba(255,255,255,0.1)" },
            title: { display: true, text: "Temperature (°C)", color: "#c9d4e5" },
          },
        },
      },
    });
  }

  function renderRackCards(summary) {
    rackGrid.innerHTML = "";
    for (const rackRow of summary.racks || []) {
      const latest = rackRow.latest || {};
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

      const tempRow = latest.rack_temperature ? latest.rack_temperature : null;
      const tempVal = tempRow ? Number(tempRow.value) : null;
      const level = tempVal === null ? "normal" : tempLevel(tempVal);
      const statusLabel = level === "critical" ? "Critical" : level === "warning" ? "Warning" : "Normal";
      const rc = riskCount(latest);

      const header = document.createElement("div");
      header.className = "rack-card-header";
      const title = document.createElement("h3");
      title.textContent = rackRow.label;
      const chip = document.createElement("span");
      chip.className =
        "rack-status-chip" +
        (level === "critical" ? " rack-status-chip--critical" : level === "warning" ? " rack-status-chip--warning" : " rack-status-chip--normal");
      chip.textContent = statusLabel.toUpperCase();
      header.append(title, chip);

      const grid = document.createElement("div");
      grid.className = "rack-card-metrics";
      grid.innerHTML =
        `<div><span>Rack Temp</span><strong>${metricCell(latest, "rack_temperature")}</strong></div>` +
        `<div><span>Room Temp</span><strong>${metricCell(latest, "room_temperature")}</strong></div>` +
        `<div><span>Humidity</span><strong>${metricCell(latest, "humidity")}</strong></div>` +
        `<div><span>Airflow</span><strong>${metricCell(latest, "airflow")}</strong></div>` +
        `<div><span>Outdoor Temp</span><strong>${metricCell(latest, "outdoor_temperature")}</strong></div>` +
        `<div><span>Risk flags</span><strong>${rc}</strong></div>`;

      const fogRow = document.createElement("div");
      fogRow.className = "rack-card-fog";
      fogRow.innerHTML = `<span>Fog: cooling η</span><strong>${formatFogEta(latest)}</strong>`;

      const metrics = document.createElement("div");
      metrics.className = "rack-metrics";
      const lastTs = extractLastTimestamp(latest);
      const hotIntervals = overheatState[rackRow.rack_id] || 0;
      metrics.innerHTML =
        `<div><span>Last update</span><strong>${formatTime(lastTs)}</strong></div>` +
        `<div><span>Overheat duration</span><strong>${formatOverheatDuration(hotIntervals)}</strong></div>`;

      const note = document.createElement("p");
      note.className = "rack-card-note";
      note.textContent = rackHealthNarrative(latest);

      const footer = document.createElement("p");
      footer.className = "rack-risk";
      footer.textContent = `Status: ${statusLabel} · ${rc > 0 ? `${rc} active risk flag(s)` : "No active risk flags"}`;

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

      card.append(header, grid, fogRow, metrics, note, footer, actions);
      rackGrid.append(card);
    }
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
    if (!hasChartJs || !canvas) return;
    const key = sensorType + ":" + (canvas.dataset.sensor || sensorType);
    const existing = modalLineCharts.get(key);
    if (existing) {
      existing.destroy();
      modalLineCharts.delete(key);
    }

    const isHot = sensorType === "rack_temperature";
    const datasets = [
      {
        label: LABELS[sensorType] || sensorType,
        data: values,
        borderColor: isHot ? "#e85d5d" : "#3d9cf5",
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.25,
      },
    ];
    if (isHot) {
      datasets.push(
        {
          label: `Warn ${RACK_TEMP_WARN_C}°C`,
          data: values.map(() => RACK_TEMP_WARN_C),
          borderColor: "rgba(245,166,35,0.9)",
          borderDash: [6, 4],
          borderWidth: 1,
          pointRadius: 0,
        },
        {
          label: `Critical ${RACK_TEMP_CRIT_C}°C`,
          data: values.map(() => RACK_TEMP_CRIT_C),
          borderColor: "rgba(232,93,93,0.9)",
          borderDash: [6, 4],
          borderWidth: 1,
          pointRadius: 0,
        }
      );
    }

    const chart = new window.Chart(canvas, {
      type: "line",
      data: {
        labels: labels.length ? labels : values.map((_, i) => String(i + 1)),
        datasets,
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: isHot, labels: { color: "#c9d4e5", boxWidth: 10 } },
        },
        scales: {
          x: { ticks: { color: "#8b9bb4", maxTicksLimit: 6 }, grid: { color: "rgba(255,255,255,0.08)" } },
          y: { ticks: { color: "#8b9bb4" }, grid: { color: "rgba(255,255,255,0.1)" } },
        },
      },
    });
    modalLineCharts.set(key, chart);
  }

  function drawModalSensorHealthPie(canvas, latestByType) {
    if (!canvas || !latestByType || !hasChartJs) return;
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
    if (modalHealthPieChart) modalHealthPieChart.destroy();
    modalHealthPieChart = new window.Chart(canvas, {
      type: "doughnut",
      data: {
        labels: ["Normal", "Warning", "Critical"],
        datasets: [
          {
            data: [normal, warning, critical],
            backgroundColor: ["#3ddc97", "#f5a623", "#e85d5d"],
            borderColor: "rgba(255,255,255,0.15)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        cutout: "52%",
        plugins: {
          legend: {
            position: "bottom",
            labels: { color: "#c9d4e5", boxWidth: 10, boxHeight: 10 },
          },
        },
      },
    });
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

  function drawAzRacksHealthPie(canvas, racksData) {
    if (!canvas || !hasChartJs) return;
    let normal = 0;
    let warning = 0;
    let critical = 0;
    for (const rack of racksData || []) {
      const latest = rack.latest || {};
      const temp = latest.rack_temperature ? Number(latest.rack_temperature.value) : NaN;
      if (!Number.isFinite(temp)) continue;
      if (temp >= RACK_TEMP_CRIT_C) critical += 1;
      else if (temp >= RACK_TEMP_WARN_C) warning += 1;
      else normal += 1;
    }
    if (modalHealthPieChart) {
      modalHealthPieChart.destroy();
      modalHealthPieChart = null;
    }
    modalHealthPieChart = new window.Chart(canvas, {
      type: "doughnut",
      data: {
        labels: ["Normal", "Warning", "Critical"],
        datasets: [
          {
            data: [normal, warning, critical],
            backgroundColor: ["#3ddc97", "#f5a623", "#e85d5d"],
            borderColor: "rgba(255,255,255,0.15)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        cutout: "52%",
        plugins: {
          legend: {
            position: "bottom",
            labels: { color: "#c9d4e5", boxWidth: 10, boxHeight: 10 },
          },
        },
      },
    });
  }

  async function openRackModal(rackId, rackLabel, latestByType) {
    if (!rackModalBody || !rackModalTitle || !rackModalSub) return;
    rackModalTitle.textContent = `${rackLabel} detailed diagnostics`;
    rackModalSub.textContent = "Loading AZ rack details…";
    rackModalBody.innerHTML = "<p class='modal-loading'>Loading AZ rack details...</p>";
    openModal();
    modalLineCharts.forEach((chart) => chart.destroy());
    modalLineCharts.clear();
    if (modalHealthPieChart) {
      modalHealthPieChart.destroy();
      modalHealthPieChart = null;
    }
    if (azRacksTempChart) {
      azRacksTempChart.destroy();
      azRacksTempChart = null;
    }
    azExtraCharts.forEach((chart) => chart.destroy());
    azExtraCharts.clear();
    try {
      const azData = await fetchJson(
        `/api/az-racks?az_id=${encodeURIComponent(rackId)}&region=${encodeURIComponent(SELECTED_REGION)}`
      );
      const azRacks = Array.isArray(azData.racks) ? azData.racks : [];
      rackModalSub.textContent = rackId;

      const cards = azRacks
        .map((rack) => {
          const latest = rack.latest || {};
          return (
            `<article class="kpi-card">` +
            `<h4>${rack.label || rack.rack_id}</h4>` +
            `<strong>${metricCell(latest, "rack_temperature")}</strong>` +
            `<div class="submetric">Room: ${metricCell(latest, "room_temperature")}</div>` +
            `<div class="submetric">Humidity: ${metricCell(latest, "humidity")}</div>` +
            `<div class="submetric">Airflow: ${metricCell(latest, "airflow")}</div>` +
            `</article>`
          );
        })
        .join("");

      rackModalBody.innerHTML =
        `<section class="modal-section modal-section--visual">` +
        `<h4>AZ rack details</h4>` +
        `<div class="modal-visual-row">` +
        `<div class="overview-kpis">${cards}</div>` +
        `<div class="modal-pie-wrap"><h5>Rack temperature state</h5><canvas id="modal-health-pie" width="220" height="220"></canvas></div>` +
        `</div></section>` +
        `<section class="modal-section"><h4>Rack temperature trend by rack</h4><div class="modal-chart-box modal-chart-box--primary"><canvas id="az-racks-temp-chart" width="760" height="240"></canvas></div></section>` +
        `<section class="modal-section"><h4>Other sensor trends (AZ aggregate)</h4><div class="modal-charts-grid">` +
        `<div class="modal-chart-box"><h5>Room °C</h5><canvas id="az-room-chart" width="440" height="150"></canvas><div class="modal-chart-meta" id="az-room-meta">Loading…</div></div>` +
        `<div class="modal-chart-box"><h5>Humidity %</h5><canvas id="az-humidity-chart" width="440" height="150"></canvas><div class="modal-chart-meta" id="az-humidity-meta">Loading…</div></div>` +
        `<div class="modal-chart-box"><h5>Airflow m/s</h5><canvas id="az-airflow-chart" width="440" height="150"></canvas><div class="modal-chart-meta" id="az-airflow-meta">Loading…</div></div>` +
        `<div class="modal-chart-box"><h5>Outdoor °C</h5><canvas id="az-outdoor-chart" width="440" height="150"></canvas><div class="modal-chart-meta" id="az-outdoor-meta">Loading…</div></div>` +
        `</div></section>`;

      const pieCanvas = rackModalBody.querySelector("#modal-health-pie");
      drawAzRacksHealthPie(pieCanvas, azRacks);

      if (hasChartJs) {
        const chartCanvas = rackModalBody.querySelector("#az-racks-temp-chart");
        if (chartCanvas) {
          const palette = ["#3ea6ff", "#3ddc97", "#f5a623", "#e85d5d", "#b18cff"];
          let labels = [];
          const datasets = azRacks.map((rack, idx) => {
            const points = Array.isArray(rack.rack_temperature_series) ? rack.rack_temperature_series : [];
            const vals = points.map((p) => Number(p.value)).filter((v) => Number.isFinite(v));
            const labs = points.map((p) => String(p.timestamp || "").slice(11, 19));
            if (!labels.length) labels = labs;
            return {
              label: rack.label || rack.rack_id,
              data: vals,
              borderColor: palette[idx % palette.length],
              backgroundColor: "transparent",
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.25,
            };
          });
          azRacksTempChart = new window.Chart(chartCanvas, {
            type: "line",
            data: {
              labels,
              datasets,
            },
            options: {
              responsive: false,
              maintainAspectRatio: false,
              plugins: {
                legend: { labels: { color: "#c9d4e5", boxWidth: 10 } },
              },
              scales: {
                x: { ticks: { color: "#8b9bb4", maxTicksLimit: 8 }, grid: { color: "rgba(255,255,255,0.08)" } },
                y: { ticks: { color: "#8b9bb4" }, grid: { color: "rgba(255,255,255,0.1)" } },
              },
            },
          });
        }
      }

      const azExtra = [
        { st: "room_temperature", canvasId: "az-room-chart", metaId: "az-room-meta", color: "#3ea6ff" },
        { st: "humidity", canvasId: "az-humidity-chart", metaId: "az-humidity-meta", color: "#3ddc97" },
        { st: "airflow", canvasId: "az-airflow-chart", metaId: "az-airflow-meta", color: "#f5a623" },
        { st: "outdoor_temperature", canvasId: "az-outdoor-chart", metaId: "az-outdoor-meta", color: "#b18cff" },
      ];

      for (const spec of azExtra) {
        try {
          const sensorData = await fetchJson(
            `/api/sensors/${encodeURIComponent(spec.st)}?rack_id=${encodeURIComponent(rackId)}&region=${encodeURIComponent(
              SELECTED_REGION
            )}&n=40`
          );
          const readings = (sensorData.readings || []).slice().reverse();
          const labels = readings.map((r) => String(r.timestamp || "").slice(11, 19));
          const values = readings.map((r) => Number(r.value)).filter((v) => Number.isFinite(v));
          const metaEl = rackModalBody.querySelector(`#${spec.metaId}`);
          if (metaEl) metaEl.textContent = values.length ? `Latest: ${values[values.length - 1].toFixed(2)}` : "No data";
          if (!hasChartJs) continue;
          const canvas = rackModalBody.querySelector(`#${spec.canvasId}`);
          if (!canvas) continue;
          const chart = new window.Chart(canvas, {
            type: "line",
            data: {
              labels,
              datasets: [
                {
                  label: spec.st,
                  data: values,
                  borderColor: spec.color,
                  backgroundColor: "transparent",
                  borderWidth: 2,
                  pointRadius: 0,
                  tension: 0.25,
                },
              ],
            },
            options: {
              responsive: false,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: { ticks: { color: "#8b9bb4", maxTicksLimit: 7 }, grid: { color: "rgba(255,255,255,0.08)" } },
                y: { ticks: { color: "#8b9bb4" }, grid: { color: "rgba(255,255,255,0.1)" } },
              },
            },
          });
          azExtraCharts.set(spec.st, chart);
        } catch (_) {
          const metaEl = rackModalBody.querySelector(`#${spec.metaId}`);
          if (metaEl) metaEl.textContent = "Load failed";
        }
      }
    } catch (_) {
      rackModalBody.innerHTML = "<p class='modal-loading'>Unable to load rack-level AZ details.</p>";
    }
  }

  function enqueueAlert(message, level) {
    activeAlerts.unshift({
      message,
      level: level || "critical",
      ts: new Date().toLocaleTimeString(),
    });
    activeAlerts = activeAlerts.slice(0, MAX_ALERTS);
  }

  function renderAlerts() {
    if (!alertsPanel) return;
    alertsPanel.innerHTML = "";
    if (!activeAlerts.length) {
      const empty = document.createElement("p");
      empty.className = "alerts-empty";
      empty.textContent = "No recent alerts.";
      alertsPanel.appendChild(empty);
      return;
    }
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
      const tr = rackRow.latest && rackRow.latest.rack_temperature ? rackRow.latest.rack_temperature : null;
      const tempVal = tr ? Number(tr.value) : null;
      const lev = tempVal === null ? "normal" : tempLevel(tempVal);
      const hot = lev !== "normal";
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

      if (lev === "warning" && meta.lastLevel === "normal" && canWarn) {
        enqueueAlert(`${rackRow.label} warning: rack temperature reached ${tempVal.toFixed(2)}°C (>= ${RACK_TEMP_WARN_C}°C).`, "warning");
        meta.lastWarnTick = refreshTick;
      }
      if (lev === "critical" && meta.lastLevel !== "critical" && canCrit) {
        enqueueAlert(`${rackRow.label} critical: rack temperature is ${tempVal.toFixed(2)}°C (>= ${RACK_TEMP_CRIT_C}°C).`, "critical");
        meta.lastCritTick = refreshTick;
      }
      if (next === 1 && hot && canWarn) {
        enqueueAlert(
          `${rackRow.label} overheating for ${Math.round(POLL_MS / 1000)} seconds (temp ${tempVal.toFixed(2)}°C).`,
          lev === "critical" ? "critical" : "warning"
        );
        meta.lastWarnTick = refreshTick;
      } else if (next === 2 && hot && canCrit) {
        enqueueAlert(`${rackRow.label} overheating for ${2 * Math.round(POLL_MS / 1000)} seconds. Immediate cooling action recommended.`, "critical");
        meta.lastCritTick = refreshTick;
      } else if (!hot && prev > 0 && canRecover) {
        enqueueAlert(`${rackRow.label} temperature returned to normal range.`, "ok");
        meta.lastRecoveryTick = refreshTick;
      }
      meta.lastLevel = lev;
      rackAlertMeta[rid] = meta;
    }
    renderAlerts();
  }

  async function refreshSummary() {
    const data = await fetchJson(`/api/racks-summary?region=${encodeURIComponent(SELECTED_REGION)}`);
    updateOverheatDurations(data);
    renderOverview(data);
    renderRackCards(data);
    await renderRegionalRacksChart();
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
  secUntilRefresh = REFRESH_SEC;
  updateCountdownDisplay();

  setInterval(() => {
    secUntilRefresh -= 1;
    if (secUntilRefresh <= 0) {
      secUntilRefresh = REFRESH_SEC;
      refreshAll();
    }
    updateCountdownDisplay();
  }, 1000);
})();

/**
 * Polls cloud APIs every APP_CONFIG.pollIntervalMs (default 3s).
 * Plain fetch + canvas charts (no external chart libs).
 */
(function () {
  const cfg = window.APP_CONFIG || { pollIntervalMs: 3000 };
  const POLL_MS = cfg.pollIntervalMs || 3000;
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

  const statusEl = document.getElementById("status-line");
  const cardsEl = document.getElementById("summary-cards");
  const chartsRoot = document.getElementById("charts-root");

  let chartState = {};

  function setStatus(text, ok) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = ok ? "var(--ok)" : "var(--warn)";
  }

  function formatValue(v, unit) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    const n = typeof v === "number" ? v : parseFloat(v);
    return n.toFixed(2) + (unit ? "" : "");
  }

  function renderCards(latest) {
    if (!cardsEl) return;
    cardsEl.innerHTML = "";
    SENSOR_ORDER.forEach((key) => {
      const row = latest[key];
      const card = document.createElement("article");
      card.className = "card";
      const title = document.createElement("h3");
      title.textContent = LABELS[key] || key;
      const valWrap = document.createElement("div");
      const spanVal = document.createElement("span");
      spanVal.className = "value";
      const spanUnit = document.createElement("span");
      spanUnit.className = "unit";
      if (!row) {
        spanVal.textContent = "—";
        valWrap.append(spanVal);
      } else {
        spanVal.textContent = formatValue(row.value);
        spanUnit.textContent = " " + (row.unit || "");
        valWrap.append(spanVal, spanUnit);
      }
      const flags = document.createElement("div");
      flags.className = "flags";
      if (row) {
        const bits = [];
        if (row.overheating) bits.push('<span class="flag-on">overheating</span>');
        else bits.push("overheating: ok");
        if (row.cooling_failure) bits.push('<span class="flag-on">cooling_failure</span>');
        else bits.push("cooling: ok");
        if (row.static_risk) bits.push('<span class="flag-on">static_risk</span>');
        else bits.push("static: ok");
        flags.innerHTML = bits.join(" · ");
      } else {
        flags.textContent = "No data yet";
      }
      card.append(title, valWrap, flags);
      cardsEl.append(card);
    });
  }

  function drawLineChart(canvas, labels, values) {
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
    const pad = 8;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    ctx.strokeStyle = "#3d9cf5";
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
  }

  function ensureChart(sensorType) {
    if (chartState[sensorType]) return chartState[sensorType];
    const box = document.createElement("div");
    box.className = "chart-box";
    const h4 = document.createElement("h4");
    h4.textContent = LABELS[sensorType] || sensorType;
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 160;
    box.append(h4, canvas);
    chartsRoot.append(box);
    chartState[sensorType] = { canvas };
    return chartState[sensorType];
  }

  function initCharts() {
    chartState = {};
    chartsRoot.innerHTML = "";
    SENSOR_ORDER.forEach((st) => ensureChart(st));
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
      const detail =
        body && typeof body.error === "string"
          ? body.error
          : body
            ? JSON.stringify(body)
            : "(no JSON body)";
      throw new Error(r.status + " " + detail);
    }
    return body;
  }

  async function refreshAll() {
    try {
      const all = await fetchJson("/api/all-sensors");
      renderCards(all.latest || {});
      if (all.errors && all.errors.length) {
        setStatus("DynamoDB issue: " + all.errors[0], false);
      } else {
        setStatus("Last update: " + new Date().toLocaleTimeString(), true);
      }
    } catch (e) {
      setStatus("Summary error: " + e.message, false);
    }

    for (const st of SENSOR_ORDER) {
      try {
        const data = await fetchJson("/api/sensors/" + encodeURIComponent(st) + "?n=30");
        const readings = (data.readings || []).slice().reverse();
        const labels = readings.map((r) => (r.timestamp || "").slice(11, 19));
        const values = readings.map((r) => parseFloat(r.value));
        const { canvas } = ensureChart(st);
        drawLineChart(canvas, labels, values);
      } catch (e) {
        const { canvas } = ensureChart(st);
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#f5a623";
        ctx.font = "11px system-ui";
        const msg = (e && e.message) ? String(e.message).slice(0, 80) : "Chart error";
        ctx.fillText("Chart error", 8, 16);
        ctx.fillText(msg, 8, 32);
      }
    }
  }

  initCharts();
  refreshAll();
  setInterval(refreshAll, POLL_MS);
})();

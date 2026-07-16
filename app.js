/* 台股當沖模擬器 前端邏輯 */
"use strict";

// ────────────────────────── 全域狀態 ──────────────────────────
const TZ_OFFSET = 8 * 3600; // lightweight-charts 以 UTC 顯示，位移為台灣時間
const POLL_MS = 5000;       // 證交所建議輪詢間隔 5 秒

const state = {
  current: null,            // { code, name, market }
  interval: "1d",          // '1m' | '5m' | '1d'
  quote: null,              // 目前個股最新解析後報價
  quotes: {},               // code → 最新報價（含庫存與最愛）
  pollTimer: null,
  backfillTimer: null,
  stores: {},               // code → { candles1m: Map, lastCumVol, daily, dailyLoading }
};

// 模擬帳戶與我的最愛（存於伺服器端 data.json，所有瀏覽器共用同一份）
const ACCT_KEY = "daytrade-sim-account";   // 舊版 localStorage 鍵，僅供首次遷移
const FAV_KEY = "daytrade-sim-favs";

function defaultAccount() {
  return { cash: 10000000, positions: {}, realized: 0, log: [], daily: {} };
}

let account = defaultAccount();
let favorites = [];
let serverStorage = true;   // 公開部署時為 false，改存訪客自己的瀏覽器

function loadLocal() {
  try {
    const a = JSON.parse(localStorage.getItem(ACCT_KEY));
    if (a && typeof a.cash === "number") { account = a; account.daily = account.daily || {}; }
  } catch (e) { /* ignore */ }
  try {
    const f = JSON.parse(localStorage.getItem(FAV_KEY));
    if (Array.isArray(f)) favorites = f;
  } catch (e) { /* ignore */ }
}

async function bootState() {
  try {
    const res = await fetch("/api/state");
    const s = await res.json();
    if (s && s.disabled) {           // 公開模式：紀錄存各自瀏覽器
      serverStorage = false;
      loadLocal();
      return;
    }
    if (s && s.account && typeof s.account.cash === "number") {
      account = s.account;
      account.daily = account.daily || {};
      favorites = Array.isArray(s.favorites) ? s.favorites : [];
      return;
    }
  } catch (e) { /* 伺服器讀取失敗時用預設值 */ }
  // 伺服器尚無紀錄 → 從舊的 localStorage 遷移一次
  loadLocal();
  persistState();
}

// 寫回（本機模式→伺服器 data.json；公開模式→瀏覽器 localStorage）
let persistTimer = null;
function persistState() {
  if (!serverStorage) {
    localStorage.setItem(ACCT_KEY, JSON.stringify(account));
    localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
    return;
  }
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account, favorites }),
    }).catch(() => { /* 下次變更時重試 */ });
  }, 200);
}

function saveAccount() { persistState(); }
function saveFavs() { persistState(); }
function isFav(code) { return favorites.some((f) => f.code === code); }
function toggleFav(code, name) {
  const i = favorites.findIndex((f) => f.code === code);
  if (i >= 0) favorites.splice(i, 1);
  else favorites.push({ code, name });
  saveFavs();
  renderFavorites();
  renderQuote();
}

// ────────────────────────── 圖表 ──────────────────────────
const chartEl = document.getElementById("chart");
const chart = LightweightCharts.createChart(chartEl, {
  layout: { background: { color: "#1a1f2a" }, textColor: "#8a93a6" },
  grid: {
    vertLines: { color: "#232a38" },
    horzLines: { color: "#232a38" },
  },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  rightPriceScale: { borderColor: "#2c3444" },
  timeScale: { borderColor: "#2c3444", timeVisible: false },
  localization: {
    locale: "zh-TW",
    priceFormatter: (p) => p.toFixed(2),
  },
});

const candleSeries = chart.addCandlestickSeries({
  upColor: "#f0524f", downColor: "#2eaf6c",       // 台股紅漲綠跌
  borderUpColor: "#f0524f", borderDownColor: "#2eaf6c",
  wickUpColor: "#f0524f", wickDownColor: "#2eaf6c",
});

const volumeSeries = chart.addHistogramSeries({
  priceFormat: { type: "volume" },
  priceScaleId: "vol",
});

// 均線
const MA_DEFS = [
  { period: 5,   color: "#ffd166" },
  { period: 20,  color: "#4d8dff" },
  { period: 60,  color: "#c084fc" },
  { period: 120, color: "#ff8fab" },
];
const maSeries = MA_DEFS.map((d) => chart.addLineSeries({
  color: d.color,
  lineWidth: 1,
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
}));
chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.2 } });

new ResizeObserver(() =>
  chart.applyOptions({ width: chartEl.clientWidth, height: chartEl.clientHeight })
).observe(chartEl);

// ────────────────────────── 工具函式 ──────────────────────────
const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) =>
  n == null || isNaN(n) ? "-" : n.toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtInt = (n) => (n == null || isNaN(n) ? "-" : Math.round(n).toLocaleString("zh-TW"));
const num = (s) => {
  const v = parseFloat(String(s).replace(/,/g, ""));
  return isNaN(v) ? null : v;
};
const clsOf = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
const setStatus = (msg) => { $("chartStatus").textContent = msg || ""; };

function getStore(code) {
  if (!state.stores[code]) {
    state.stores[code] = { candles1m: new Map(), lastCumVol: null, daily: null, dailyLoading: false };
  }
  return state.stores[code];
}

// ────────────────────────── 搜尋 ──────────────────────────
const searchInput = $("searchInput");
const dropdown = $("searchDropdown");
let searchTimer = null;
let activeIdx = -1;

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) { hideDropdown(); return; }
  searchTimer = setTimeout(() => doSearch(q), 250);
});

searchInput.addEventListener("keydown", (e) => {
  const items = dropdown.querySelectorAll(".search-item");
  if (!items.length) return;
  if (e.key === "ArrowDown") { activeIdx = Math.min(activeIdx + 1, items.length - 1); highlight(items); e.preventDefault(); }
  else if (e.key === "ArrowUp") { activeIdx = Math.max(activeIdx - 1, 0); highlight(items); e.preventDefault(); }
  else if (e.key === "Enter") { (items[Math.max(activeIdx, 0)]).click(); e.preventDefault(); }
  else if (e.key === "Escape") hideDropdown();
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) hideDropdown();
});

function highlight(items) {
  items.forEach((el, i) => el.classList.toggle("active", i === activeIdx));
}
function hideDropdown() { dropdown.classList.add("hidden"); activeIdx = -1; }

async function doSearch(q) {
  try {
    const res = await fetch("/api/search?q=" + encodeURIComponent(q));
    const data = await res.json();
    const list = (data.suggestions || [])
      .map((s) => s.split("\t"))
      .filter((p) => p.length === 2 && /^[0-9]{4,6}[A-Z]?$/.test(p[0]));
    dropdown.innerHTML = "";
    if (!list.length) { hideDropdown(); return; }
    for (const [code, name] of list.slice(0, 15)) {
      const div = document.createElement("div");
      div.className = "search-item";
      div.innerHTML = `<span class="code">${code}</span><span>${name}</span>`;
      div.addEventListener("click", () => {
        hideDropdown();
        searchInput.value = `${code} ${name}`;
        openStock(code, name);
      });
      dropdown.appendChild(div);
    }
    dropdown.classList.remove("hidden");
    activeIdx = -1;
  } catch (e) { hideDropdown(); }
}

// ────────────────────────── 開啟個股 ──────────────────────────
async function openStock(code, name) {
  state.current = { code, name, market: null };
  state.quote = null;
  setStatus("載入中…");
  renderQuote();
  renderAccount();
  renderFavorites();
  renderHoldings();

  clearInterval(state.backfillTimer);
  await pollQuote();                 // 先抓一次（同時判定上市/上櫃）

  loadDaily(code);
  loadIntraday(code, "5d");          // 分K歷史（近5個交易日）
  // 每分鐘回補一次真實成交分K，修正盤中即時推估
  state.backfillTimer = setInterval(() => loadIntraday(code, "1d"), 60000);
  renderChart();
}

// 分K歷史：證交所無公開歷史分K，取自 Yahoo Finance，與即時合成資料合併
async function loadIntraday(code, rng) {
  const cur = state.current;
  if (!cur || cur.code !== code) return;
  try {
    const market = cur.market || "tse";
    const res = await fetch(`/api/intraday?code=${encodeURIComponent(code)}&market=${market}&range=${rng}`);
    const data = await res.json();
    const bars = data.candles || [];
    if (!bars.length) return;
    const store = getStore(code);
    for (const b of bars) store.candles1m.set(b.time, b);
    if (state.current && state.current.code === code && state.interval !== "1d") {
      renderChart(true);
    }
  } catch (e) { /* 回補失敗不影響即時合成 */ }
}

// ────────────────────────── 即時報價輪詢 ──────────────────────────
function parseMsg(msg) {
  const q = {
    code: msg.c, name: msg.n, market: msg.ex,
    open: num(msg.o), high: num(msg.h), low: num(msg.l),
    prevClose: num(msg.y),
    price: num(msg.z),               // 最新成交價（可能為 '-'）
    cumVol: num(msg.v),              // 累積成交量（張）
    time: msg.t,
    tlong: num(msg.tlong),
    asks: (msg.a || "").split("_").filter(Boolean).map(num),
    bids: (msg.b || "").split("_").filter(Boolean).map(num),
    askVols: (msg.f || "").split("_").filter(Boolean).map(num),
    bidVols: (msg.g || "").split("_").filter(Boolean).map(num),
    limitUp: num(msg.u), limitDown: num(msg.w),
  };
  // 證交所匿名端點常遮蔽最新成交價(z)，以買賣一檔中價推估
  const b1 = q.bids[0], a1 = q.asks[0];
  q.mid = b1 != null && a1 != null
    ? Math.round(((b1 + a1) / 2) * 100) / 100
    : (b1 ?? a1 ?? null);
  q.display = q.price ?? q.mid ?? num(msg.pz) ?? q.prevClose;
  return q;
}

// 一次輪詢：目前個股 + 庫存 + 我的最愛
async function pollQuote() {
  const cur = state.current;
  const codes = new Set();
  if (cur) codes.add(cur.code);
  Object.keys(account.positions).forEach((c) => codes.add(c));
  favorites.forEach((f) => codes.add(f.code));
  if (!codes.size) return;
  try {
    const list = [...codes].slice(0, 20).join(",");
    const res = await fetch("/api/quote?code=" + encodeURIComponent(list));
    const data = await res.json();
    for (const m of data.msgArray || []) {
      if (m.n && m.c) state.quotes[m.c] = parseMsg(m);
    }

    if (cur) {
      const q = state.quotes[cur.code];
      if (!q) { setStatus("查無即時報價"); renderHoldings(); renderFavorites(); return; }
      cur.market = q.market || cur.market;
      cur.name = q.name || cur.name;
      state.quote = q;

      // 寫入分K：有成交價直接用；否則在成交量增加(確實有成交)時以中價推估
      const store = getStore(cur.code);
      const traded = q.cumVol != null &&
        (store.lastCumVol == null || q.cumVol > store.lastCumVol);
      const tickPrice = q.price ?? (traded ? q.mid : null);
      if (tickPrice != null && q.tlong != null) {
        addTick(cur.code, q.tlong, tickPrice, q.cumVol);
      } else if (q.cumVol != null && store.lastCumVol == null) {
        store.lastCumVol = q.cumVol;
      }

      renderQuote();
      renderDepth();
      if (state.interval !== "1d") renderChart(true);
      setStatus(`${q.time || ""} 更新`);
    }
    renderAccount();
    renderHoldings();
    renderFavorites();
  } catch (e) {
    setStatus("即時資料連線失敗");
  }
}

// 依即時成交合成 1 分 K
function addTick(code, tlongMs, price, cumVol) {
  const store = getStore(code);
  const minute = Math.floor(tlongMs / 60000) * 60; // unix 秒，分鐘對齊
  let c = store.candles1m.get(minute);
  const volDelta = store.lastCumVol != null && cumVol != null
    ? Math.max(0, cumVol - store.lastCumVol) : 0;
  if (!c) {
    c = { time: minute, open: price, high: price, low: price, close: price, volume: volDelta };
    store.candles1m.set(minute, c);
  } else {
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.volume += volDelta;
  }
  if (cumVol != null) store.lastCumVol = cumVol;
}

// ────────────────────────── 日K載入 ──────────────────────────
async function loadDaily(code) {
  const store = getStore(code);
  if (store.daily || store.dailyLoading) { renderChart(); return; }
  store.dailyLoading = true;
  setStatus("日K載入中…");
  try {
    // 等第一次報價回來以判定市場別，最多等 3 秒
    for (let i = 0; i < 6 && !state.current.market; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const market = state.current.market || "tse";
    const res = await fetch(`/api/daily?code=${encodeURIComponent(code)}&market=${market}&months=12`);
    const data = await res.json();
    store.daily = data.candles || [];
    if (state.current && state.current.code === code) renderChart();
  } catch (e) {
    store.daily = [];
    setStatus("日K載入失敗");
  } finally {
    store.dailyLoading = false;
  }
}

// ────────────────────────── 圖表渲染 ──────────────────────────
function candlesFor(interval) {
  const cur = state.current;
  if (!cur) return [];
  const store = getStore(cur.code);

  if (interval === "1d") return store.daily || [];

  const m1 = [...store.candles1m.values()].sort((a, b) => a.time - b.time);
  if (interval === "1m") return m1;

  // 5 分 K：由 1 分 K 聚合
  const map = new Map();
  for (const c of m1) {
    const bucket = Math.floor(c.time / 300) * 300;
    let b = map.get(bucket);
    if (!b) {
      b = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      map.set(bucket, b);
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function renderChart(liveUpdate = false) {
  const interval = state.interval;
  const intraday = interval !== "1d";
  const raw = candlesFor(interval);
  const prevClose = state.quote ? state.quote.prevClose : null;

  chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });

  const candles = raw.map((c) => ({
    time: intraday ? c.time + TZ_OFFSET : c.time,
    open: c.open, high: c.high, low: c.low, close: c.close,
  }));
  const volumes = raw.map((c) => ({
    time: intraday ? c.time + TZ_OFFSET : c.time,
    value: c.volume,
    color: c.close >= c.open ? "rgba(240,82,79,.55)" : "rgba(46,175,108,.55)",
  }));

  candleSeries.setData(candles);
  volumeSeries.setData(volumes);

  // 均線（SMA，以收盤價計算）
  const latestMA = [];
  MA_DEFS.forEach((def, i) => {
    const pts = [];
    let sum = 0;
    for (let j = 0; j < raw.length; j++) {
      sum += raw[j].close;
      if (j >= def.period) sum -= raw[j - def.period].close;
      if (j >= def.period - 1) {
        pts.push({ time: candles[j].time, value: sum / def.period });
      }
    }
    maSeries[i].setData(pts);
    latestMA[i] = pts.length ? pts[pts.length - 1].value : null;
  });
  renderMaLegend(latestMA);

  if (!liveUpdate) chart.timeScale().fitContent();

  if (intraday && !raw.length) {
    setStatus(prevClose != null ? "等待成交中…（分K自開啟後即時累積）" : "");
  }
}

function renderMaLegend(latest) {
  const el = $("maLegend");
  el.innerHTML = MA_DEFS.map((d, i) => {
    const v = latest && latest[i] != null ? fmt(latest[i]) : "-";
    return `<span class="ma-item" style="color:${d.color}">MA${d.period} ${v}</span>`;
  }).join("");
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.interval = btn.dataset.interval;
    renderChart();
  });
});

// ────────────────────────── 報價列 / 五檔 ──────────────────────────
function renderQuote() {
  const bar = $("quoteBar");
  const cur = state.current;
  if (!cur) { bar.innerHTML = '<div class="placeholder">請在右上角搜尋並選擇股票</div>'; return; }
  const q = state.quote;
  if (!q) {
    bar.innerHTML = `<span class="q-name">${cur.name || ""}</span><span class="q-code">${cur.code}</span><span class="placeholder">報價載入中…</span>`;
    return;
  }
  const chg = q.display != null && q.prevClose != null ? q.display - q.prevClose : null;
  const chgPct = chg != null && q.prevClose ? (chg / q.prevClose) * 100 : null;
  const cls = clsOf(chg ?? 0);
  const sign = chg > 0 ? "▲" : chg < 0 ? "▼" : "";
  const marketName = q.market === "otc" ? "上櫃" : "上市";
  const fav = isFav(q.code);
  bar.innerHTML = `
    <button id="favStar" class="star-btn ${fav ? "on" : ""}" title="${fav ? "移出" : "加入"}我的最愛">${fav ? "★" : "☆"}</button>
    <span class="q-name">${q.name}</span>
    <span class="q-code">${q.code}・${marketName}</span>
    <span class="q-price ${cls}">${fmt(q.display)}</span>
    <span class="q-chg ${cls}">${sign} ${chg == null ? "-" : fmt(Math.abs(chg))} (${chgPct == null ? "-" : fmt(Math.abs(chgPct)) + "%"})</span>
    <span class="q-item">開<b class="${clsOf((q.open ?? 0) - (q.prevClose ?? 0))}">${fmt(q.open)}</b></span>
    <span class="q-item">高<b class="${clsOf((q.high ?? 0) - (q.prevClose ?? 0))}">${fmt(q.high)}</b></span>
    <span class="q-item">低<b class="${clsOf((q.low ?? 0) - (q.prevClose ?? 0))}">${fmt(q.low)}</b></span>
    <span class="q-item">昨收<b>${fmt(q.prevClose)}</b></span>
    <span class="q-item">總量<b>${fmtInt(q.cumVol)} 張</b></span>`;
  $("favStar").addEventListener("click", () => toggleFav(q.code, q.name));

  $("btnBuy").disabled = q.display == null;
  $("btnSell").disabled = q.display == null;
}

// ────────────────────────── 我的最愛 / 庫存清單 ──────────────────────────
function renderFavorites() {
  const el = $("favList");
  if (!favorites.length) {
    el.innerHTML = '<div class="placeholder">尚無最愛。開啟股票後點報價旁的 ☆ 加入。</div>';
    return;
  }
  el.innerHTML = "";
  for (const f of favorites) {
    const q = state.quotes[f.code];
    let row2 = "";
    if (q && q.display != null) {
      const chg = q.prevClose != null ? q.display - q.prevClose : null;
      const pct = chg != null && q.prevClose ? (chg / q.prevClose) * 100 : null;
      const cls = clsOf(chg ?? 0);
      row2 = `<div class="row2">
        <span class="${cls}">${fmt(q.display)}</span>
        <span class="${cls}">${pct != null ? (pct > 0 ? "+" : "") + fmt(pct) + "%" : ""}</span>
      </div>`;
    }
    const div = document.createElement("div");
    div.className = "stock-item" +
      (state.current && state.current.code === f.code ? " current" : "");
    div.innerHTML = `
      <div class="row1">
        <span class="name">${f.name}</span>
        <span class="code">${f.code}</span>
        <button class="star-btn on" title="移出我的最愛">★</button>
      </div>${row2}`;
    div.querySelector(".star-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFav(f.code, f.name);
    });
    div.addEventListener("click", () => openStock(f.code, f.name));
    el.appendChild(div);
  }
}

// 部位淨損益：價差 - 已付進場費用 - 預估出場費用（手續費；多單平倉另有證交稅）
// 與帳戶現金增減一致
function positionPnl(pos, price) {
  const absQty = Math.abs(pos.qty);
  const shares = absQty * 1000;
  const gross = pos.qty > 0
    ? (price - pos.avg) * shares
    : (pos.avg - price) * shares;
  const exitAmount = price * shares;
  const exitFee = fee(exitAmount);
  const exitTax = pos.qty > 0 ? Math.round(exitAmount * TAX_RATE) : 0;
  const net = gross - (pos.feePaid || 0) - exitFee - exitTax;
  const cost = pos.avg * shares;
  return { net, rate: cost ? (net / cost) * 100 : null };
}

function renderHoldings() {
  const el = $("holdList");
  const entries = Object.entries(account.positions);
  if (!entries.length) {
    el.innerHTML = '<div class="placeholder">目前無庫存。用右側模擬下單建立部位。</div>';
    return;
  }
  el.innerHTML = "";
  for (const [code, pos] of entries) {
    const q = state.quotes[code];
    const price = q && q.display != null ? q.display : null;
    const absQty = Math.abs(pos.qty);
    let pnl = null, rate = null;
    if (price != null) {
      ({ net: pnl, rate } = positionPnl(pos, price));
    }
    const cls = clsOf(pnl ?? 0);
    const div = document.createElement("div");
    div.className = "stock-item" +
      (state.current && state.current.code === code ? " current" : "");
    div.innerHTML = `
      <div class="row1">
        <span class="name">${pos.name || code}</span>
        <span class="code">${code}</span>
      </div>
      <div class="row2">
        <span class="lbl">${pos.qty > 0 ? "多" : "空"} ${absQty} 張 @${fmt(pos.avg)}</span>
        <span>${price != null ? fmt(price) : "-"}</span>
      </div>
      <div class="row2">
        <span class="${cls}">${pnl != null ? (pnl > 0 ? "+" : "") + fmtInt(pnl) : "-"}</span>
        <span class="${cls}">${rate != null ? (rate > 0 ? "+" : "") + fmt(rate) + "%" : "-"}</span>
      </div>`;
    div.addEventListener("click", () => openStock(code, pos.name || code));
    el.appendChild(div);
  }
}

// 左側欄頁籤切換
document.querySelectorAll(".ltab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".ltab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $("favList").classList.toggle("hidden", btn.dataset.pane !== "fav");
    $("holdList").classList.toggle("hidden", btn.dataset.pane !== "hold");
  });
});

function renderDepth() {
  const q = state.quote;
  const tbody = document.querySelector("#depthTable tbody");
  let html = "";
  for (let i = 0; i < 5; i++) {
    const bv = q && q.bidVols[i] != null ? fmtInt(q.bidVols[i]) : "-";
    const bp = q && q.bids[i] != null ? fmt(q.bids[i]) : "-";
    const ap = q && q.asks[i] != null ? fmt(q.asks[i]) : "-";
    const av = q && q.askVols[i] != null ? fmtInt(q.askVols[i]) : "-";
    html += `<tr><td>${bv}</td><td class="bid">${bp}</td><td class="ask">${ap}</td><td>${av}</td></tr>`;
  }
  tbody.innerHTML = html;
}

// ────────────────────────── 模擬交易 ──────────────────────────
const FEE_RATE = 0.001425;  // 手續費 0.1425%
const FEE_MIN = 20;
const TAX_RATE = 0.0015;    // 當沖證交稅減半 0.15%（賣出時收）

function fee(amount) { return Math.max(FEE_MIN, Math.round(amount * FEE_RATE)); }

function trade(side) {
  const q = state.quote;
  const cur = state.current;
  if (!q || !cur || q.display == null) return;
  const qty = Math.max(1, Math.floor(num($("orderQty").value) || 1)); // 張
  const price = q.display;
  const shares = qty * 1000;
  const amount = price * shares;
  const f = fee(amount);

  const pos = account.positions[cur.code] ||
    { qty: 0, avg: 0, feePaid: 0, name: cur.name };
  pos.name = cur.name;
  pos.feePaid = pos.feePaid || 0;   // 進場累計費用（手續費+稅），平倉時按比例攤入損益
  const signedQty = side === "buy" ? qty : -qty;

  let tax = 0;
  if (side === "sell") tax = Math.round(amount * TAX_RATE);

  let netRealized = null;           // 平倉才有值：含進出場手續費與稅的淨損益

  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signedQty)) {
    // 建倉 / 加碼（做多或加空）
    const newQty = pos.qty + signedQty;
    pos.avg = (pos.avg * Math.abs(pos.qty) + price * qty) / Math.abs(newQty);
    pos.qty = newQty;
    pos.feePaid += f + tax;
  } else {
    // 反向 → 平倉（平多或空單回補）
    const absBefore = Math.abs(pos.qty);
    const closeQty = Math.min(qty, absBefore);
    const gross = pos.qty > 0
      ? (price - pos.avg) * closeQty * 1000   // 平多
      : (pos.avg - price) * closeQty * 1000;  // 回補空單
    const entryCost = pos.feePaid * (closeQty / absBefore);
    const exitCost = (f + tax) * (closeQty / qty);
    netRealized = Math.round(gross - entryCost - exitCost);
    account.realized += netRealized;
    pos.feePaid -= entryCost;
    pos.qty += signedQty;
    if (pos.qty === 0) {
      pos.avg = 0;
      pos.feePaid = 0;
    } else if (Math.sign(pos.qty) === Math.sign(signedQty)) {
      // 反手：剩餘數量視為新倉
      pos.avg = price;
      pos.feePaid = (f + tax) * ((qty - closeQty) / qty);
    }
  }

  // 現金流：買進付款、賣出收款（放空以收款簡化處理）
  account.cash += side === "buy" ? -(amount + f) : (amount - f - tax);
  if (pos.qty === 0) delete account.positions[cur.code];
  else account.positions[cur.code] = pos;

  account.log.unshift({
    time: new Date().toLocaleTimeString("zh-TW", { hour12: false }),
    code: cur.code, name: cur.name, side, qty, price, fee: f, tax,
    realized: netRealized, closed: netRealized != null,
  });
  if (account.log.length > 200) account.log.length = 200;

  // 每日損益彙總（供損益月曆使用）
  const d = new Date();
  const dkey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  account.daily = account.daily || {};
  const rec = account.daily[dkey] || { pnl: 0, trades: 0 };
  rec.trades += 1;
  if (netRealized != null) rec.pnl += netRealized;
  account.daily[dkey] = rec;

  saveAccount();
  renderAccount();
  renderHoldings();
  renderLog();
}

$("btnBuy").addEventListener("click", () => trade("buy"));
$("btnSell").addEventListener("click", () => trade("sell"));
$("btnReset").addEventListener("click", () => {
  if (!confirm("確定要重置模擬帳戶？（現金回到 10,000,000，清除部位與紀錄）")) return;
  account = { cash: 10000000, positions: {}, realized: 0, log: [], daily: {} };
  saveAccount();
  renderAccount();
  renderHoldings();
  renderLog();
});

function renderAccount() {
  $("acctCash").textContent = fmtInt(account.cash);
  $("acctRealized").textContent = fmtInt(account.realized);
  $("acctRealized").className = "mono " + clsOf(account.realized);

  const cur = state.current;
  const q = state.quote;
  const pos = cur ? account.positions[cur.code] : null;

  if (pos) {
    $("acctPos").textContent = `${pos.qty > 0 ? "多" : "空"} ${Math.abs(pos.qty)} 張`;
    $("acctAvg").textContent = fmt(pos.avg);
  } else {
    $("acctPos").textContent = cur ? "無" : "-";
    $("acctAvg").textContent = "-";
  }

  let unreal = null;
  if (pos && q && q.display != null) {
    unreal = positionPnl(pos, q.display).net;   // 含手續費與證交稅
  }
  $("acctUnrealized").textContent = unreal == null ? "-" : fmtInt(unreal);
  $("acctUnrealized").className = "mono " + clsOf(unreal ?? 0);

  // 總資產 = 現金 + 目前個股部位市值（僅估目前開啟的個股）
  let total = account.cash;
  if (pos && q && q.display != null) total += pos.qty * 1000 * q.display;
  $("acctTotal").textContent = fmtInt(total);
}

function renderLog() {
  const el = $("tradeLog");
  if (!account.log.length) { el.innerHTML = '<div class="placeholder">尚無交易</div>'; return; }
  el.innerHTML = account.log.map((l) => {
    // 平倉（平多/空單回補）一律顯示淨損益（含手續費與證交稅），紅賺綠賠
    const showPnl = l.closed || (l.realized != null && l.realized !== 0);
    const sideTxt = l.side === "buy" ? (l.closed ? "回補" : "買") : (l.closed ? "平倉" : "賣");
    const pnl = showPnl
      ? `<span class="pnl ${clsOf(l.realized)}">${l.realized > 0 ? "+" : ""}${fmtInt(l.realized)}</span>`
      : "";
    return `
    <div class="log-row">
      <span class="t">${l.time}</span>
      <span class="${l.side === "buy" ? "side-buy" : "side-sell"}">${sideTxt}</span>
      <span>${l.code}</span>
      <span>${l.qty}張</span>
      <span class="mono">@${fmt(l.price)}</span>
      ${pnl}
    </div>`;
  }).join("");
}

// ────────────────────────── 損益月曆 ──────────────────────────
const calState = { y: new Date().getFullYear(), m: new Date().getMonth() };

function keyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderCalendar() {
  const { y, m } = calState;
  $("calMonthLabel").textContent = `${y} 年 ${m + 1} 月`;
  const daily = account.daily || {};

  // 當月合計
  let monthPnl = 0, monthTrades = 0, tradingDays = 0;
  const prefix = `${y}-${String(m + 1).padStart(2, "0")}-`;
  for (const [k, r] of Object.entries(daily)) {
    if (k.startsWith(prefix)) {
      monthPnl += r.pnl;
      monthTrades += r.trades;
      tradingDays++;
    }
  }
  $("calSummary").innerHTML = `
    <span>本月損益 <b class="${clsOf(monthPnl)}">${monthPnl > 0 ? "+" : ""}${fmtInt(monthPnl)}</b></span>
    <span>交易 <b>${monthTrades}</b> 筆</span>
    <span>交易日 <b>${tradingDays}</b> 天</span>`;

  const grid = $("calGrid");
  grid.innerHTML = "";
  for (const w of ["日", "一", "二", "三", "四", "五", "六"]) {
    const el = document.createElement("div");
    el.className = "cal-dow";
    el.textContent = w;
    grid.appendChild(el);
  }

  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells = Math.ceil((first.getDay() + daysInMonth) / 7) * 7;
  const start = new Date(y, m, 1 - first.getDay());   // 當週星期日起算
  const todayKey = keyOf(new Date());

  for (let i = 0; i < cells; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = keyOf(d);
    const rec = daily[key];
    const cell = document.createElement("div");
    let cls = "cal-cell";
    if (d.getMonth() !== m) cls += " other";
    if (rec && rec.pnl > 0) cls += " profit";     // 紅賺
    else if (rec && rec.pnl < 0) cls += " loss";  // 綠賠
    if (key === todayKey) cls += " today";
    cell.className = cls;
    let inner = `<div class="d">${String(d.getDate()).padStart(2, "0")}</div>`;
    if (rec) {
      inner += `
        <div class="pnl ${clsOf(rec.pnl)}">${rec.pnl > 0 ? "+" : ""}${fmtInt(rec.pnl)}</div>
        <div class="cnt">${rec.trades} 筆</div>`;
    }
    cell.innerHTML = inner;
    grid.appendChild(cell);
  }
}

$("calBtn").addEventListener("click", () => {
  calState.y = new Date().getFullYear();
  calState.m = new Date().getMonth();
  renderCalendar();
  $("calModal").classList.remove("hidden");
});
$("calClose").addEventListener("click", () => $("calModal").classList.add("hidden"));
$("calModal").addEventListener("click", (e) => {
  if (e.target === $("calModal")) $("calModal").classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("calModal").classList.add("hidden");
});
$("calPrev").addEventListener("click", () => {
  calState.m--;
  if (calState.m < 0) { calState.m = 11; calState.y--; }
  renderCalendar();
});
$("calNext").addEventListener("click", () => {
  calState.m++;
  if (calState.m > 11) { calState.m = 0; calState.y++; }
  renderCalendar();
});

// ────────────────────────── 初始化 ──────────────────────────
(async function init() {
  await bootState();               // 先從伺服器載入帳戶與最愛
  renderAccount();
  renderLog();
  renderDepth();
  renderFavorites();
  renderHoldings();
  // 全域輪詢：即使未開啟個股，也持續更新庫存與最愛的報價
  state.pollTimer = setInterval(pollQuote, POLL_MS);
  pollQuote();
})();

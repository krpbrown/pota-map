const statusEl = document.getElementById("status");
const detailsEl = document.getElementById("details");
const searchEl = document.getElementById("parkSearch");
const resultsEl = document.getElementById("results");
const loadBoundaryBtn = document.getElementById("loadBoundaryBtn");
const clearBoundaryBtn = document.getElementById("clearBoundaryBtn");
const stateCodeInputEl = document.getElementById("stateCodeInput");
const prefetchStateBtn = document.getElementById("prefetchStateBtn");
const prefetchStatusEl = document.getElementById("prefetchStatus");
const toggleIssueLogBtn = document.getElementById("toggleIssueLogBtn");
const exportIssueLogBtn = document.getElementById("exportIssueLogBtn");
const clearIssueLogBtn = document.getElementById("clearIssueLogBtn");
const exportBoundaryBundleBtn = document.getElementById("exportBoundaryBundleBtn");
const importBoundaryBundleBtn = document.getElementById("importBoundaryBundleBtn");
const importBoundaryFileInput = document.getElementById("importBoundaryFileInput");
const clearSessionCacheBtn = document.getElementById("clearSessionCacheBtn");
const issueLogSummaryEl = document.getElementById("issueLogSummary");
const issueLogOutputEl = document.getElementById("issueLogOutput");
const toggleDiagBtn = document.getElementById("toggleDiagBtn");
const copyDiagBtn = document.getElementById("copyDiagBtn");
const clearDiagBtn = document.getElementById("clearDiagBtn");
const diagSummaryEl = document.getElementById("diagSummary");
const diagOutputEl = document.getElementById("diagOutput");

// If the user pressed browser reload, force a cache-busted navigation once.
(() => {
  const navEntry = performance.getEntriesByType?.("navigation")?.[0];
  if (navEntry?.type !== "reload") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("_hr", Date.now().toString());
  if (url.toString() !== window.location.href) {
    window.location.replace(url.toString());
  }
})();

const map = L.map("map", {
  zoomAnimation: false,
  fadeAnimation: false,
  markerZoomAnimation: false,
}).setView([39.5, -98.35], 4);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// Keep Leaflet math in sync with responsive/layout changes.
window.addEventListener("resize", () => {
  map.invalidateSize();
});
window.setTimeout(() => {
  map.invalidateSize();
}, 0);
window.setTimeout(() => {
  map.invalidateSize(true);
  map.setView([39.5, -98.35], map.getZoom(), { animate: false });
}, 150);

let parks = [];
let currentPark = null;
let pointMarker = null;
let boundaryLayer = null;
const boundaryCache = new Map();
const noBoundaryCache = new Set();
let isPrefetching = false;
const BOUNDARY_DB_NAME = "pota-boundary-cache";
const BOUNDARY_DB_VERSION = 1;
const BOUNDARY_STORE_NAME = "boundaries";
const NO_BOUNDARY_CACHE_VERSION = 2;
const BOUNDARY_BUNDLE_VERSION = 1;
let boundaryDbPromise = null;
const ISSUE_LOG_STORAGE_KEY = "pota-boundary-issue-log-v1";
const OVERPASS_TIMEOUT_MS_INTERACTIVE = 25000;
const OVERPASS_TIMEOUT_MS_PREFETCH = 12000;
let issueLog = [];
let sessionIgnorePersistedCache = false;
let boundaryDiagEntries = [];
let boundaryDiagStartMs = 0;

function setStatus(message) {
  statusEl.textContent = message;
}

function setPrefetchStatus(message) {
  prefetchStatusEl.textContent = message;
}

function shortenErrorMessage(err) {
  const msg = String(err?.message || err || "Unknown error");
  return msg.replace(/\s+/g, " ").slice(0, 600);
}

function appendBoundaryDiag(level, message) {
  const now = Date.now();
  const elapsed = boundaryDiagStartMs ? now - boundaryDiagStartMs : 0;
  const prefix = `[+${(elapsed / 1000).toFixed(2)}s] [${level}]`;
  boundaryDiagEntries.push(`${prefix} ${message}`);
  if (boundaryDiagEntries.length > 300) {
    boundaryDiagEntries = boundaryDiagEntries.slice(boundaryDiagEntries.length - 300);
  }
  renderBoundaryDiagnostics();
}

function renderBoundaryDiagnostics() {
  if (!boundaryDiagEntries.length) {
    diagSummaryEl.textContent = "No boundary diagnostics yet.";
    diagOutputEl.textContent = "";
    return;
  }
  const last = boundaryDiagEntries[boundaryDiagEntries.length - 1];
  diagSummaryEl.textContent = `Boundary diagnostics: ${boundaryDiagEntries.length} entries. Last: ${last}`;
  diagOutputEl.textContent = boundaryDiagEntries.join("\n");
}

function startBoundaryDiagnostics(park) {
  boundaryDiagEntries = [];
  boundaryDiagStartMs = Date.now();
  appendBoundaryDiag("info", `Boundary request started for ${park.reference} ${park.name}`);
}

function clearBoundaryDiagnostics() {
  boundaryDiagEntries = [];
  boundaryDiagStartMs = 0;
  renderBoundaryDiagnostics();
}

function toggleBoundaryDiagnostics() {
  diagOutputEl.hidden = !diagOutputEl.hidden;
  toggleDiagBtn.textContent = diagOutputEl.hidden ? "View Boundary Diagnostics" : "Hide Boundary Diagnostics";
}

async function copyBoundaryDiagnostics() {
  const text = diagOutputEl.textContent || "";
  if (!text) {
    diagSummaryEl.textContent = "No diagnostics to copy yet.";
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    diagSummaryEl.textContent = `Boundary diagnostics copied (${boundaryDiagEntries.length} entries).`;
  } catch (err) {
    diagSummaryEl.textContent = `Copy failed: ${shortenErrorMessage(err)}`;
  }
}

function loadIssueLog() {
  try {
    const raw = localStorage.getItem(ISSUE_LOG_STORAGE_KEY);
    if (!raw) {
      issueLog = [];
      return;
    }
    const parsed = JSON.parse(raw);
    issueLog = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Issue log load failed", err);
    issueLog = [];
  }
}

function saveIssueLog() {
  try {
    localStorage.setItem(ISSUE_LOG_STORAGE_KEY, JSON.stringify(issueLog));
  } catch (err) {
    console.error("Issue log save failed", err);
  }
}

function summarizeIssueLog() {
  const noBoundary = issueLog.filter((x) => x.status === "no-boundary").length;
  const failed = issueLog.filter((x) => x.status === "failed").length;
  return { total: issueLog.length, noBoundary, failed };
}

function formatIssueLogEntries(entries) {
  if (!entries.length) {
    return "No issue entries yet.";
  }
  return entries
    .slice()
    .reverse()
    .map((entry) => {
      const time = new Date(entry.timestamp).toLocaleString();
      const base = `${time} | ${entry.state} | ${entry.reference} | ${entry.name} | ${entry.status}`;
      if (entry.error) {
        return `${base} | ${entry.error}`;
      }
      return base;
    })
    .join("\n");
}

function renderIssueLog() {
  const summary = summarizeIssueLog();
  issueLogSummaryEl.textContent = `Issue log entries: ${summary.total} (no-boundary ${summary.noBoundary}, failed ${summary.failed})`;
  issueLogOutputEl.textContent = formatIssueLogEntries(issueLog);
}

function appendIssueLogEntry(entry) {
  issueLog.push(entry);
  // Keep recent history bounded.
  if (issueLog.length > 5000) {
    issueLog = issueLog.slice(issueLog.length - 5000);
  }
  saveIssueLog();
  renderIssueLog();
}

function clearIssueLog() {
  issueLog = [];
  saveIssueLog();
  renderIssueLog();
}

function toggleIssueLog() {
  issueLogOutputEl.hidden = !issueLogOutputEl.hidden;
  toggleIssueLogBtn.textContent = issueLogOutputEl.hidden ? "View Issue Log" : "Hide Issue Log";
}

function exportIssueLog() {
  const blob = new Blob([JSON.stringify(issueLog, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replaceAll(":", "-");
  a.href = url;
  a.download = `pota-boundary-issue-log-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearSessionCache() {
  boundaryCache.clear();
  noBoundaryCache.clear();
  sessionIgnorePersistedCache = true;
  setPrefetchStatus("Session cache cleared. Persisted cache is ignored until page refresh.");
}

function openBoundaryDb() {
  if (!("indexedDB" in window)) {
    return Promise.resolve(null);
  }
  if (boundaryDbPromise) {
    return boundaryDbPromise;
  }

  boundaryDbPromise = new Promise((resolve) => {
    const request = indexedDB.open(BOUNDARY_DB_NAME, BOUNDARY_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOUNDARY_STORE_NAME)) {
        db.createObjectStore(BOUNDARY_STORE_NAME, { keyPath: "reference" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.error("IndexedDB open failed", request.error);
      resolve(null);
    };
  });

  return boundaryDbPromise;
}

async function dbReadBoundary(reference) {
  const db = await openBoundaryDb();
  if (!db) {
    return null;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(BOUNDARY_STORE_NAME, "readonly");
    const store = tx.objectStore(BOUNDARY_STORE_NAME);
    const request = store.get(reference);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => {
      console.error("IndexedDB read failed", request.error);
      resolve(null);
    };
  });
}

async function dbWriteBoundary(reference, geojson) {
  const db = await openBoundaryDb();
  if (!db) {
    return;
  }
  await new Promise((resolve) => {
    const tx = db.transaction(BOUNDARY_STORE_NAME, "readwrite");
    const store = tx.objectStore(BOUNDARY_STORE_NAME);
    store.put({
      reference,
      geojson: geojson || null,
      noBoundaryVersion: geojson ? null : NO_BOUNDARY_CACHE_VERSION,
      updatedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      console.error("IndexedDB write failed", tx.error);
      resolve();
    };
    tx.onabort = () => {
      console.error("IndexedDB write aborted", tx.error);
      resolve();
    };
  });
}

async function dbReadAllBoundaries() {
  const db = await openBoundaryDb();
  if (!db) {
    return [];
  }
  return new Promise((resolve) => {
    const tx = db.transaction(BOUNDARY_STORE_NAME, "readonly");
    const store = tx.objectStore(BOUNDARY_STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => {
      console.error("IndexedDB read-all failed", request.error);
      resolve([]);
    };
  });
}

async function dbBulkWriteBoundaries(records) {
  const db = await openBoundaryDb();
  if (!db || !Array.isArray(records) || !records.length) {
    return;
  }
  await new Promise((resolve) => {
    const tx = db.transaction(BOUNDARY_STORE_NAME, "readwrite");
    const store = tx.objectStore(BOUNDARY_STORE_NAME);
    records.forEach((record) => {
      if (!record?.reference) {
        return;
      }
      store.put({
        reference: record.reference,
        geojson: record.geojson || null,
        noBoundaryVersion: record.geojson ? null : (record.noBoundaryVersion || NO_BOUNDARY_CACHE_VERSION),
        updatedAt: record.updatedAt || Date.now(),
      });
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      console.error("IndexedDB bulk-write failed", tx.error);
      resolve();
    };
    tx.onabort = () => {
      console.error("IndexedDB bulk-write aborted", tx.error);
      resolve();
    };
  });
}

function applyBoundaryRecordsToMemory(records) {
  records.forEach((record) => {
    if (!record?.reference) {
      return;
    }
    if (record.geojson && record.geojson.features?.length) {
      boundaryCache.set(record.reference, record.geojson);
      noBoundaryCache.delete(record.reference);
    } else if (record.noBoundaryVersion === NO_BOUNDARY_CACHE_VERSION) {
      noBoundaryCache.add(record.reference);
      boundaryCache.delete(record.reference);
    }
  });
}

async function exportBoundaryBundle() {
  const records = await dbReadAllBoundaries();
  const bundle = {
    version: BOUNDARY_BUNDLE_VERSION,
    generatedAt: new Date().toISOString(),
    records: records.map((x) => ({
      reference: x.reference,
      geojson: x.geojson || null,
      noBoundaryVersion: x.noBoundaryVersion || null,
      updatedAt: x.updatedAt || null,
    })),
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replaceAll(":", "-");
  a.href = url;
  a.download = `pota-boundaries-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importBoundaryBundleFromObject(bundle) {
  const records = Array.isArray(bundle?.records) ? bundle.records : null;
  if (!records) {
    throw new Error("Invalid boundary bundle format (missing records array).");
  }
  await dbBulkWriteBoundaries(records);
  applyBoundaryRecordsToMemory(records);
  setPrefetchStatus(`Imported ${records.length.toLocaleString()} boundary record(s).`);
}

function importBoundaryBundleFromFile(file) {
  if (!file) {
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const text = String(reader.result || "");
      const parsed = JSON.parse(text);
      await importBoundaryBundleFromObject(parsed);
    } catch (err) {
      console.error(err);
      setPrefetchStatus(`Boundary import failed: ${err?.message || String(err)}`);
    } finally {
      importBoundaryFileInput.value = "";
    }
  };
  reader.onerror = () => {
    setPrefetchStatus("Boundary import failed: could not read file.");
    importBoundaryFileInput.value = "";
  };
  reader.readAsText(file);
}

async function loadBundledBoundariesFile() {
  try {
    const response = await fetch("data/us-boundaries.json", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const bundle = await response.json();
    await importBoundaryBundleFromObject(bundle);
  } catch (err) {
    // Optional file; ignore when absent or invalid.
    console.error("Bundled boundary load skipped", err);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function updateButtons() {
  loadBoundaryBtn.disabled = !currentPark;
  clearBoundaryBtn.disabled = !boundaryLayer;
  prefetchStateBtn.disabled = isPrefetching;
}

function clearBoundary() {
  if (boundaryLayer) {
    map.removeLayer(boundaryLayer);
    boundaryLayer = null;
  }
  updateButtons();
}

function setCurrentPark(park) {
  currentPark = park;
  clearBoundary();

  if (pointMarker) {
    pointMarker.remove();
  }

  pointMarker = L.marker([park.lat, park.lon]).addTo(map);
  pointMarker.bindPopup(`<strong>${escapeHtml(park.reference)}</strong><br>${escapeHtml(park.name)}`);
  map.setView([park.lat, park.lon], 11);

  detailsEl.innerHTML = `
    <strong>${escapeHtml(park.reference)}</strong><br>
    ${escapeHtml(park.name)}<br>
    ${escapeHtml(park.location)}<br>
    ${park.lat.toFixed(4)}, ${park.lon.toFixed(4)} (${escapeHtml(park.grid || "n/a")})<br>
    <a href="https://pota.app/#/park/${encodeURIComponent(park.reference)}" target="_blank" rel="noopener noreferrer">View on POTA.app</a>
  `;
  setStatus("Park selected. Click “Load Boundary” to fetch polygons.");
  updateButtons();
}

function renderResults(matches) {
  resultsEl.innerHTML = "";

  if (!matches.length) {
    return;
  }

  matches.forEach((park) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "result";
    if (currentPark && currentPark.reference === park.reference) {
      btn.classList.add("active");
    }
    btn.innerHTML = `<strong>${escapeHtml(park.reference)}</strong> ${escapeHtml(park.name)}`;
    btn.addEventListener("click", () => {
      setCurrentPark(park);
      searchEl.value = `${park.reference} ${park.name}`;
      renderResults([]);
    });
    resultsEl.appendChild(btn);
  });
}

function findMatches(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [];
  }

  const refExact = parks.find((p) => p.reference.toLowerCase() === q);
  if (refExact) {
    return [refExact];
  }

  const starts = parks.filter((p) => p.reference.toLowerCase().startsWith(q));
  if (starts.length) {
    return starts.slice(0, 25);
  }

  const nameMatches = parks.filter((p) => p.name.toLowerCase().includes(q));
  return nameMatches.slice(0, 25);
}

function onSearchInput() {
  const matches = findMatches(searchEl.value);
  renderResults(matches);
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function ringCentroid(coords) {
  let latTotal = 0;
  let lonTotal = 0;
  let count = 0;
  coords.forEach((p) => {
    lonTotal += p[0];
    latTotal += p[1];
    count += 1;
  });
  if (!count) {
    return null;
  }
  return [latTotal / count, lonTotal / count];
}

function lineCentroid(coords) {
  let latTotal = 0;
  let lonTotal = 0;
  let count = 0;
  coords.forEach((p) => {
    lonTotal += p[0];
    latTotal += p[1];
    count += 1;
  });
  if (!count) {
    return null;
  }
  return [latTotal / count, lonTotal / count];
}

function featureCenter(feature) {
  if (!feature || !feature.geometry) {
    return null;
  }
  const g = feature.geometry;
  if (g.type === "Polygon" && g.coordinates?.[0]) {
    return ringCentroid(g.coordinates[0]);
  }
  if (g.type === "MultiPolygon" && g.coordinates?.[0]?.[0]) {
    return ringCentroid(g.coordinates[0][0]);
  }
  if (g.type === "LineString" && g.coordinates) {
    return lineCentroid(g.coordinates);
  }
  if (g.type === "MultiLineString" && g.coordinates?.[0]) {
    return lineCentroid(g.coordinates[0]);
  }
  return null;
}

function normalizeForNameMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/\bblm\b/g, " ")
    .replace(/\bspecial recreation management area\b/g, " ")
    .replace(/\brecreation management area\b/g, " ")
    .replace(/\bmanagement area\b/g, " ")
    .replace(/\bconservation area\b/g, " ")
    .replace(/\bnational conservation area\b/g, " ")
    .replace(/\bnational wildlife refuge\b/g, " ")
    .replace(/\bnational wild and scenic river\b/g, " river ")
    .replace(/\bwild and scenic river\b/g, " river ")
    .replace(/\bnational historical park\b/g, " ")
    .replace(/\bnational historic trail\b/g, " ")
    .replace(/\bnational recreation area\b/g, " ")
    .replace(/\bnational monument\b/g, " ")
    .replace(/\bnational park\b/g, " ")
    .replace(/\bnational forest\b/g, " ")
    .replace(/\bstate park\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parkNameVariants(parkName) {
  const raw = String(parkName || "").trim();
  if (!raw) {
    return [];
  }
  const lowered = raw.toLowerCase();
  const variants = [raw];

  const stripped = raw
    .replace(/\bBLM\b/gi, " ")
    .replace(/\bSpecial Recreation Management Area\b/gi, " ")
    .replace(/\bRecreation Management Area\b/gi, " ")
    .replace(/\bNational Conservation Area\b/gi, " ")
    .replace(/\bConservation Area\b/gi, " ")
    .replace(/\bManagement Area\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped && stripped.toLowerCase() !== lowered) {
    variants.push(stripped);
  }

  const core = normalizeForNameMatch(raw)
    .split(" ")
    .filter(Boolean)
    .join(" ");
  if (core && core !== normalizeForNameMatch(raw)) {
    variants.push(core.replace(/\b\w/g, (c) => c.toUpperCase()));
  }

  return Array.from(new Set(variants));
}

const WATERBODY_TOKENS = new Set([
  "river",
  "lake",
  "creek",
  "canyon",
  "fork",
  "bay",
  "gulf",
  "reservoir",
  "stream",
]);

function nameSimilarityScore(a, b) {
  const ta = new Set(normalizeForNameMatch(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeForNameMatch(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) {
    return 0;
  }

  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token)) {
      intersection += 1;
    }
  }

  // Avoid false positives from only one shared generic token (e.g. "Bear Lake" vs "Bear River").
  if (intersection < 2) {
    return 0;
  }

  const waterA = new Set(Array.from(ta).filter((t) => WATERBODY_TOKENS.has(t)));
  const waterB = new Set(Array.from(tb).filter((t) => WATERBODY_TOKENS.has(t)));
  if (waterA.size && waterB.size) {
    const sharedWater = Array.from(waterA).some((token) => waterB.has(token));
    if (!sharedWater) {
      return 0;
    }
  }

  // Prefer strong token overlap when one name is a superset of the other.
  return intersection / Math.min(ta.size, tb.size);
}

function buildOverpassQuery(park, radiusMeters, options = {}) {
  const includeRelations = options.includeRelations !== false;
  const includeWays = options.includeWays !== false;
  const variants = parkNameVariants(park.name);
  const isStateParkName = /state park/i.test(park.name);
  if (/state park/i.test(park.name) && !/museum/i.test(park.name)) {
    variants.push(`${park.name} and Museum`);
  }
  const pattern = variants.map((v) => escapeOverpassRegex(v)).join("|");
  const relationLines = includeRelations ? `
  relation(around:${radiusMeters},${park.lat},${park.lon})["name"~"^(${pattern})$",i]["leisure"="park"];
` : "";
  const wayLines = includeWays ? `
  way(around:${radiusMeters},${park.lat},${park.lon})["name"~"^(${pattern})$",i]["leisure"="park"];
` : "";
  const parkTagLines = isStateParkName ? `${relationLines}${wayLines}` : "";
  const relationQueryLines = includeRelations ? `
  relation(around:${radiusMeters},${park.lat},${park.lon})["name"~"^(${pattern})$",i]["boundary"~"protected_area|national_park"];
  relation(around:${radiusMeters},${park.lat},${park.lon})["name"~"^(${pattern})$",i]["leisure"="nature_reserve"];
  relation(around:${radiusMeters},${park.lat},${park.lon})["name"~"^(${pattern})$",i]["type"="boundary"];
` : "";
  const wayQueryLines = includeWays ? `
  way(around:${radiusMeters},${park.lat},${park.lon})["name"~"^(${pattern})$",i]["boundary"~"protected_area|national_park"];
  way(around:${radiusMeters},${park.lat},${park.lon})["name"~"^(${pattern})$",i]["leisure"="nature_reserve"];
` : "";
  return `
[out:json][timeout:25];
(
  ${relationQueryLines}
  ${wayQueryLines}
  ${parkTagLines}
);
out body;
>;
out skel qt;
`.trim();
}

function buildOverpassBroadQuery(park, radiusMeters) {
  const isStateParkName = /state park/i.test(park.name);
  const parkTagLines = isStateParkName
    ? `
  relation(around:${radiusMeters},${park.lat},${park.lon})["leisure"="park"];
  way(around:${radiusMeters},${park.lat},${park.lon})["leisure"="park"];`
    : "";
  return `
[out:json][timeout:25];
(
  relation(around:${radiusMeters},${park.lat},${park.lon})["boundary"~"protected_area|national_park"];
  relation(around:${radiusMeters},${park.lat},${park.lon})["leisure"="nature_reserve"];
  way(around:${radiusMeters},${park.lat},${park.lon})["boundary"~"protected_area|national_park"];
  way(around:${radiusMeters},${park.lat},${park.lon})["leisure"="nature_reserve"];
  ${parkTagLines}
);
out body;
>;
out skel qt;
`.trim();
}

function getSearchRadii(park, mode) {
  const fastMode = mode === "fast";
  const name = String(park.name || "");
  if (/National Forest/i.test(name)) {
    return fastMode ? [140000, 220000] : [160000, 260000];
  }
  if (/state park/i.test(name)) {
    return fastMode ? [20000, 45000] : [25000, 60000];
  }
  if (/national park|national monument|wildlife refuge|recreation area/i.test(name)) {
    return fastMode ? [35000, 80000] : [45000, 110000];
  }
  return fastMode ? [30000, 70000] : [40000, 100000];
}

function isRiverPark(park) {
  return /wild and scenic river/i.test(String(park?.name || ""));
}

function isLikelyNonPolygonPark(park) {
  const name = String(park?.name || "");
  return /\b(historic trail|scenic trail|state trail|national trail|parkway)\b/i.test(name);
}

function escapeOverpassRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function riverCoreName(parkName) {
  return String(parkName || "")
    .replace(/\bnational wild and scenic river\b/i, "")
    .replace(/\bwild and scenic river\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function riverNameVariants(parkName) {
  const core = riverCoreName(parkName);
  const variants = [String(parkName || "").trim()];
  if (core) {
    variants.push(`${core} River`);
    variants.push(`North Fork ${core} River`);
    variants.push(`South Fork ${core} River`);
    variants.push(`${core} River Wilderness Study Area`);
  }
  return Array.from(new Set(variants.filter(Boolean)));
}

function buildRiverExactNameQuery(park, radiusMeters, exactName) {
  const name = exactName.replaceAll('"', '\\"');
  return `
[out:json][timeout:60];
(
  relation(around:${radiusMeters},${park.lat},${park.lon})["name"="${name}"]["type"="waterway"];
  relation(around:${radiusMeters},${park.lat},${park.lon})["name"="${name}"]["waterway"="river"];
  relation(around:${radiusMeters},${park.lat},${park.lon})["name"="${name}"]["boundary"~"protected_area|national_park"];
  relation(around:${radiusMeters},${park.lat},${park.lon})["name"="${name}"]["leisure"="nature_reserve"];
  way(around:${radiusMeters},${park.lat},${park.lon})["name"="${name}"]["waterway"="river"];
  way(around:${radiusMeters},${park.lat},${park.lon})["name"="${name}"]["boundary"~"protected_area|national_park"];
  way(around:${radiusMeters},${park.lat},${park.lon})["name"="${name}"]["leisure"="nature_reserve"];
);
out body;
>;
out skel qt;
`.trim();
}

function extractFeaturesByMode(geo, mode) {
  const all = geo.features || [];
  if (mode === "river") {
    return all.filter(
      (f) => f.geometry && (
        f.geometry.type === "LineString"
        || f.geometry.type === "MultiLineString"
        || f.geometry.type === "Polygon"
        || f.geometry.type === "MultiPolygon"
      ),
    );
  }
  return all.filter(
    (f) => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"),
  );
}

async function overpassRequest(query, options = {}) {
  const timeoutMs = Number(options.timeoutMs || OVERPASS_TIMEOUT_MS_INTERACTIVE);
  const diag = typeof options.diag === "function" ? options.diag : null;
  const diagTag = options.diagTag ? ` (${options.diagTag})` : "";
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  const body = `data=${encodeURIComponent(query)}`;

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const endpointStart = Date.now();
      if (diag) {
        diag("info", `Trying ${endpoint}${diagTag} timeout=${timeoutMs}ms queryLen=${query.length}`);
      }
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body,
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeoutId);
      }
      if (!response.ok) {
        throw new Error(`${endpoint} returned ${response.status}`);
      }
      const payload = await response.json();
      const remark = String(payload?.remark || "");
      if (remark && /runtime error|timed out|too busy|Dispatcher_Client/i.test(remark)) {
        throw new Error(`Overpass remark from ${endpoint}: ${remark}`);
      }
      if (diag) {
        diag("info", `${endpoint}${diagTag} succeeded in ${Date.now() - endpointStart}ms`);
      }
      return payload;
    } catch (err) {
      if (err?.name === "AbortError") {
        lastError = new Error(`Timed out after ${timeoutMs}ms at ${endpoint}`);
      } else {
        lastError = err;
      }
      if (diag) {
        diag("warn", `${endpoint}${diagTag} failed: ${shortenErrorMessage(lastError)}`);
      }
    }
  }

  throw lastError || new Error("Overpass request failed");
}

async function fetchBoundaryGeoJson(park) {
  const mode = arguments.length > 1 && arguments[1] ? arguments[1] : "full";
  const fastMode = mode === "fast";
  const diag = arguments.length > 2 && typeof arguments[2] === "function" ? arguments[2] : null;
  const requestOptions = {
    timeoutMs: fastMode ? OVERPASS_TIMEOUT_MS_PREFETCH : OVERPASS_TIMEOUT_MS_INTERACTIVE,
    diag,
  };
  if (diag) {
    diag("info", `fetchBoundaryGeoJson mode=${mode} name="${park.name}"`);
  }
  if (fastMode && isLikelyNonPolygonPark(park)) {
    if (diag) {
      diag("info", "Fast mode skip: likely non-polygon trail/parkway.");
    }
    return null;
  }
  if (isRiverPark(park)) {
    if (fastMode) {
      if (diag) {
        diag("info", "Fast mode skip: river-park path disabled in fast mode.");
      }
      return null;
    }
    const variants = riverNameVariants(park.name).slice(0, 6);
    const radii = [50000, 140000, 260000];
    const riverFeatures = [];

    for (const radius of radii) {
      for (const variant of variants) {
        try {
          const payload = await overpassRequest(
            buildRiverExactNameQuery(park, radius, variant),
            { ...requestOptions, diagTag: `river radius=${radius} variant="${variant}"` },
          );
          const geo = osmtogeojson(payload);
          const scored = extractFeaturesByMode(geo, "river")
            .map((f) => {
              const candidateName = f.properties?.name || "";
              const similarity = nameSimilarityScore(park.name, candidateName);
              return { feature: f, similarity, candidateName };
            })
            .filter((x) => x.similarity >= 0.5)
            .sort((a, b) => b.similarity - a.similarity)
            .map((x) => ({
              ...x.feature,
              properties: {
                ...(x.feature.properties || {}),
                _potaMatchNote: `${park.reference} ${park.name}... found match ${x.candidateName}`,
                _potaSimilarity: x.similarity,
              },
            }));
          if (scored.length) {
            riverFeatures.push(...scored);
          }
        } catch (err) {
          if (diag) {
            diag("warn", `River candidate failed radius=${radius} variant="${variant}": ${shortenErrorMessage(err)}`);
          }
          // Continue trying additional names/radii/endpoints for resilience.
        }
      }
      if (riverFeatures.length) {
        break;
      }
    }

    if (!riverFeatures.length) {
      if (diag) {
        diag("warn", "River mode returned no matching features.");
      }
      return null;
    }

    const ranked = Array.from(riverFeatures)
      .map((f) => {
        const center = featureCenter(f);
        const distance = center
          ? distanceKm(park.lat, park.lon, center[0], center[1])
          : Number.POSITIVE_INFINITY;
        const similarity = Number(f.properties?._potaSimilarity || 0);
        const similarityBonus = similarity > 0 ? -100 * similarity : 0;
        const lineBonus = (f.geometry?.type === "LineString" || f.geometry?.type === "MultiLineString") ? -20 : 0;
        return { feature: f, score: distance + similarityBonus + lineBonus };
      })
      .sort((a, b) => a.score - b.score);

    return {
      type: "FeatureCollection",
      features: ranked.slice(0, 20).map((x) => x.feature),
    };
  }

  const [primaryRadius, secondaryRadius] = getSearchRadii(park, mode);
  const stagedQueries = [
    { radius: primaryRadius, includeRelations: true, includeWays: false, tag: `exact relation radius=${primaryRadius}` },
    { radius: primaryRadius, includeRelations: false, includeWays: true, tag: `exact way radius=${primaryRadius}` },
    { radius: secondaryRadius, includeRelations: true, includeWays: false, tag: `exact relation radius=${secondaryRadius}` },
    { radius: secondaryRadius, includeRelations: false, includeWays: true, tag: `exact way radius=${secondaryRadius}` },
  ];

  let geo = null;
  let features = [];
  for (const stage of stagedQueries) {
    try {
      const payload = await overpassRequest(
        buildOverpassQuery(park, stage.radius, {
          includeRelations: stage.includeRelations,
          includeWays: stage.includeWays,
        }),
        { ...requestOptions, diagTag: stage.tag },
      );
      geo = osmtogeojson(payload);
      features = extractFeaturesByMode(geo, "protected");
      if (diag) {
        diag("info", `${stage.tag} returned ${features.length} polygon candidate(s).`);
      }
      if (features.length) {
        break;
      }
    } catch (err) {
      if (diag) {
        diag("warn", `${stage.tag} stage failed: ${shortenErrorMessage(err)}`);
      }
    }
  }

  // If exact name matching fails, look for nearby protected boundaries with similar names.
  if (!features.length && !fastMode) {
    const broadRadius = Math.max(secondaryRadius, 120000);
    const broad = await overpassRequest(
      buildOverpassBroadQuery(park, broadRadius),
      { ...requestOptions, diagTag: `broad radius=${broadRadius}` },
    );
    geo = osmtogeojson(broad);
    const candidates = extractFeaturesByMode(geo, "protected")
      .map((f) => {
        const candidateName = f.properties?.name || "";
        const similarity = nameSimilarityScore(park.name, candidateName);
        return { feature: f, similarity, candidateName };
      })
      .filter((x) => x.similarity >= 0.55)
      .sort((a, b) => b.similarity - a.similarity);

    if (candidates.length) {
      features = candidates.slice(0, 20).map((x) => {
        const note = `${park.reference} ${park.name}... found match ${x.candidateName}`;
        return {
          ...x.feature,
          properties: {
            ...(x.feature.properties || {}),
            _potaMatchNote: note,
            _potaSimilarity: x.similarity,
          },
        };
      });
      if (diag) {
        diag("info", `Broad similarity fallback accepted ${features.length} candidate(s).`);
      }
    }
  }

  if (!features.length) {
    if (diag) {
      diag("warn", "No polygon features after all query stages.");
    }
    return null;
  }

  const unique = new Map();
  for (const f of features) {
    const id = f.id || `${f.properties?.["@type"] || "obj"}-${f.properties?.["@id"] || Math.random()}`;
    if (!unique.has(id)) {
      unique.set(id, f);
    }
  }

  const scored = Array.from(unique.values())
    .map((f) => {
      const center = featureCenter(f);
      const distance = center
        ? distanceKm(park.lat, park.lon, center[0], center[1])
        : Number.POSITIVE_INFINITY;
      const boundary = f.properties?.boundary || "";
      const tagBonus = boundary === "protected_area" || boundary === "national_park" ? -50 : 0;
      const relationBonus = String(f.id || "").startsWith("relation/") ? -25 : 0;
      const similarity = Number(f.properties?._potaSimilarity || 0);
      const similarityBonus = similarity > 0 ? -100 * similarity : 0;
      return { feature: f, score: distance + tagBonus + relationBonus + similarityBonus };
    })
    .sort((a, b) => a.score - b.score);

  return {
    type: "FeatureCollection",
    features: scored.slice(0, 12).map((x) => x.feature),
  };
}

function locationStates(park) {
  return String(park.location || "")
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.startsWith("US-"));
}

function normalizeStateCode(raw) {
  const value = String(raw || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) {
    return null;
  }
  return value;
}

function parkHasState(park, stateCode) {
  return locationStates(park).includes(`US-${stateCode}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBoundaryWithCache(park) {
  const options = arguments.length > 1 && arguments[1] ? arguments[1] : {};
  const mode = options.mode || "full";
  const cacheMissResult = options.cacheMissResult !== false;
  const diag = typeof options.diag === "function" ? options.diag : null;

  if (boundaryCache.has(park.reference)) {
    if (diag) {
      diag("info", `Memory cache hit for ${park.reference}.`);
    }
    return { geojson: boundaryCache.get(park.reference), source: "cache" };
  }
  if (noBoundaryCache.has(park.reference)) {
    if (diag) {
      diag("info", `Memory no-boundary cache hit for ${park.reference}.`);
    }
    return { geojson: null, source: "cache-none" };
  }

  if (!sessionIgnorePersistedCache) {
    if (diag) {
      diag("info", `Checking IndexedDB cache for ${park.reference}...`);
    }
    const persisted = await dbReadBoundary(park.reference);
    if (persisted) {
      if (persisted.geojson && persisted.geojson.features?.length) {
        boundaryCache.set(park.reference, persisted.geojson);
        if (diag) {
          diag("info", `IndexedDB cache hit with ${persisted.geojson.features.length} feature(s).`);
        }
        return { geojson: persisted.geojson, source: "cache" };
      }
      if (persisted.noBoundaryVersion === NO_BOUNDARY_CACHE_VERSION) {
        noBoundaryCache.add(park.reference);
        if (diag) {
          diag("info", "IndexedDB no-boundary cache hit.");
        }
        return { geojson: null, source: "cache-none" };
      }
    }
    if (diag) {
      diag("info", `IndexedDB miss for ${park.reference}; fetching from network.`);
    }
  }

  const geojson = await fetchBoundaryGeoJson(park, mode, diag);
  if (geojson && geojson.features?.length) {
    boundaryCache.set(park.reference, geojson);
    await dbWriteBoundary(park.reference, geojson);
    if (diag) {
      diag("info", `Network lookup success; cached ${geojson.features.length} feature(s).`);
    }
  } else if (cacheMissResult) {
    noBoundaryCache.add(park.reference);
    await dbWriteBoundary(park.reference, null);
    if (diag) {
      diag("info", "Network lookup returned no boundary; stored no-boundary cache entry.");
    }
  } else if (diag) {
    diag("info", "Network lookup returned no boundary; no-boundary result not persisted (fast mode).");
  }
  return { geojson, source: "network" };
}

async function loadBoundary() {
  if (!currentPark) {
    return;
  }

  startBoundaryDiagnostics(currentPark);
  appendBoundaryDiag("info", "UI action: Load Boundary clicked.");
  setStatus("Fetching boundary polygons from OpenStreetMap/Overpass...");
  loadBoundaryBtn.disabled = true;

  try {
    const { geojson, source } = await getBoundaryWithCache(currentPark, {
      mode: "full",
      cacheMissResult: true,
      diag: appendBoundaryDiag,
    });
    clearBoundary();

    if (!geojson || !geojson.features?.length) {
      appendBoundaryDiag("warn", "Completed with no boundary features.");
      setStatus("No boundary polygon found for this park name. Point marker shown only.");
      updateButtons();
      return;
    }

    boundaryLayer = L.geoJSON(geojson, {
      style: (feature) => {
        const gtype = feature?.geometry?.type || "";
        const isLine = gtype === "LineString" || gtype === "MultiLineString";
        if (isLine) {
          return {
            color: "#0e6f50",
            weight: 4,
            opacity: 0.9,
            className: "boundary-line",
          };
        }
        return {
          color: "#0e6f50",
          weight: 2,
          fillColor: "#1fa477",
          fillOpacity: 0.24,
          className: "boundary-polygon",
        };
      },
      onEachFeature: (feature, layer) => {
        const name = feature.properties?.name || currentPark.name;
        const id = feature.id || "OSM feature";
        const note = feature.properties?._potaMatchNote
          ? `<br><em>${escapeHtml(feature.properties._potaMatchNote)}</em>`
          : "";
        layer.bindPopup(`<strong>${escapeHtml(name)}</strong><br>${escapeHtml(id)}${note}`);
      },
    }).addTo(map);

    map.fitBounds(boundaryLayer.getBounds(), { padding: [20, 20] });
    const sourceLabel = source === "cache" ? "cache" : "network";
    appendBoundaryDiag("info", `Completed successfully from ${sourceLabel}; featureCount=${geojson.features.length}`);
    setStatus(`Loaded ${geojson.features.length} boundary feature(s) (${sourceLabel}).`);
  } catch (error) {
    console.error(error);
    appendBoundaryDiag("error", `Boundary lookup failed: ${shortenErrorMessage(error)}`);
    setStatus("Boundary lookup failed. Open \"View Boundary Diagnostics\" and copy the log.");
  } finally {
    loadBoundaryBtn.disabled = false;
    updateButtons();
  }
}

async function prefetchStateBoundaries() {
  if (!parks.length) {
    setPrefetchStatus("Park index not loaded yet. Loading now...");
    await loadParkIndex();
    if (!parks.length) {
      setPrefetchStatus("Park index is unavailable; cannot warm state cache yet.");
      return;
    }
  }

  const stateCode = normalizeStateCode(stateCodeInputEl.value);
  if (!stateCode) {
    setPrefetchStatus("Enter a 2-letter state code (for example: CO).");
    return;
  }

  const parksInState = parks.filter((park) => parkHasState(park, stateCode));
  if (!parksInState.length) {
    setPrefetchStatus(`No parks found for US-${stateCode}.`);
    return;
  }

  isPrefetching = true;
  updateButtons();

  let cachedCount = 0;
  let fetchedCount = 0;
  let missingCount = 0;
  let failedCount = 0;

  try {
    setPrefetchStatus(`Warming cache for US-${stateCode}: 0/${parksInState.length}`);

    for (let i = 0; i < parksInState.length; i += 1) {
      const park = parksInState[i];
      let requestSource = null;
      try {
        const { geojson, source } = await getBoundaryWithCache(park, {
          mode: "fast",
          cacheMissResult: false,
        });
        requestSource = source;
        if (source === "cache" || source === "cache-none") {
          cachedCount += 1;
        } else if (geojson?.features?.length) {
          fetchedCount += 1;
        } else {
          missingCount += 1;
          appendIssueLogEntry({
            timestamp: Date.now(),
            state: `US-${stateCode}`,
            reference: park.reference,
            name: park.name,
            status: "no-boundary",
            error: "",
          });
        }
      } catch (err) {
        console.error(err);
        failedCount += 1;
        appendIssueLogEntry({
          timestamp: Date.now(),
          state: `US-${stateCode}`,
          reference: park.reference,
          name: park.name,
          status: "failed",
          error: err?.message || String(err),
        });
      }

      setPrefetchStatus(
        `US-${stateCode}: ${i + 1}/${parksInState.length} ` +
        `(from cache ${cachedCount}, fetched ${fetchedCount}, no-boundary ${missingCount}, failed ${failedCount})`,
      );

      // Respect Overpass capacity when we are making new requests in bulk.
      if (requestSource === "network") {
        await sleep(75);
      }
    }
  } finally {
    isPrefetching = false;
    updateButtons();
  }
}

async function loadParkIndex() {
  try {
    const parkIndexUrl = new URL("data/us-parks.json", window.location.href);
    parkIndexUrl.searchParams.set("_ts", Date.now().toString());
    const response = await fetch(parkIndexUrl.toString(), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Park index HTTP ${response.status}`);
    }
    parks = await response.json();
    parks.sort((a, b) => (a.reference < b.reference ? -1 : 1));
    setStatus(`Loaded ${parks.length.toLocaleString()} U.S. active POTA parks.`);
    setPrefetchStatus("Tip: enter a state code and warm the boundary cache (saved for future reloads).");
    updateButtons();
    openBoundaryDb();
    loadBundledBoundariesFile();

    const initialRef = (location.hash || "").replace("#", "").toUpperCase();
    if (initialRef) {
      const park = parks.find((p) => p.reference === initialRef);
      if (park) {
        setCurrentPark(park);
        searchEl.value = `${park.reference} ${park.name}`;
      }
    }
  } catch (error) {
    console.error(error);
    setStatus("Could not load local park index. Run scripts/update_us_parks.ps1 and reload.");
  }
}

searchEl.addEventListener("input", onSearchInput);
searchEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const matches = findMatches(searchEl.value);
    if (matches.length) {
      setCurrentPark(matches[0]);
      renderResults([]);
      searchEl.value = `${matches[0].reference} ${matches[0].name}`;
      location.hash = matches[0].reference;
    }
  }
});

loadBoundaryBtn.addEventListener("click", loadBoundary);
clearBoundaryBtn.addEventListener("click", () => {
  clearBoundary();
  setStatus("Boundary cleared.");
});
prefetchStateBtn.addEventListener("click", prefetchStateBoundaries);
toggleIssueLogBtn.addEventListener("click", toggleIssueLog);
clearIssueLogBtn.addEventListener("click", clearIssueLog);
exportIssueLogBtn.addEventListener("click", exportIssueLog);
exportBoundaryBundleBtn.addEventListener("click", exportBoundaryBundle);
importBoundaryBundleBtn.addEventListener("click", () => importBoundaryFileInput.click());
importBoundaryFileInput.addEventListener("change", () => {
  const file = importBoundaryFileInput.files?.[0];
  importBoundaryBundleFromFile(file);
});
clearSessionCacheBtn.addEventListener("click", clearSessionCache);
toggleDiagBtn.addEventListener("click", toggleBoundaryDiagnostics);
copyDiagBtn.addEventListener("click", copyBoundaryDiagnostics);
clearDiagBtn.addEventListener("click", clearBoundaryDiagnostics);
stateCodeInputEl.addEventListener("input", () => {
  stateCodeInputEl.value = stateCodeInputEl.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
});
stateCodeInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    prefetchStateBoundaries();
  }
});

loadIssueLog();
renderIssueLog();
renderBoundaryDiagnostics();
loadParkIndex();

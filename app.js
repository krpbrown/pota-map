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
const issueLogSummaryEl = document.getElementById("issueLogSummary");
const issueLogOutputEl = document.getElementById("issueLogOutput");

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
let issueLog = [];

function setStatus(message) {
  statusEl.textContent = message;
}

function setPrefetchStatus(message) {
  prefetchStatusEl.textContent = message;
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
  return null;
}

function normalizeForNameMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/\bnational wildlife refuge\b/g, " ")
    .replace(/\bnational wild and scenic river\b/g, " ")
    .replace(/\bwild and scenic river\b/g, " ")
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

  // Prefer strong token overlap when one name is a superset of the other.
  return intersection / Math.min(ta.size, tb.size);
}

function buildOverpassQuery(park, radiusMeters) {
  const name = park.name.replaceAll('"', '\\"');
  return `
[out:json][timeout:45];
(
  relation(around:${radiusMeters},${park.lat},${park.lon})["name"="${name}"]["boundary"~"protected_area|national_park"];
  relation(around:${radiusMeters},${park.lat},${park.lon})["name"="${name}"]["leisure"="nature_reserve"];
  relation(around:${radiusMeters},${park.lat},${park.lon})["name"="${name}"]["type"="boundary"];
  way(around:${radiusMeters},${park.lat},${park.lon})["name"="${name}"]["boundary"~"protected_area|national_park"];
  way(around:${radiusMeters},${park.lat},${park.lon})["name"="${name}"]["leisure"="nature_reserve"];
);
out body;
>;
out skel qt;
`.trim();
}

function buildOverpassBroadQuery(park, radiusMeters) {
  return `
[out:json][timeout:60];
(
  relation(around:${radiusMeters},${park.lat},${park.lon})["boundary"~"protected_area|national_park"];
  relation(around:${radiusMeters},${park.lat},${park.lon})["leisure"="nature_reserve"];
  way(around:${radiusMeters},${park.lat},${park.lon})["boundary"~"protected_area|national_park"];
  way(around:${radiusMeters},${park.lat},${park.lon})["leisure"="nature_reserve"];
);
out body;
>;
out skel qt;
`.trim();
}

function extractPolygonFeatures(geo) {
  return (geo.features || []).filter(
    (f) => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"),
  );
}

async function overpassRequest(query) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  const body = `data=${encodeURIComponent(query)}`;

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body,
      });
      if (!response.ok) {
        throw new Error(`${endpoint} returned ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Overpass request failed");
}

async function fetchBoundaryGeoJson(park) {
  const radius = park.name.includes("National Forest") ? 350000 : 120000;
  const first = await overpassRequest(buildOverpassQuery(park, radius));

  let geo = osmtogeojson(first);
  let features = extractPolygonFeatures(geo);

  if (!features.length) {
    const fallback = await overpassRequest(buildOverpassQuery(park, 450000));
    geo = osmtogeojson(fallback);
    features = extractPolygonFeatures(geo);
  }

  // If exact name matching fails, look for nearby protected boundaries with similar names.
  if (!features.length) {
    const broad = await overpassRequest(buildOverpassBroadQuery(park, 180000));
    geo = osmtogeojson(broad);
    const candidates = extractPolygonFeatures(geo)
      .map((f) => {
        const candidateName = f.properties?.name || "";
        const similarity = nameSimilarityScore(park.name, candidateName);
        return { feature: f, similarity, candidateName };
      })
      .filter((x) => x.similarity >= 0.45)
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
    }
  }

  if (!features.length) {
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
  if (boundaryCache.has(park.reference)) {
    return { geojson: boundaryCache.get(park.reference), source: "cache" };
  }
  if (noBoundaryCache.has(park.reference)) {
    return { geojson: null, source: "cache-none" };
  }

  const persisted = await dbReadBoundary(park.reference);
  if (persisted) {
    if (persisted.geojson && persisted.geojson.features?.length) {
      boundaryCache.set(park.reference, persisted.geojson);
      return { geojson: persisted.geojson, source: "cache" };
    }
    if (persisted.noBoundaryVersion === NO_BOUNDARY_CACHE_VERSION) {
      noBoundaryCache.add(park.reference);
      return { geojson: null, source: "cache-none" };
    }
  }

  const geojson = await fetchBoundaryGeoJson(park);
  if (geojson && geojson.features?.length) {
    boundaryCache.set(park.reference, geojson);
    await dbWriteBoundary(park.reference, geojson);
  } else {
    noBoundaryCache.add(park.reference);
    await dbWriteBoundary(park.reference, null);
  }
  return { geojson, source: "network" };
}

async function loadBoundary() {
  if (!currentPark) {
    return;
  }

  setStatus("Fetching boundary polygons from OpenStreetMap/Overpass...");
  loadBoundaryBtn.disabled = true;

  try {
    const { geojson, source } = await getBoundaryWithCache(currentPark);
    clearBoundary();

    if (!geojson || !geojson.features?.length) {
      setStatus("No boundary polygon found for this park name. Point marker shown only.");
      updateButtons();
      return;
    }

    boundaryLayer = L.geoJSON(geojson, {
      style: {
        color: "#0e6f50",
        weight: 2,
        fillColor: "#1fa477",
        fillOpacity: 0.22,
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
    setStatus(`Loaded ${geojson.features.length} boundary feature(s) (${sourceLabel}).`);
  } catch (error) {
    console.error(error);
    setStatus("Boundary lookup failed. Try again in a moment or choose another park.");
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
        const { geojson, source } = await getBoundaryWithCache(park);
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
        await sleep(250);
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
loadParkIndex();

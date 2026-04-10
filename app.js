const statusEl = document.getElementById("status");
const detailsEl = document.getElementById("details");
const searchEl = document.getElementById("parkSearch");
const resultsEl = document.getElementById("results");
const loadBoundaryBtn = document.getElementById("loadBoundaryBtn");
const clearBoundaryBtn = document.getElementById("clearBoundaryBtn");
const stateCodeInputEl = document.getElementById("stateCodeInput");
const prefetchStateBtn = document.getElementById("prefetchStateBtn");
const prefetchStatusEl = document.getElementById("prefetchStatus");

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

const map = L.map("map").setView([39.5, -98.35], 4);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

let parks = [];
let currentPark = null;
let pointMarker = null;
let boundaryLayer = null;
const boundaryCache = new Map();
const noBoundaryCache = new Set();
let isPrefetching = false;

function setStatus(message) {
  statusEl.textContent = message;
}

function setPrefetchStatus(message) {
  prefetchStatusEl.textContent = message;
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
  prefetchStateBtn.disabled = isPrefetching || !parks.length;
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
    ${park.lat.toFixed(4)}, ${park.lon.toFixed(4)} (${escapeHtml(park.grid || "n/a")})
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
      renderResults(matches);
      searchEl.value = `${park.reference} ${park.name}`;
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
  let features = (geo.features || []).filter(
    (f) => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"),
  );

  if (!features.length) {
    const fallback = await overpassRequest(buildOverpassQuery(park, 450000));
    geo = osmtogeojson(fallback);
    features = (geo.features || []).filter(
      (f) => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"),
    );
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
      return { feature: f, score: distance + tagBonus + relationBonus };
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

  const geojson = await fetchBoundaryGeoJson(park);
  if (geojson && geojson.features?.length) {
    boundaryCache.set(park.reference, geojson);
  } else {
    noBoundaryCache.add(park.reference);
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
        layer.bindPopup(`<strong>${escapeHtml(name)}</strong><br>${escapeHtml(id)}`);
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
        }
      } catch (err) {
        console.error(err);
        failedCount += 1;
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
    setPrefetchStatus("Tip: enter a state code and warm the boundary cache.");
    updateButtons();

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
      renderResults(matches);
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
stateCodeInputEl.addEventListener("input", () => {
  stateCodeInputEl.value = stateCodeInputEl.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
});
stateCodeInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    prefetchStateBoundaries();
  }
});

loadParkIndex();

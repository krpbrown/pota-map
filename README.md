# POTA USA Boundary Map

Static web app (GitHub Pages ready) to:
- search active U.S. POTA parks
- center on the park reference point
- fetch and draw park boundary polygons (when available) from OpenStreetMap/Overpass

## Why This Approach

The public POTA map API exposes point/grid data, not official boundary polygons.  
This app keeps a local U.S. park index from POTA and overlays boundaries from OSM data sources.

## Quick Start

1. Open `index.html` in a browser, or host this repo with GitHub Pages.
2. Search by reference (`US-3062`) or name (`Antelope Island`).
3. Click **Load Boundary**.

## Refresh Park Data

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\update_us_parks.ps1
```

This updates [`data/us-parks.json`](data/us-parks.json) from:
- `https://pota.app/all_parks_ext.csv`

## Notes

- Boundary quality depends on OSM coverage and naming consistency.
- Some references may return no polygon or multiple polygons.
- Dispersed parks (like many national forests) can return multiple separated geometry parts.

## Ship Local Boundary Bundle (Fast Startup)

You can build and ship a local boundary bundle so runtime cache warming is minimal.

### Option A: Scripted bulk build (recommended)

Install script dependencies once:

```powershell
python -m pip install requests osm2geojson
```

Build for specific states:

```bash
python ./scripts/build_boundary_bundle.py --states UT CO AZ
```

Build for all parks:

```bash
python ./scripts/build_boundary_bundle.py --all
```

The script writes directly to `data/us-boundaries.json` (resume-friendly if rerun).
Boundary issues are logged to `data/us-boundary-issues.jsonl` by default (no-boundary, failed, and similar-name fallback notes).

### Option B: In-browser export/import

- Use **Warm State Cache** and click **Export Boundaries**.
- Later, use **Import Boundaries** to load that bundle.
- Use **Export Log** to investigate `no-boundary` and `failed` entries.

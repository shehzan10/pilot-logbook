# Pilot Logbook

A 3D logbook of my flight training, built with [CesiumJS](https://cesium.com/platform/cesiumjs/) on Google Photorealistic 3D Tiles. Each lesson card shows the aircraft (tail number) flown.

- Replays each lesson from ADS-B tracks stored as Cesium ion assets
- Cessna 172S 3D model with pitch/bank derived from the track
- Logbook stats, progress toward the 40-hour PPL minimum, per-lesson notes
- Overview, chase, and orbit cameras with an altitude/speed chart

## Configuration

Edit `config.js`:

| Key | Purpose |
|---|---|
| `ionAccessToken` | Cesium ion token (restrict its allowed URLs to the hosting domain) |
| `flightAssetIds` | ion asset IDs of the KML flight tracks, named `<tail number> - YYYY-MM-DD` |
| `aircraftModelAssetId` | ion asset ID of the aircraft glTF model |
| `pplTargetHours` | Hours goal for the progress bar |

## Run locally

```sh
node serve.mjs   # http://localhost:8080
```

It's a static site, so it can be hosted on GitHub Pages as-is.

## Credits

"Cessna172" (https://skfb.ly/oYXVT) by KOG_THORNS, licensed under [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/).

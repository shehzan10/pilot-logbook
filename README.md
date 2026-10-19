# Pilot Logbook

3D Logbook of my PPL flight training, built with [Cesium](https://cesium.com/).

![Pilot Logbook replaying a lesson over Google Photorealistic 3D Tiles](docs/screenshot.jpg)

- Each lesson card shows the aircraft (tail number) flown.
- Replays each lesson from ADS-B tracks stored as Cesium ion assets
- Cessna 172S 3D model with pitch/bank derived from the track
- Overview, chase, and orbit cameras with an altitude/speed chart
- Place search powered by the Cesium ion geocoder (Google)
- Compass with one-tap north-up
- Layers: Google Photorealistic 3D Tiles or Cesium World Terrain, with Google Maps 2D overlays (labels, roadmap, satellite)

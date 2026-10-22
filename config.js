// App configuration.
// The Cesium ion access token can also be supplied via ?token=... in the URL
// or entered in the in-app prompt (it is then stored in localStorage).
window.APP_CONFIG = {
  ionAccessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6Im5BWDRSOGRvTy1NVWlzMTUiLCJqdGkiOiI4MGZiOTMzZS1mYTdhLTQ4MDktOTUxMy0yMjU1MGE5MTVhZTEiLCJpZCI6NTI5NDg4LCJzdWIiOiJ6c21vaGFtbWVkLXBlcnNvbmFsIiwiaXNzIjoiaHR0cHM6Ly9hcGkuY2VzaXVtLmNvbSIsImF1ZCI6IlBpbG90IExvZ2Jvb2sgKHB1YmxpYywgR2l0SHViIFBhZ2VzKSIsImlhdCI6MTc5MjY0MjM0Mn0.qK04EgjFg7f0EmpSnJ4OFp8GHQ40raX7Qv633YLhkDY",
  // Flight assets (KML ADS-B tracks), named "<tail number> - YYYY-MM-DD", e.g.
  // "N16237 - 2026-10-14". The tail number and date are read from the name.
  // If the token has the assets:list scope, matching KML assets are also auto-discovered.
  flightAssetIds: [6049767, 6049768, 6049769, 6049770, 6065426],
  // Cessna Skyhawk 172S glTF model (ion asset) flown along the selected track.
  aircraftModelAssetId: 6064799,
  // Extra yaw (degrees) if the model's nose doesn't point along the track.
  aircraftModelHeadingOffset: 0,
  // FAA minimum total flight time for a Private Pilot certificate (14 CFR 61.109).
  pplTargetHours: 40,
};

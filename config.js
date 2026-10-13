// App configuration.
// The Cesium ion access token can also be supplied via ?token=... in the URL
// or entered in the in-app prompt (it is then stored in localStorage).
window.APP_CONFIG = {
  ionAccessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IllWdVpMd3FoN1A4aWFtTUUiLCJqdGkiOiJkMzdmNjE0OS05NmIzLTQ5MjctODBmZC0yNzBmY2M3NmMxODkiLCJpZCI6NjksInN1YiI6InpzbW9oYW1tZWQiLCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoiRmxpZ2h0IEFwcCIsImlhdCI6MTc5MTkyMDc4Mn0.TRD0zc4sow05ubCqewkp8dkzjj1EhRKUA4NRGWqXgS4",
  tailNumber: "N16237",
  // Known flight assets (KML ADS-B tracks). Assets whose names start with the
  // tail number are also auto-discovered if the token has the assets:list scope.
  flightAssetIds: [6026562, 6022716],
  // Cessna Skyhawk 172S glTF model (ion asset) flown along the selected track.
  aircraftModelAssetId: 6026603,
  // Extra yaw (degrees) if the model's nose doesn't point along the track.
  aircraftModelHeadingOffset: 0,
  // FAA minimum total flight time for a Private Pilot certificate (14 CFR 61.109).
  pplTargetHours: 40,
};

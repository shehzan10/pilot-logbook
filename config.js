// App configuration.
// The Cesium ion access token can also be supplied via ?token=... in the URL
// or entered in the in-app prompt (it is then stored in localStorage).
window.APP_CONFIG = {
  ionAccessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IkZPTUJIME9nV0JwM0lqWDIiLCJqdGkiOiJkMzdmNjE0OS05NmIzLTQ5MjctODBmZC0yNzBmY2M3NmMxODkiLCJpZCI6NjksInN1YiI6InpzbW9oYW1tZWQiLCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoiUGlsb3QgTG9nYm9vayAtIGh0dHBzOi8vc2hlaHphbjEwLmdpdGh1Yi5pby9waWxvdC1sb2dib29rIiwiaWF0IjoxNzkxOTk2MDYyfQ.73ZR212lVKl8TdCUaoxjJ6OxRVSlaEKkTfrsRWgE-uA",
  tailNumber: "N16237",
  // Known flight assets (KML ADS-B tracks). Assets whose names start with the
  // tail number are also auto-discovered if the token has the assets:list scope.
  flightAssetIds: [6026562, 6022716, 6032961],
  // Cessna Skyhawk 172S glTF model (ion asset) flown along the selected track.
  aircraftModelAssetId: 6026603,
  // Extra yaw (degrees) if the model's nose doesn't point along the track.
  aircraftModelHeadingOffset: 0,
  // FAA minimum total flight time for a Private Pilot certificate (14 CFR 61.109).
  pplTargetHours: 40,
};

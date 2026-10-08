// Where am I. Inside the Tauri app this goes through the geolocation plugin
// (Android's WebView doesn't grant navigator.geolocation on its own); in a
// plain browser it falls back to the web API. The position is only used to
// move the map: it is never written anywhere.

export async function locate(): Promise<{ lat: number; lng: number }> {
  if ("__TAURI_INTERNALS__" in window) {
    const geo = await import("@tauri-apps/plugin-geolocation");
    let perms = await geo.checkPermissions();
    if (perms.location !== "granted") perms = await geo.requestPermissions(["location"]);
    if (perms.location !== "granted") throw new Error("Location permission denied");
    const pos = await geo.getCurrentPosition({ enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  }
  if (!navigator.geolocation) throw new Error("Location isn't available here");
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(new Error(e.message || "Couldn't get location")),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    ),
  );
}

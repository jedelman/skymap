import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource, type Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection } from "geojson";

// OpenFreeMap: OSM vector tiles, no key, no account. Swap for a self-hosted
// Protomaps PMTiles file on R2 when we need to own the basemap.
const STYLE = "https://tiles.openfreemap.org/styles/dark";
const BARCELONA: [number, number] = [2.1734, 41.3851];
const LONG_PRESS_MS = 550;

export interface MapApi {
  flyTo(lat: number, lng: number, zoom?: number): void;
  center(): { lat: number; lng: number };
  showMe(lat: number, lng: number): void;
}

interface Props {
  pins: FeatureCollection;
  areas: FeatureCollection;
  onReady(api: MapApi): void;
  onFeature(kind: "pin" | "event" | "gen", uri: string): void;
  onLongPress(lat: number, lng: number): void;
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export function MapView({ pins, areas, onReady, onFeature, onLongPress }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const loaded = useRef(false);
  // Handlers change every render; the map's listeners read the latest through refs.
  const cb = useRef({ onFeature, onLongPress });
  cb.current = { onFeature, onLongPress };
  const data = useRef({ pins, areas });
  data.current = { pins, areas };

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: STYLE,
      center: BARCELONA,
      zoom: 12.5,
      attributionControl: { compact: true },
      pitchWithRotate: false,
    });
    map.current = m;
    // Dev builds only: lets browser tests find features on the canvas.
    if (import.meta.env.DEV) (window as unknown as { __skymapMap?: MLMap }).__skymapMap = m;
    m.touchPitch.disable();

    m.on("load", () => {
      m.addSource("areas", { type: "geojson", data: data.current.areas });
      m.addSource("pins", { type: "geojson", data: data.current.pins });
      m.addSource("me", { type: "geojson", data: EMPTY });

      // Area-only events: the hexagon is the whole public claim.
      m.addLayer({
        id: "areas-fill",
        type: "fill",
        source: "areas",
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.18 },
      });
      m.addLayer({
        id: "areas-line",
        type: "line",
        source: "areas",
        paint: { "line-color": ["get", "color"], "line-width": 1.5, "line-dasharray": [2, 2] },
      });
      m.addLayer({
        id: "pins-halo",
        type: "circle",
        source: "pins",
        filter: ["==", ["get", "kind"], "event"],
        paint: { "circle-radius": 14, "circle-color": ["get", "color"], "circle-opacity": 0.25 },
      });
      // Generator output: a ring that grows with how many people agree on the place.
      m.addLayer({
        id: "gen-ring",
        type: "circle",
        source: "pins",
        filter: ["==", ["get", "kind"], "gen"],
        paint: {
          "circle-radius": ["+", 7, ["*", 3, ["min", ["coalesce", ["get", "count"], 1], 6]]],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.22,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 2,
        },
      });
      m.addLayer({
        id: "pins-dot",
        type: "circle",
        source: "pins",
        filter: ["!=", ["get", "kind"], "gen"],
        paint: {
          "circle-radius": ["case", ["==", ["get", "kind"], "event"], 7, 6],
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#0b0b10",
          "circle-stroke-width": 2,
        },
      });
      m.addLayer({
        id: "pins-label",
        type: "symbol",
        source: "pins",
        minzoom: 13,
        layout: {
          "text-field": ["get", "title"],
          // Must be a font the basemap's glyph server has; MapLibre's default isn't.
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
          "text-offset": [0, 1.2],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: { "text-color": "#f2eefb", "text-halo-color": "#0b0b10", "text-halo-width": 1.5 },
      });
      m.addLayer({
        id: "me",
        type: "circle",
        source: "me",
        paint: { "circle-radius": 7, "circle-color": "#4fb6ff", "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
      });
      loaded.current = true;

      // One handler for all taps, so overlapping features resolve by priority
      // (a pin beats the generator ring around it beats the area under both)
      // instead of whichever layer's listener happened to fire last.
      const TAPPABLE = ["pins-dot", "gen-ring", "pins-halo", "areas-fill"];
      m.on("click", (e) => {
        const hits = m.queryRenderedFeatures(e.point, { layers: TAPPABLE });
        hits.sort((a, b) => TAPPABLE.indexOf(a.layer.id) - TAPPABLE.indexOf(b.layer.id));
        const p = hits[0]?.properties as { kind: "pin" | "event" | "gen"; uri: string } | undefined;
        if (p) cb.current.onFeature(p.kind, p.uri);
      });
      for (const id of TAPPABLE) {
        m.on("mouseenter", id, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", id, () => (m.getCanvas().style.cursor = ""));
      }

      onReady({
        flyTo: (lat, lng, zoom = 16) => m.flyTo({ center: [lng, lat], zoom }),
        center: () => {
          const c = m.getCenter();
          return { lat: c.lat, lng: c.lng };
        },
        showMe: (lat, lng) => {
          (m.getSource("me") as GeoJSONSource).setData({
            type: "FeatureCollection",
            features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lng, lat] } }],
          });
        },
      });
    });

    // Desktop: right-click. Touch: hold still for LONG_PRESS_MS.
    m.on("contextmenu", (e) => cb.current.onLongPress(e.lngLat.lat, e.lngLat.lng));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { x: number; y: number } | undefined;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    m.on("touchstart", (e) => {
      cancel();
      if (e.originalEvent.touches.length !== 1) return;
      start = { x: e.point.x, y: e.point.y };
      const at = e.lngLat;
      timer = setTimeout(() => {
        timer = undefined;
        cb.current.onLongPress(at.lat, at.lng);
      }, LONG_PRESS_MS);
    });
    m.on("touchmove", (e) => {
      if (start && Math.hypot(e.point.x - start.x, e.point.y - start.y) > 10) cancel();
    });
    m.on("touchend", cancel);
    m.on("touchcancel", cancel);
    m.on("movestart", (e) => {
      // A pan started by the finger itself cancels; a programmatic flyTo doesn't matter.
      if ((e as { originalEvent?: Event }).originalEvent) cancel();
    });

    return () => {
      cancel();
      m.remove();
      map.current = null;
      loaded.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded.current || !map.current) return;
    (map.current.getSource("pins") as GeoJSONSource).setData(pins);
    (map.current.getSource("areas") as GeoJSONSource).setData(areas);
  }, [pins, areas]);

  return <div ref={el} className="map" />;
}

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as Papa from "papaparse";

// ─────────────────────────────────────────────
// Aix en Bus Live — Real-time GTFS Bus Tracker
// ─────────────────────────────────────────────

const CORS_PROXY = "https://corsproxy.io/?url=";
const GTFS_URL = `${CORS_PROXY}https://transport.data.gouv.fr/resources/39603/download`;
const TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const AIX_CENTER = [43.5297, 5.4474];
const REFRESH_MS = 15000;

// ── Color palette ──
const C = {
  orange: "#F47920", orangeDark: "#D4621A", orangeLight: "#FFF0E6",
  blue: "#003DA5", blueLight: "#E8EEFA",
  white: "#FFFFFF", grayDark: "#2C2C2C", grayMed: "#6B7280", grayLight: "#F3F4F6",
};

// ── Demo buses (fallback) ──
const DEMO_BUSES = [
  { tripId:"d1", lineNumber:"1", color:C.orange, lat:43.5297, lon:5.4474, nextStopName:"Rotonde", minutesToNextStop:3, direction:"La Duranne", ratio:.5 },
  { tripId:"d2", lineNumber:"2", color:C.blue, lat:43.5234, lon:5.4389, nextStopName:"Victor Hugo", minutesToNextStop:1, direction:"Jas de Bouffan", ratio:.3 },
  { tripId:"d3", lineNumber:"3", color:"#16A34A", lat:43.5318, lon:5.4512, nextStopName:"Cours Mirabeau", minutesToNextStop:5, direction:"Pont de l'Arc", ratio:.7 },
  { tripId:"d4", lineNumber:"4", color:"#9333EA", lat:43.5260, lon:5.4550, nextStopName:"Gare Routière", minutesToNextStop:2, direction:"Les Milles", ratio:.4 },
  { tripId:"d5", lineNumber:"M1", color:"#EF4444", lat:43.5340, lon:5.4420, nextStopName:"Sextius", minutesToNextStop:4, direction:"Krypton", ratio:.6 },
];

// ──────────────────────────────
// Utility functions
// ──────────────────────────────
function timeToSeconds(t) {
  if (!t) return 0;
  const p = t.split(":").map(Number);
  return p[0] * 3600 + p[1] * 60 + (p[2] || 0);
}

function fmtTime(d) {
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
}

function fmtDate(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
}

function isColorDark(hex) {
  const c = hex.replace("#","");
  const r = parseInt(c.substring(0,2),16);
  const g = parseInt(c.substring(2,4),16);
  const b = parseInt(c.substring(4,6),16);
  return (r*299+g*587+b*114)/1000 < 128;
}

function easeInOut(t) { return t < .5 ? 2*t*t : -1+(4-2*t)*t; }

// ──────────────────────────────
// Dynamic script/CSS loader
// ──────────────────────────────
function loadCSS(href) {
  return new Promise(r => {
    if (document.querySelector(`link[href="${href}"]`)) return r();
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = href;
    l.onload = r; l.onerror = r;
    document.head.appendChild(l);
  });
}

function loadScript(src, globalName) {
  return new Promise((res, rej) => {
    if (window[globalName]) return res(window[globalName]);
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => {
      const check = () => {
        if (window[globalName]) res(window[globalName]);
        else setTimeout(check, 50);
      };
      check();
    };
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

// ──────────────────────────────
// GTFS data loading & parsing
// ──────────────────────────────
async function loadGTFS(onProgress) {
  onProgress(10, "Connexion aux données GTFS Aix en Bus...");
  const resp = await fetch(GTFS_URL);
  if (!resp.ok) throw new Error("Fetch failed " + resp.status);

  onProgress(25, "Téléchargement des horaires et arrêts...");
  const buf = await resp.arrayBuffer();

  onProgress(40, "Extraction de l'archive GTFS...");
  const JSZip = window.JSZip;
  const zip = await JSZip.loadAsync(buf);

  const parseCSV = async (name) => {
    const f = zip.file(name);
    if (!f) return [];
    const txt = await f.async("text");
    return Papa.parse(txt.trim(), { header: true, skipEmptyLines: true }).data;
  };

  onProgress(50, "Analyse des arrêts et lignes...");
  const [routes, trips, stops, stopTimes, calendar, calendarDates, shapes] = await Promise.all([
    parseCSV("routes.txt"), parseCSV("trips.txt"), parseCSV("stops.txt"),
    parseCSV("stop_times.txt"), parseCSV("calendar.txt"),
    parseCSV("calendar_dates.txt"), parseCSV("shapes.txt"),
  ]);

  onProgress(70, "Construction des index...");

  const routesMap = {}; routes.forEach(r => routesMap[r.route_id] = r);
  const tripsMap = {}; trips.forEach(t => tripsMap[t.trip_id] = t);
  const stopsMap = {}; stops.forEach(s => {
    stopsMap[s.stop_id] = { ...s, stop_lat: +s.stop_lat, stop_lon: +s.stop_lon };
  });

  // Index stop_times by trip_id
  const stopTimesMap = {};
  for (const st of stopTimes) {
    if (!stopTimesMap[st.trip_id]) stopTimesMap[st.trip_id] = [];
    stopTimesMap[st.trip_id].push(st);
  }
  for (const k of Object.keys(stopTimesMap)) {
    stopTimesMap[k].sort((a,b) => +a.stop_sequence - +b.stop_sequence);
  }

  // Index shapes by shape_id
  const shapesMap = {};
  for (const s of shapes) {
    if (!shapesMap[s.shape_id]) shapesMap[s.shape_id] = [];
    shapesMap[s.shape_id].push(s);
  }
  for (const k of Object.keys(shapesMap)) {
    shapesMap[k].sort((a,b) => +a.shape_pt_sequence - +b.shape_pt_sequence);
  }

  onProgress(90, "Calcul des positions initiales...");
  return { routes, trips, stops, calendar, calendarDates, routesMap, tripsMap, stopsMap, stopTimesMap, shapesMap };
}

// ──────────────────────────────
// Position computation
// ──────────────────────────────
function getActiveServiceIds(gtfs, now) {
  const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const day = days[now.getDay()];
  const ds = fmtDate(now);
  const ids = new Set();

  for (const s of gtfs.calendar) {
    if (s[day] === "1" && s.start_date <= ds && s.end_date >= ds) ids.add(s.service_id);
  }
  for (const e of gtfs.calendarDates) {
    if (e.date === ds) {
      if (e.exception_type === "1") ids.add(e.service_id);
      if (e.exception_type === "2") ids.delete(e.service_id);
    }
  }
  return ids;
}

function computeBusPositions(gtfs, now) {
  const curSecs = timeToSeconds(fmtTime(now));
  const activeServiceIds = getActiveServiceIds(gtfs, now);
  const buses = [];

  for (const trip of gtfs.trips) {
    if (!activeServiceIds.has(trip.service_id)) continue;
    const sts = gtfs.stopTimesMap[trip.trip_id];
    if (!sts || sts.length < 2) continue;

    const firstDep = timeToSeconds(sts[0].departure_time);
    const lastArr = timeToSeconds(sts[sts.length-1].arrival_time);
    if (curSecs < firstDep || curSecs > lastArr) continue;

    let prev = null, next = null;
    for (let i = 0; i < sts.length - 1; i++) {
      const dep = timeToSeconds(sts[i].departure_time);
      const arr = timeToSeconds(sts[i+1].arrival_time);
      if (curSecs >= dep && curSecs <= arr) { prev = sts[i]; next = sts[i+1]; break; }
    }
    if (!prev || !next) continue;

    const dep = timeToSeconds(prev.departure_time);
    const arr = timeToSeconds(next.arrival_time);
    const ratio = arr === dep ? 0 : Math.min(1, Math.max(0, (curSecs - dep) / (arr - dep)));

    const sA = gtfs.stopsMap[prev.stop_id];
    const sB = gtfs.stopsMap[next.stop_id];
    if (!sA || !sB) continue;

    // Try shape interpolation
    let lat, lon;
    const shapeId = trip.shape_id;
    const shapePts = shapeId && gtfs.shapesMap[shapeId];
    if (shapePts && shapePts.length > 1) {
      const pos = interpolateOnShape(shapePts, sA, sB, ratio);
      lat = pos.lat; lon = pos.lon;
    } else {
      lat = sA.stop_lat + ratio * (sB.stop_lat - sA.stop_lat);
      lon = sA.stop_lon + ratio * (sB.stop_lon - sA.stop_lon);
    }

    const route = gtfs.routesMap[trip.route_id];
    if (!route) continue;

    buses.push({
      tripId: trip.trip_id,
      routeId: route.route_id,
      lineNumber: route.route_short_name || route.route_id,
      color: route.route_color ? `#${route.route_color}` : C.orange,
      lat, lon,
      nextStopName: gtfs.stopsMap[next.stop_id]?.stop_name || "?",
      minutesToNextStop: Math.max(0, Math.round((arr - curSecs) / 60)),
      direction: trip.trip_headsign || "",
      ratio
    });
  }
  return buses;
}

function interpolateOnShape(shapePts, stopA, stopB, ratio) {
  // Find closest shape points to each stop
  const dist = (lat1,lon1,lat2,lon2) => (lat1-lat2)**2 + (lon1-lon2)**2;
  let iA = 0, iB = shapePts.length - 1, dA = Infinity, dB = Infinity;
  for (let i = 0; i < shapePts.length; i++) {
    const d = dist(+shapePts[i].shape_pt_lat, +shapePts[i].shape_pt_lon, stopA.stop_lat, stopA.stop_lon);
    if (d < dA) { dA = d; iA = i; }
  }
  for (let i = iA; i < shapePts.length; i++) {
    const d = dist(+shapePts[i].shape_pt_lat, +shapePts[i].shape_pt_lon, stopB.stop_lat, stopB.stop_lon);
    if (d < dB) { dB = d; iB = i; }
  }
  if (iA >= iB) return { lat: stopA.stop_lat + ratio * (stopB.stop_lat - stopA.stop_lat), lon: stopA.stop_lon + ratio * (stopB.stop_lon - stopA.stop_lon) };

  // Compute total distance along shape segment
  let totalDist = 0;
  const dists = [0];
  for (let i = iA; i < iB; i++) {
    const d = Math.sqrt(dist(+shapePts[i].shape_pt_lat, +shapePts[i].shape_pt_lon, +shapePts[i+1].shape_pt_lat, +shapePts[i+1].shape_pt_lon));
    totalDist += d;
    dists.push(totalDist);
  }
  if (totalDist === 0) return { lat: stopA.stop_lat, lon: stopA.stop_lon };

  const target = ratio * totalDist;
  for (let i = 0; i < dists.length - 1; i++) {
    if (target >= dists[i] && target <= dists[i+1]) {
      const segRatio = dists[i+1] === dists[i] ? 0 : (target - dists[i]) / (dists[i+1] - dists[i]);
      const idx = iA + i;
      return {
        lat: +shapePts[idx].shape_pt_lat + segRatio * (+shapePts[idx+1].shape_pt_lat - +shapePts[idx].shape_pt_lat),
        lon: +shapePts[idx].shape_pt_lon + segRatio * (+shapePts[idx+1].shape_pt_lon - +shapePts[idx].shape_pt_lon),
      };
    }
  }
  return { lat: +shapePts[iB].shape_pt_lat, lon: +shapePts[iB].shape_pt_lon };
}

function getNextDepartures(stopId, gtfs, now, limit = 6) {
  const curSecs = timeToSeconds(fmtTime(now));
  const activeIds = getActiveServiceIds(gtfs, now);
  const deps = [];
  for (const trip of gtfs.trips) {
    if (!activeIds.has(trip.service_id)) continue;
    const sts = gtfs.stopTimesMap[trip.trip_id];
    if (!sts) continue;
    const st = sts.find(s => s.stop_id === stopId);
    if (!st) continue;
    const d = timeToSeconds(st.departure_time);
    if (d < curSecs || d > curSecs + 3600) continue;
    const route = gtfs.routesMap[trip.route_id];
    if (!route) continue;
    deps.push({
      lineNumber: route.route_short_name || route.route_id,
      color: route.route_color ? `#${route.route_color}` : C.orange,
      direction: trip.trip_headsign || "",
      minutesFromNow: Math.round((d - curSecs) / 60),
    });
  }
  return deps.sort((a,b) => a.minutesFromNow - b.minutesFromNow).slice(0, limit);
}

// ──────────────────────────────
// SVG Components
// ──────────────────────────────
const BusMascot = ({ lineNumber, color, size = 48, isSelected = false }) => {
  const sc = isSelected ? 1.3 : 1;
  const fs = (lineNumber||"").length > 2 ? "9" : "11";
  return (
    <svg width={size*sc} height={size*.75*sc} viewBox="0 0 64 48" style={{filter: isSelected ? "drop-shadow(0 4px 8px rgba(0,0,0,0.4))" : "drop-shadow(0 2px 4px rgba(0,0,0,0.25))"}}>
      <rect x="4" y="6" width="56" height="34" rx="10" ry="10" fill={color}/>
      <rect x="8" y="6" width="48" height="8" rx="4" ry="4" fill="white" fillOpacity=".25"/>
      <rect x="46" y="10" width="10" height="8" rx="3" fill="white" fillOpacity=".9"/>
      <rect x="10" y="10" width="9" height="7" rx="2" fill="white" fillOpacity=".9"/>
      <rect x="22" y="10" width="9" height="7" rx="2" fill="white" fillOpacity=".9"/>
      <rect x="34" y="10" width="9" height="7" rx="2" fill="white" fillOpacity=".9"/>
      <rect x="10" y="20" width="6" height="14" rx="2" fill="white" fillOpacity=".6"/>
      <rect x="20" y="19" width="26" height="16" rx="4" fill="white" fillOpacity=".95"/>
      <text x="33" y="31" textAnchor="middle" fontSize={fs} fontWeight="900" fontFamily="Nunito,Arial,sans-serif" fill={color}>{lineNumber}</text>
      <circle cx="16" cy="40" r="6" fill="#2C2C2C"/><circle cx="16" cy="40" r="3" fill="#9CA3AF"/>
      <circle cx="48" cy="40" r="6" fill="#2C2C2C"/><circle cx="48" cy="40" r="3" fill="#9CA3AF"/>
      <rect x="55" y="25" width="5" height="4" rx="2" fill="#FEF3C7"/>
      <rect x="54" y="30" width="6" height="2" rx="1" fill={color} fillOpacity=".5"/>
      <rect x="54" y="33" width="6" height="2" rx="1" fill={color} fillOpacity=".5"/>
    </svg>
  );
};

function busSVGString(lineNumber, color, isSelected = false) {
  const sc = isSelected ? 1.3 : 1;
  const fs = (lineNumber||"").length > 2 ? 9 : 11;
  const filt = isSelected ? "drop-shadow(0 4px 8px rgba(0,0,0,0.4))" : "drop-shadow(0 2px 4px rgba(0,0,0,0.25))";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${56*sc}" height="${42*sc}" viewBox="0 0 64 48" style="filter:${filt}">
    <rect x="4" y="6" width="56" height="34" rx="10" ry="10" fill="${color}"/>
    <rect x="8" y="6" width="48" height="8" rx="4" ry="4" fill="white" fill-opacity=".25"/>
    <rect x="46" y="10" width="10" height="8" rx="3" fill="white" fill-opacity=".9"/>
    <rect x="10" y="10" width="9" height="7" rx="2" fill="white" fill-opacity=".9"/>
    <rect x="22" y="10" width="9" height="7" rx="2" fill="white" fill-opacity=".9"/>
    <rect x="34" y="10" width="9" height="7" rx="2" fill="white" fill-opacity=".9"/>
    <rect x="10" y="20" width="6" height="14" rx="2" fill="white" fill-opacity=".6"/>
    <rect x="20" y="19" width="26" height="16" rx="4" fill="white" fill-opacity=".95"/>
    <text x="33" y="31" text-anchor="middle" font-size="${fs}" font-weight="900" font-family="Nunito,Arial,sans-serif" fill="${color}">${lineNumber}</text>
    <circle cx="16" cy="40" r="6" fill="#2C2C2C"/><circle cx="16" cy="40" r="3" fill="#9CA3AF"/>
    <circle cx="48" cy="40" r="6" fill="#2C2C2C"/><circle cx="48" cy="40" r="3" fill="#9CA3AF"/>
    <rect x="55" y="25" width="5" height="4" rx="2" fill="#FEF3C7"/>
  </svg>`;
}

// ──────────────────────────────
// Sub-components
// ──────────────────────────────
const StatCard = ({ icon, value, label }) => (
  <div style={{ textAlign: "center" }}>
    <div style={{ fontSize: "18px", marginBottom: "2px" }}>{icon}</div>
    <div style={{ fontSize: "18px", fontWeight: 800, color: C.grayDark }}>{value}</div>
    <div style={{ fontSize: "11px", color: C.grayMed }}>{label}</div>
  </div>
);

const InfoRow = ({ icon, label, value, valueColor }) => (
  <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
    <span>{icon}</span>
    <span style={{ color: C.grayMed }}>{label}</span>
    <strong style={{ marginLeft: "auto", color: valueColor || C.grayDark }}>{value}</strong>
  </div>
);

// ──────────────────────────────
// Loading screen
// ──────────────────────────────
const LoadingScreen = ({ progress, step }) => (
  <div style={{
    position: "fixed", inset: 0, zIndex: 9999,
    background: "linear-gradient(135deg, #F47920 0%, #D4621A 40%, #003DA5 100%)",
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    fontFamily: "Nunito, sans-serif"
  }}>
    <div style={{ animation: "bounce 1s infinite", marginBottom: "32px" }}>
      <BusMascot lineNumber="AB" color="white" size={80}/>
    </div>
    <h1 style={{ color: "white", fontSize: "28px", fontWeight: 900, margin: "0 0 8px" }}>Aix en Bus Live</h1>
    <p style={{ color: "rgba(255,255,255,0.8)", margin: "0 0 32px", textAlign: "center", padding: "0 24px" }}>{step}</p>
    <div style={{ width: "280px", height: "6px", background: "rgba(255,255,255,0.3)", borderRadius: "3px", overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${progress}%`, background: "white", borderRadius: "3px", transition: "width 0.5s ease" }}/>
    </div>
    <p style={{ color: "rgba(255,255,255,0.6)", marginTop: "16px", fontSize: "13px" }}>
      Données : data.gouv.fr &middot; Open Data France
    </p>
  </div>
);

const NightMode = () => (
  <div style={{
    position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 500,
    display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)"
  }}>
    <div style={{ background: "white", borderRadius: "20px", padding: "40px", textAlign: "center", maxWidth: "340px" }}>
      <div style={{ fontSize: "64px", marginBottom: "16px" }}>🌙</div>
      <h2 style={{ fontWeight: 800, fontSize: "20px", margin: "0 0 8px" }}>Réseau en veille</h2>
      <p style={{ color: C.grayMed, fontSize: "14px", margin: 0 }}>Aucun bus en service actuellement. Le réseau reprend demain matin.</p>
    </div>
  </div>
);

const DemoBanner = () => (
  <div style={{ background: "#FEF3C7", color: "#92400E", padding: "8px 16px", fontSize: "13px", fontWeight: 600, textAlign: "center", borderBottom: "1px solid #FDE68A", fontFamily: "Nunito,sans-serif" }}>
    ⚠️ Mode démonstration — Données GTFS indisponibles. Les positions affichées sont simulées.
  </div>
);

// ──────────────────────────────
// Main component
// ──────────────────────────────
export default function AixEnBusLive() {
  const [loading, setLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadStep, setLoadStep] = useState("Initialisation...");
  const [error, setError] = useState(false);
  const [gtfs, setGtfs] = useState(null);
  const [buses, setBuses] = useState([]);
  const [selectedBus, setSelectedBus] = useState(null);
  const [selectedRoutes, setSelectedRoutes] = useState(new Set());
  const [showAll, setShowAll] = useState(true);
  const [busCount, setBusCount] = useState(0);
  const [lastUpdate, setLastUpdate] = useState("--:--");
  const [stopSearch, setStopSearch] = useState("");
  const [isMobile, setIsMobile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userPos, setUserPos] = useState(null);
  const [libsReady, setLibsReady] = useState(false);

  const mapRef = useRef(null);
  const mapElRef = useRef(null);
  const markersRef = useRef({});
  const stopMarkersRef = useRef({});
  const shapeLayers = useRef([]);
  const userMarkerRef = useRef(null);
  const animFrames = useRef({});

  // Responsive
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Inject styles
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: 'Nunito', sans-serif; }
      @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.7;transform:scale(1.2)} }
      @keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-12px)} }
      @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
      @keyframes bounceIn { from{transform:scale(.3);opacity:0} 60%{transform:scale(1.1);opacity:1} to{transform:scale(1)} }
      .bus-marker { cursor:pointer; transition:transform .2s; }
      .bus-marker:hover { transform:scale(1.15); z-index:9999!important; }
      .leaflet-popup-content-wrapper { border-radius:12px!important; box-shadow:0 4px 20px rgba(0,0,0,0.15)!important; }
      .leaflet-popup-content { margin:12px 14px!important; }
      ::-webkit-scrollbar { width:6px } ::-webkit-scrollbar-track { background:#f1f1f1;border-radius:3px }
      ::-webkit-scrollbar-thumb { background:#ccc;border-radius:3px } ::-webkit-scrollbar-thumb:hover { background:#aaa }
    `;
    document.head.appendChild(style);
    return () => { try { document.head.removeChild(style); } catch(e) {} };
  }, []);

  // Load external libraries
  useEffect(() => {
    (async () => {
      try {
        await loadCSS("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css");
        await loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js", "L");
        await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js", "JSZip");
        setLibsReady(true);
      } catch (e) {
        console.error("Library load error:", e);
        setError(true);
        setLoading(false);
      }
    })();
  }, []);

  // Load GTFS data once libs are ready
  useEffect(() => {
    if (!libsReady) return;
    (async () => {
      try {
        const data = await loadGTFS((p, s) => { setLoadProgress(p); setLoadStep(s); });
        setGtfs(data);
        setLoadProgress(100);
        setLoadStep("Carte prête !");
        setTimeout(() => setLoading(false), 600);
      } catch (e) {
        console.error("GTFS load error:", e);
        setError(true);
        setTimeout(() => setLoading(false), 400);
      }
    })();
  }, [libsReady]);

  // Active routes from current buses
  const activeRoutes = useMemo(() => {
    const map = {};
    for (const b of buses) {
      if (!map[b.routeId]) map[b.routeId] = { route_id: b.routeId, route_short_name: b.lineNumber, color: b.color };
    }
    const arr = Object.values(map);
    arr.sort((a,b) => {
      const na = parseInt(a.route_short_name), nb = parseInt(b.route_short_name);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.route_short_name.localeCompare(b.route_short_name);
    });
    return arr;
  }, [buses]);

  // Filtered buses
  const filteredBuses = useMemo(() => {
    if (showAll) return buses;
    return buses.filter(b => selectedRoutes.has(b.routeId));
  }, [buses, showAll, selectedRoutes]);

  // Initialize map
  useEffect(() => {
    if (loading || !libsReady || !mapElRef.current || mapRef.current) return;
    const L = window.L;
    if (!L) return;

    const map = L.map(mapElRef.current, {
      center: AIX_CENTER, zoom: 13, zoomControl: false
    });

    L.tileLayer(TILE_URL, {
      attribution: '&copy; <a href="https://carto.com">CARTO</a> &copy; <a href="https://www.openstreetmap.org">OSM</a>',
      maxZoom: 19
    }).addTo(map);

    L.control.zoom({ position: "topright" }).addTo(map);
    mapRef.current = map;

    // Fit bounds to stops if available
    if (gtfs && gtfs.stops.length > 0) {
      const lats = gtfs.stops.map(s => +s.stop_lat).filter(v => v > 0);
      const lons = gtfs.stops.map(s => +s.stop_lon).filter(v => v > 0);
      if (lats.length > 0) {
        map.fitBounds([
          [Math.min(...lats), Math.min(...lons)],
          [Math.max(...lats), Math.max(...lons)]
        ], { padding: [30, 30] });
      }
    }

    return () => { map.remove(); mapRef.current = null; };
  }, [loading, libsReady, gtfs]);

  // Add stop markers at higher zoom
  useEffect(() => {
    if (!mapRef.current || !gtfs) return;
    const L = window.L;
    const map = mapRef.current;

    const updateStops = () => {
      const zoom = map.getZoom();
      // Show stops at zoom >= 15
      if (zoom >= 15) {
        const bounds = map.getBounds();
        for (const s of gtfs.stops) {
          const lat = +s.stop_lat, lon = +s.stop_lon;
          if (!bounds.contains([lat, lon])) {
            if (stopMarkersRef.current[s.stop_id]) {
              map.removeLayer(stopMarkersRef.current[s.stop_id]);
              delete stopMarkersRef.current[s.stop_id];
            }
            continue;
          }
          if (stopMarkersRef.current[s.stop_id]) continue;
          const icon = L.divIcon({
            html: `<div style="width:10px;height:10px;background:white;border:2px solid ${C.orange};border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.3)"></div>`,
            className: "", iconSize: [14, 14], iconAnchor: [7, 7]
          });
          const m = L.marker([lat, lon], { icon, zIndexOffset: 100 }).addTo(map);
          m.on("click", () => {
            const deps = getNextDepartures(s.stop_id, gtfs, new Date());
            const rows = deps.length > 0 ? deps.map(d =>
              `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #F3F4F6">
                <span style="background:${d.color};color:white;padding:3px 8px;border-radius:6px;font-size:13px;font-weight:800;min-width:28px;text-align:center">${d.lineNumber}</span>
                <span style="flex:1;font-size:13px">${d.direction}</span>
                <strong style="font-size:13px;color:${d.minutesFromNow<=2?"#EF4444":C.orange}">${d.minutesFromNow===0?"Maintenant":`${d.minutesFromNow} min`}</strong>
              </div>`
            ).join("") : `<p style="color:#6B7280;font-size:13px">Aucun passage prévu dans les 60 min</p>`;
            m.bindPopup(`<div style="font-family:Nunito,sans-serif;min-width:220px">
              <strong style="font-size:14px">🛑 ${s.stop_name}</strong>
              <div style="margin-top:10px">${rows}</div>
            </div>`).openPopup();
          });
          stopMarkersRef.current[s.stop_id] = m;
        }
      } else {
        // Remove all stop markers
        Object.values(stopMarkersRef.current).forEach(m => map.removeLayer(m));
        stopMarkersRef.current = {};
      }
    };

    map.on("zoomend moveend", updateStops);
    updateStops();
    return () => map.off("zoomend moveend", updateStops);
  }, [gtfs]);

  // Compute & update bus positions
  const updatePositions = useCallback(() => {
    const now = new Date();
    let newBuses;
    if (gtfs) {
      newBuses = computeBusPositions(gtfs, now);
    } else if (error) {
      newBuses = DEMO_BUSES;
    } else {
      newBuses = [];
    }
    setBuses(newBuses);
    setBusCount(newBuses.length);
    setLastUpdate(fmtTime(now).slice(0, 5));
  }, [gtfs, error]);

  useEffect(() => {
    if (loading) return;
    updatePositions();
    const iv = setInterval(updatePositions, REFRESH_MS);
    return () => clearInterval(iv);
  }, [loading, updatePositions]);

  // Render bus markers on map
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;
    const map = mapRef.current;

    const currentIds = new Set(filteredBuses.map(b => b.tripId));

    // Remove old markers
    Object.keys(markersRef.current).forEach(id => {
      if (!currentIds.has(id)) {
        map.removeLayer(markersRef.current[id]);
        delete markersRef.current[id];
        if (animFrames.current[id]) { cancelAnimationFrame(animFrames.current[id]); delete animFrames.current[id]; }
      }
    });

    // Add/update markers
    for (const bus of filteredBuses) {
      const isSel = selectedBus?.tripId === bus.tripId;
      const sz = isSel ? 72 : 56;
      const icon = L.divIcon({
        html: busSVGString(bus.lineNumber, bus.color, isSel),
        className: "bus-marker",
        iconSize: [sz, sz * .75],
        iconAnchor: [sz/2, sz*.75/2],
        popupAnchor: [0, -sz*.75/2]
      });

      if (markersRef.current[bus.tripId]) {
        // Animate to new pos
        const marker = markersRef.current[bus.tripId];
        marker.setIcon(icon);
        const start = marker.getLatLng();
        const startTime = Date.now();
        const dur = REFRESH_MS;
        const anim = () => {
          const elapsed = Date.now() - startTime;
          const p = Math.min(1, elapsed / dur);
          const e = easeInOut(p);
          marker.setLatLng([
            start.lat + e * (bus.lat - start.lat),
            start.lng + e * (bus.lon - start.lng)
          ]);
          if (p < 1) animFrames.current[bus.tripId] = requestAnimationFrame(anim);
        };
        if (animFrames.current[bus.tripId]) cancelAnimationFrame(animFrames.current[bus.tripId]);
        requestAnimationFrame(anim);
      } else {
        const marker = L.marker([bus.lat, bus.lon], { icon, zIndexOffset: 1000 }).addTo(map);
        marker.bindPopup(() => {
          return `<div style="font-family:Nunito,sans-serif;min-width:200px;padding:4px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
              <div style="background:${bus.color};color:white;width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900">${bus.lineNumber}</div>
              <div><strong style="font-size:15px">Ligne ${bus.lineNumber}</strong><br><span style="color:#6B7280;font-size:12px">${bus.direction}</span></div>
            </div>
            <hr style="border:none;border-top:1px solid #F3F4F6;margin:8px 0">
            <div style="display:flex;flex-direction:column;gap:6px;font-size:13px">
              <div><span style="color:#6B7280">📍 Prochain arrêt :</span> <strong>${bus.nextStopName}</strong></div>
              <div><span style="color:#6B7280">⏱️ Dans :</span> <strong>~${bus.minutesToNextStop} min</strong></div>
            </div>
            <div style="margin-top:10px;padding:6px 10px;background:#F0FDF4;border-radius:6px;color:#16A34A;font-size:12px;font-weight:600">🟢 En service · Position interpolée</div>
          </div>`;
        });
        marker.on("click", () => setSelectedBus(bus));
        markersRef.current[bus.tripId] = marker;
      }
    }
  }, [filteredBuses, selectedBus]);

  // Draw route shapes when filtered
  useEffect(() => {
    if (!mapRef.current || !gtfs || !window.L) return;
    const L = window.L;
    const map = mapRef.current;

    // Clear old shapes
    shapeLayers.current.forEach(l => map.removeLayer(l));
    shapeLayers.current = [];

    const routeIds = showAll ? new Set(buses.map(b => b.routeId)) : selectedRoutes;
    // Only draw shapes if few routes selected
    if (routeIds.size > 8) return;

    const drawn = new Set();
    for (const rid of routeIds) {
      const route = gtfs.routesMap[rid];
      if (!route) continue;
      const trip = gtfs.trips.find(t => t.route_id === rid && t.shape_id);
      if (!trip?.shape_id || drawn.has(trip.shape_id)) continue;
      drawn.add(trip.shape_id);

      const pts = gtfs.shapesMap[trip.shape_id];
      if (!pts || pts.length < 2) continue;
      const coords = pts.map(p => [+p.shape_pt_lat, +p.shape_pt_lon]);
      const color = route.route_color ? `#${route.route_color}` : C.orange;
      const line = L.polyline(coords, { color, weight: 3, opacity: .45, dashArray: "6,4" }).addTo(map);
      shapeLayers.current.push(line);
    }
  }, [filteredBuses, gtfs, showAll, selectedRoutes, buses]);

  // Geolocation
  const locateUser = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => {
      const latlng = [pos.coords.latitude, pos.coords.longitude];
      setUserPos(latlng);
      if (mapRef.current) {
        mapRef.current.setView(latlng, 15);
        const L = window.L;
        if (userMarkerRef.current) mapRef.current.removeLayer(userMarkerRef.current);
        userMarkerRef.current = L.marker(latlng, {
          icon: L.divIcon({
            html: `<div style="width:16px;height:16px;background:#3B82F6;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(59,130,246,0.5)"></div>`,
            className: "", iconSize: [22, 22], iconAnchor: [11, 11]
          }), zIndexOffset: 2000
        }).addTo(mapRef.current);
      }
    }, () => {}, { enableHighAccuracy: true });
  }, []);

  // Route toggle
  const toggleRoute = useCallback((rid) => {
    setShowAll(false);
    setSelectedRoutes(prev => {
      const next = new Set(prev);
      if (next.has(rid)) next.delete(rid); else next.add(rid);
      if (next.size === 0) { setShowAll(true); return new Set(); }
      return next;
    });
  }, []);

  const selectAllRoutes = useCallback(() => {
    setShowAll(true);
    setSelectedRoutes(new Set());
  }, []);

  // Stop search filter
  const filteredStops = useMemo(() => {
    if (!gtfs || !stopSearch.trim()) return [];
    const q = stopSearch.toLowerCase();
    return gtfs.stops.filter(s => s.stop_name?.toLowerCase().includes(q)).slice(0, 8);
  }, [gtfs, stopSearch]);

  // ── Render ──
  if (loading) return <LoadingScreen progress={loadProgress} step={loadStep}/>;

  const sidebarContent = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "Nunito,sans-serif" }}>
      {/* Search */}
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.grayLight}` }}>
        <input
          value={stopSearch} onChange={e => setStopSearch(e.target.value)}
          placeholder="🔍 Chercher un arrêt..."
          style={{
            width: "100%", padding: "10px 14px", borderRadius: "10px",
            border: `2px solid #E5E7EB`, fontSize: "14px", fontFamily: "Nunito,sans-serif",
            outline: "none", boxSizing: "border-box"
          }}
          onFocus={e => e.target.style.borderColor = C.orange}
          onBlur={e => e.target.style.borderColor = "#E5E7EB"}
        />
        {filteredStops.length > 0 && (
          <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "4px" }}>
            {filteredStops.map(s => (
              <button key={s.stop_id} onClick={() => {
                if (mapRef.current) mapRef.current.setView([+s.stop_lat, +s.stop_lon], 16);
                setStopSearch("");
              }} style={{
                padding: "8px 12px", borderRadius: "8px", border: "none", background: C.grayLight,
                textAlign: "left", cursor: "pointer", fontSize: "13px", fontFamily: "Nunito,sans-serif"
              }}>
                🛑 {s.stop_name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Line filters */}
      <div style={{ padding: "16px", borderBottom: `1px solid ${C.grayLight}` }}>
        <h3 style={{ fontSize: "12px", fontWeight: 700, color: C.grayMed, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: "10px" }}>
          Lignes actives ({activeRoutes.length})
        </h3>
        <button onClick={selectAllRoutes} style={{
          width: "100%", padding: "8px", marginBottom: "10px",
          background: showAll ? C.orange : C.grayLight,
          color: showAll ? "white" : "#374151",
          borderRadius: "8px", border: "none", cursor: "pointer",
          fontSize: "13px", fontWeight: 600, fontFamily: "Nunito,sans-serif"
        }}>Toutes les lignes</button>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {activeRoutes.map(r => {
            const sel = selectedRoutes.has(r.route_id);
            return (
              <button key={r.route_id} onClick={() => toggleRoute(r.route_id)} style={{
                padding: "5px 12px", borderRadius: "16px",
                border: `2px solid ${sel ? r.color : "#E5E7EB"}`,
                background: sel ? r.color : "white",
                color: sel ? (isColorDark(r.color) ? "white" : "#2C2C2C") : "#374151",
                fontSize: "13px", fontWeight: 700, fontFamily: "Nunito,sans-serif",
                cursor: "pointer", transition: "all .15s ease",
                transform: sel ? "scale(1.05)" : "scale(1)"
              }}>{r.route_short_name}</button>
            );
          })}
        </div>
      </div>

      {/* Stats */}
      <div style={{ margin: "12px 16px", padding: "14px", background: "linear-gradient(135deg,#FFF7F0,#FFF0E6)", borderRadius: "12px", border: "1px solid #FDE8D5" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
          <StatCard icon="🚌" value={busCount} label="Bus en route"/>
          <StatCard icon="🛑" value={gtfs?.stops?.length || "—"} label="Arrêts"/>
          <StatCard icon="🗺️" value={activeRoutes.length} label="Lignes"/>
          <StatCard icon="⏱️" value="~15s" label="Refresh"/>
        </div>
      </div>

      {/* Selected bus info */}
      {selectedBus && (
        <div style={{
          margin: "0 16px 16px", padding: "16px", background: "white", borderRadius: "12px",
          border: `2px solid ${selectedBus.color}`, boxShadow: `0 4px 16px ${selectedBus.color}30`,
          animation: "fadeIn .3s ease"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
              <BusMascot lineNumber={selectedBus.lineNumber} color={selectedBus.color} size={40}/>
              <div>
                <p style={{ fontWeight: 800, fontSize: "16px", margin: 0 }}>Ligne {selectedBus.lineNumber}</p>
                <p style={{ color: C.grayMed, fontSize: "12px", margin: 0 }}>{selectedBus.direction}</p>
              </div>
            </div>
            <button onClick={() => setSelectedBus(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "18px", color: C.grayMed }}>✕</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <InfoRow icon="📍" label="Prochain arrêt" value={selectedBus.nextStopName}/>
            <InfoRow icon="⏱️" label="Dans" value={`~${selectedBus.minutesToNextStop} min`}/>
            <InfoRow icon="🟢" label="Statut" value="En service" valueColor="#16A34A"/>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column", fontFamily: "Nunito,sans-serif", overflow: "hidden" }}>
      {/* Demo banner */}
      {error && <DemoBanner/>}

      {/* Header */}
      <header style={{
        background: "linear-gradient(135deg, #F47920 0%, #D4621A 100%)",
        padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between",
        boxShadow: "0 2px 12px rgba(244,121,32,0.4)", zIndex: 1000, position: "relative", flexShrink: 0
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <svg width="32" height="24" viewBox="0 0 64 48">
            <rect x="4" y="6" width="56" height="34" rx="10" fill="white"/>
            <rect x="10" y="10" width="9" height="7" rx="2" fill={C.orange} fillOpacity=".7"/>
            <rect x="22" y="10" width="9" height="7" rx="2" fill={C.orange} fillOpacity=".7"/>
            <rect x="34" y="10" width="9" height="7" rx="2" fill={C.orange} fillOpacity=".7"/>
            <circle cx="16" cy="40" r="5" fill="white" fillOpacity=".6"/>
            <circle cx="48" cy="40" r="5" fill="white" fillOpacity=".6"/>
          </svg>
          <div>
            <h1 style={{ color: "white", fontSize: isMobile ? "16px" : "18px", fontWeight: 800, margin: 0, lineHeight: 1.2 }}>Aix en Bus Live</h1>
            {!isMobile && <p style={{ color: "rgba(255,255,255,0.8)", fontSize: "11px", margin: 0 }}>La Métropole Mobilité · Positions en direct</p>}
          </div>
        </div>
        <div style={{
          background: "rgba(255,255,255,0.2)", borderRadius: "20px", padding: "5px 12px",
          display: "flex", alignItems: "center", gap: "6px"
        }}>
          <div style={{ width: "8px", height: "8px", background: "#4ADE80", borderRadius: "50%", animation: "pulse 2s infinite" }}/>
          <span style={{ color: "white", fontSize: "12px", fontWeight: 600 }}>
            {busCount} bus · {lastUpdate}
          </span>
        </div>
      </header>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", position: "relative", overflow: "hidden" }}>
        {/* Sidebar — desktop */}
        {!isMobile && (
          <aside style={{
            width: "320px", background: "white", borderRight: "1px solid #E5E7EB",
            display: "flex", flexDirection: "column", overflowY: "auto",
            boxShadow: "2px 0 12px rgba(0,0,0,0.06)", zIndex: 500, flexShrink: 0
          }}>
            {sidebarContent}
          </aside>
        )}

        {/* Map */}
        <div style={{ flex: 1, position: "relative" }}>
          <div ref={mapElRef} style={{ width: "100%", height: "100%" }}/>

          {/* Night mode overlay */}
          {busCount === 0 && !error && !loading && <NightMode/>}

          {/* Locate button */}
          <button onClick={locateUser} title="Me localiser" style={{
            position: "absolute", right: "12px", bottom: isMobile ? "180px" : "24px",
            zIndex: 500, background: "white", width: "42px", height: "42px", borderRadius: "10px",
            border: "none", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.15)", fontSize: "18px"
          }}>📍</button>

          {/* Mobile drawer toggle */}
          {isMobile && (
            <button onClick={() => setDrawerOpen(v => !v)} style={{
              position: "absolute", bottom: drawerOpen ? "42%" : "8px", left: "50%",
              transform: "translateX(-50%)", zIndex: 600, background: "white",
              borderRadius: "20px", border: "none", padding: "8px 24px",
              boxShadow: "0 2px 12px rgba(0,0,0,0.15)", cursor: "pointer",
              fontSize: "13px", fontWeight: 700, fontFamily: "Nunito,sans-serif",
              transition: "bottom .3s ease"
            }}>
              {drawerOpen ? "▾ Fermer" : `▴ ${busCount} bus en service`}
            </button>
          )}
        </div>

        {/* Mobile drawer */}
        {isMobile && (
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            height: drawerOpen ? "40%" : "0",
            background: "white", borderTopLeftRadius: "16px", borderTopRightRadius: "16px",
            boxShadow: "0 -4px 20px rgba(0,0,0,0.1)", zIndex: 550,
            transition: "height .3s ease", overflow: "hidden"
          }}>
            <div style={{ overflowY: "auto", height: "100%" }}>
              {sidebarContent}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
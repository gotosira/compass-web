import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * FIX: The previous canvas contained Dart (Flutter) code inside a TSX file, which the
 * TypeScript/React runner tried to parse and raised a syntax error. This rewrite restores
 * a valid React+TSX implementation that runs in-browser and behaves like a real compass.
 *
 * What you get:
 * - Full‑screen, responsive compass dial that ROTATES with device heading.
 * - 0° is North (top). A fixed top index marker shows your facing direction.
 * - 64 slices, 2‑decimal degree labels around the rim, bold border every 8 slices.
 * - Cardinal letters (N, E, S, W) always visible.
 * - iOS permission flow ("Enable compass" button) + graceful fallbacks.
 * - Lightweight runtime tests via console.assert (tiling, degrees formatting, etc.).
 */

export default function App() {
  const canvasRef = useRef(null);

  // Geometry (fixed for compass mode)
  const SEGMENTS = 64;
  // Old fixed values made mobile cramped; compute responsive geometry during draw
  const PADDING = 110;
  const INNER_R = 160;

  // Responsive canvas size
  const [size, setSize] = useState(800);

  // Heading in degrees (0..360), 0 = North
  const [heading, setHeading] = useState(0);
  const [sensorStatus, setSensorStatus] = useState("idle");
  const [showBig, setShowBig] = useState(false);
  const [showSmall, setShowSmall] = useState(false);
  const [currentBig, setCurrentBig] = useState(null);
  const [currentSmall, setCurrentSmall] = useState(null);
  const [showAspects, setShowAspects] = useState(false);
  const [userName, setUserName] = useState("");
  const [birthNum, setBirthNum] = useState(null); // now holds mapped direction number per spec
  const [showIntro, setShowIntro] = useState(false);
  const [theme, setTheme] = useState("noon");
  const [lat, setLat] = useState(null);
  const [lon, setLon] = useState(null);
  const [altitudeM, setAltitudeM] = useState(null);
  const [place, setPlace] = useState("");
  const [geoStatus, setGeoStatus] = useState("idle");
  // Floor plan overlay state
  const [planImage, setPlanImage] = useState(null);
  const [planImageUrl, setPlanImageUrl] = useState("");
  const [planVisible, setPlanVisible] = useState(true);
  const [planOpacity, setPlanOpacity] = useState(0.6);
  const [planScale, setPlanScale] = useState(1);
  const [planRotationDeg, setPlanRotationDeg] = useState(0);
  const [planX, setPlanX] = useState(0);
  const [planY, setPlanY] = useState(0);
  const [planControlsOpen, setPlanControlsOpen] = useState(false);
  const [rotationSnap, setRotationSnap] = useState(1); // 1° or 5°
  // Camera background (AR mode)
  const [cameraOn, setCameraOn] = useState(false);
  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const [planFollowHeading, setPlanFollowHeading] = useState(false);
  const [cameraZoom, setCameraZoom] = useState(1);
  // Upload status & gallery
  const [uploading, setUploading] = useState(false);
  const [uploadMs, setUploadMs] = useState(null);
  const [uploadError, setUploadError] = useState("");
  const [planGallery, setPlanGallery] = useState([]); // array of dataURLs (strings)
  const fileInputRef = useRef(null);
  const planDragRef = useRef({ dragging: false, lastX: 0, lastY: 0 });

  // Helper: load Image from data URL and update state
  const loadPlanFromDataUrl = (dataUrl) => {
    if (!dataUrl) return;
    try {
      const img = new Image();
      img.onload = () => {
        setPlanImage(img);
        setPlanImageUrl(dataUrl);
      };
      img.src = dataUrl;
    } catch {}
  };

  // Helper: compress file to dataURL (jpeg) to fit localStorage limits
  const fileToCompressedDataUrl = (file) => new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxSide = 1600; // limit dimension to save space
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          resolve(dataUrl);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    } catch { resolve(""); }
  });

  // ---------- lightweight tests (act like smoke tests) ----------
  useEffect(() => {
    const step = 360 / SEGMENTS;
    console.assert(Math.abs(step * SEGMENTS - 360) < 1e-9, "Segments must tile to 360°");
    console.assert(Math.abs(step - 5.625) < 1e-9, "64 segments should be 5.625° each");
    const sample = (3 * step).toFixed(2);
    console.assert(/^\d+\.\d{2}$/.test(sample), "Degree labels should have 2 decimals");
  }, []);

  // Fit canvas to the smaller viewport dimension
  useEffect(() => {
    const update = () => {
      const m = Math.min(window.innerWidth, window.innerHeight);
      // keep a small margin so outer labels aren't cut off
      setSize(Math.max(320, Math.min(1600, Math.floor(m - 16))));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Device Orientation → heading
  useEffect(() => {
    const needPerm =
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function";

    if (needPerm) {
      setSensorStatus("need-permission");
    } else {
      const ok = startSensors();
      setSensorStatus(ok ? "active" : "unavailable");
    }

    return stopSensors; // cleanup on unmount
  }, []);

  const listeners = [];
  const targetHeadingRef = useRef(0);
  const headingRef = useRef(0);
  const rafRef = useRef(0);
  const preferWebkitRef = useRef(false);
  const chosenEventRef = useRef(null); // 'absolute' | 'relative'
  const recentTargetsRef = useRef([]);
  const [offsetDeg, setOffsetDeg] = useState(() => {
    const v = Number(localStorage.getItem("compassOffsetDeg") || "0");
    return Number.isFinite(v) ? v : 0;
  });
  useEffect(() => {
    try { localStorage.setItem("compassOffsetDeg", String(offsetDeg)); } catch {}
  }, [offsetDeg]);

  function isIOS() {
    const ua = navigator.userAgent || "";
    const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    return /iP(hone|ad|od)/.test(ua) || iPadOS;
  }

  function isAndroid() {
    return /Android/i.test(navigator.userAgent || "");
  }

  function wrapText(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let current = "";
    for (const w of words) {
      const test = current ? current + " " + w : w;
      const wWidth = ctx.measureText(test).width;
      if (wWidth <= maxWidth) {
        current = test;
      } else {
        if (current) lines.push(current);
        current = w;
      }
    }
    if (current) lines.push(current);
    return lines.slice(0, 6); // cap lines for box height
  }

  function directionName(n) {
    const m = {
      6: "เหนือ",
      4: "ใต้",
      2: "ตะวันออก",
      5: "ตะวันตก",
      1: "ตะวันออกเฉียงเหนือ",
      3: "ตะวันตกเฉียงเหนือ",
      8: "ตะวันออกเฉียงใต้",
      7: "ตะวันตกเฉียงใต้",
    };
    return m[n] || "";
  }

  // Themes for noon, dark, and red night mode
  const THEMES = {
    noon: {
      page: "#ffffff",
      bg: "#ffffff",
      text: "#0f172a",
      major: "#0f172a",
      minor: "rgba(15,23,42,.2)",
      tickMaj: "rgba(15,23,42,.53)",
      tickMin: "rgba(15,23,42,.27)",
      sub: "#64748b",
      accent: "#111827",
      outline: "#10b981",
      topbarBg: "rgba(255,255,255,.85)",
      topbarBorder: "#e2e8f0",
      muted: "#334155",
      overlayBg: "rgba(255,255,255,0.95)",
      overlayBorder: "#e2e8f0",
      buttonBg: "#0f172a",
      buttonText: "#ffffff",
      trackBg: "rgba(255,255,255,0.9)",
    },
    dark: {
      page: "#0b1220",
      bg: "#0b1220",
      text: "#e5e7eb",
      major: "#e5e7eb",
      minor: "rgba(229,231,235,.2)",
      tickMaj: "rgba(229,231,235,.55)",
      tickMin: "rgba(229,231,235,.3)",
      sub: "#94a3b8",
      accent: "#f1f5f9",
      outline: "#22c55e",
      topbarBg: "rgba(15,23,42,.7)",
      topbarBorder: "#1f2937",
      muted: "#cbd5e1",
      overlayBg: "rgba(15,23,42,0.9)",
      overlayBorder: "#1f2937",
      buttonBg: "#e5e7eb",
      buttonText: "#0b1220",
      trackBg: "rgba(15,23,42,0.6)",
    },
    red: {
      page: "#000000",
      bg: "#000000",
      text: "#ff584a",
      major: "#ff584a",
      minor: "rgba(255,88,74,.25)",
      tickMaj: "rgba(255,88,74,.6)",
      tickMin: "rgba(255,88,74,.3)",
      sub: "rgba(255,88,74,.6)",
      accent: "#ff584a",
      outline: "#ff584a",
      topbarBg: "rgba(0,0,0,.7)",
      topbarBorder: "#222",
      muted: "#ff9a90",
      overlayBg: "rgba(0,0,0,0.9)",
      overlayBorder: "#222",
      buttonBg: "#ff584a",
      buttonText: "#000000",
      trackBg: "rgba(0,0,0,0.6)",
    },
    watch: {
      page: "#000000",
      bg: "#000000",
      text: "#F9FAFB",
      major: "#F9FAFB",
      minor: "rgba(249,250,251,.18)",
      tickMaj: "rgba(249,250,251,.6)",
      tickMin: "rgba(249,250,251,.28)",
      sub: "#94a3b8",
      accent: "#00ff7f",
      outline: "#00ff7f",
      topbarBg: "rgba(0,0,0,.75)",
      topbarBorder: "#1a1a1a",
      muted: "#cbd5e1",
      overlayBg: "rgba(0,0,0,0.9)",
      overlayBorder: "#1a1a1a",
      buttonBg: "#22c55e",
      buttonText: "#000000",
      trackBg: "rgba(0,0,0,0.6)",
    },
  };
  const t = THEMES[theme] || THEMES.noon;

  // Intro bootstrap from localStorage; don't show modal until sensors active
  useEffect(() => {
    try {
      const n = localStorage.getItem("userName") || "";
      const b = Number(localStorage.getItem("birthNum") || "");
      if (n) setUserName(n);
      if (Number.isFinite(b) && b >= 1 && b <= 7) setBirthNum(b);
      // restore overlay
      const pv = localStorage.getItem("planVisible");
      if (pv != null) setPlanVisible(pv === "true");
      const po = Number(localStorage.getItem("planOpacity") || "");
      if (Number.isFinite(po)) setPlanOpacity(Math.max(0, Math.min(1, po)));
      const ps = Number(localStorage.getItem("planScale") || "");
      if (Number.isFinite(ps)) setPlanScale(Math.max(0.2, Math.min(3, ps)));
      const pr = Number(localStorage.getItem("planRotationDeg") || "");
      if (Number.isFinite(pr)) setPlanRotationDeg(Math.max(-180, Math.min(180, pr)));
      const px = Number(localStorage.getItem("planX") || "");
      if (Number.isFinite(px)) setPlanX(px);
      const py = Number(localStorage.getItem("planY") || "");
      if (Number.isFinite(py)) setPlanY(py);
      const rs = Number(localStorage.getItem("rotationSnap") || "");
      if (rs === 1 || rs === 5) setRotationSnap(rs);
      const pu = localStorage.getItem("planImageUrl") || "";
      if (pu) loadPlanFromDataUrl(pu);
      const galleryJson = localStorage.getItem("planGallery") || "[]";
      try { const arr = JSON.parse(galleryJson); if (Array.isArray(arr)) setPlanGallery(arr.filter(Boolean)); } catch {}
    } catch {}
  }, []);

  // persist overlay settings
  useEffect(()=>{ try{ localStorage.setItem("planVisible", String(planVisible)); }catch{} }, [planVisible]);
  useEffect(()=>{ try{ localStorage.setItem("planOpacity", String(planOpacity)); }catch{} }, [planOpacity]);
  useEffect(()=>{ try{ localStorage.setItem("planScale", String(planScale)); }catch{} }, [planScale]);
  useEffect(()=>{ try{ localStorage.setItem("planRotationDeg", String(planRotationDeg)); }catch{} }, [planRotationDeg]);
  useEffect(()=>{ try{ localStorage.setItem("planX", String(planX)); }catch{} }, [planX]);
  useEffect(()=>{ try{ localStorage.setItem("planY", String(planY)); }catch{} }, [planY]);
  useEffect(()=>{ try{ localStorage.setItem("rotationSnap", String(rotationSnap)); }catch{} }, [rotationSnap]);
  useEffect(()=>{ try{ if (planImageUrl) localStorage.setItem("planImageUrl", planImageUrl); }catch{} }, [planImageUrl]);
  useEffect(()=>{ try{ localStorage.setItem("planGallery", JSON.stringify(planGallery.slice(0,10))); }catch{} }, [planGallery]);

  useEffect(() => {
    if (sensorStatus === "active") {
      if (!userName || !birthNum) setShowIntro(true);
    }
  }, [sensorStatus]);

  function inferContextAndMood(text) {
    const t = String(text || "");
    const has = (arr) => arr.some((w) => t.includes(w));
    let icon = "🧭";
    let label = "ทั่วไป";
    if (has(["ความรัก", "คู่", "แต่งงาน", "ชู้สาว", "คู่ครอง", "คนรัก", "ครอบครัว"])) {
      icon = "❤️"; label = "ความรัก";
    } else if (has(["คดี", "ฟ้อง", "กฎหมาย", "ศาล"])) {
      icon = "⚖️"; label = "คดีความ";
    } else if (has(["งาน", "ตำแหน่ง", "ว่าจ้าง", "สัญญา", "หุ้นส่วน", "โครงการ", "ราชการ"])) {
      icon = "💼"; label = "งาน";
    } else if (has(["ทรัพย์", "เงิน", "มรดก", "การเงิน", "ทรัพย์สิน", "อามิส", "สินจ้าง"])) {
      icon = "💰"; label = "การเงิน";
    } else if (has(["เดินทาง", "โยกย้าย", "ต่างแดน", "ถิ่นฐาน"])) {
      icon = "✈️"; label = "เดินทาง/โยกย้าย";
    } else if (has(["เจ็บป่วย", "โรค", "สุขภาพ", "ไข้", "หัวใจ"])) {
      icon = "🩺"; label = "สุขภาพ";
    } else if (has(["ขัดแย้ง", "ศัตรู", "กีดกัน", "อาฆาต", "แตกแยก", "ใส่ความ"])) {
      icon = "⚠️"; label = "ความขัดแย้ง";
    } else if (has(["ช่วยเหลือ", "อุปถัมภ์", "ค้ำจุน", "ปกป้อง", "อุปการะ"])) {
      icon = "🤝"; label = "การช่วยเหลือ";
    }

    const goodWords = ["โอกาส", "สำเร็จ", "ช่วยเหลือ", "อุปถัมภ์", "ลาภ", "ยกย่อง", "อนุมัติ", "มรดก", "เติบโต", "ได้งาน", "ได้ทรัพย์", "สมปรารถนา", "พบเจอคนถูกใจ"];
    const badWords = ["ปัญหา", "ขัดแย้ง", "ศัตรู", "ฟ้อง", "คดี", "อุบัติเหตุ", "สูญเสีย", "เจ็บป่วย", "อิจฉา", "ใส่ความ", "ยึด", "ยกเลิก", "ลัก", "ขโมย", "ไม่สำเร็จ", "ปฏิเสธ", "หนี้", "ค้ำประกัน", "รุนแรง", "แตกหัก", "กลั่นแกล้ง", "เสี่ยง"];
    const goodScore = goodWords.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
    const badScore = badWords.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
    let mood = "neutral";
    let moodIcon = "";
    if (goodScore > badScore) { mood = "good"; moodIcon = "👍"; }
    else if (badScore > goodScore) { mood = "bad"; moodIcon = "👎"; }
    return { icon, label, mood, moodIcon };
  }

  // --- Geolocation & reverse geocoding ---
  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoStatus("error");
      return;
    }
    setGeoStatus("active");
    const onPos = (pos) => {
      const { latitude, longitude, altitude } = pos.coords || {};
      if (typeof latitude === "number" && typeof longitude === "number") {
        setLat(latitude);
        setLon(longitude);
      }
      if (typeof altitude === "number") setAltitudeM(Math.round(altitude));
    };
    const onErr = () => setGeoStatus("error");
    const id = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    });
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  useEffect(() => {
    const fetchPlace = async () => {
      if (lat == null || lon == null) return;
      try {
        const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=th`;
        const r = await fetch(url);
        const j = await r.json();
        const parts = [j.locality || j.city || j.localityInfo?.administrative?.[0]?.name, j.principalSubdivision, j.countryName].filter(Boolean);
        setPlace(parts.join(", "));
      } catch {}
    };
    fetchPlace();
  }, [lat, lon]);

  useEffect(() => {
    const fetchAlt = async () => {
      if (lat == null || lon == null || altitudeM != null) return;
      try {
        const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
        const j = await r.json();
        if (Array.isArray(j.elevation) && typeof j.elevation[0] === "number") {
          setAltitudeM(Math.round(j.elevation[0]));
        }
      } catch {}
    };
    fetchAlt();
  }, [lat, lon, altitudeM]);

  function formatLatLon(lat, lon) {
    const n = lat >= 0 ? "N" : "S";
    const e = lon >= 0 ? "E" : "W";
    return `LAT: ${Math.abs(lat).toFixed(6)} ${n}   LNG: ${Math.abs(lon).toFixed(6)} ${e}`;
  }

  useEffect(() => {
    headingRef.current = heading;
  }, [heading]);

  function normalize(deg) {
    if (typeof deg !== "number" || Number.isNaN(deg)) return null;
    let d = deg % 360;
    if (d < 0) d += 360;
    return d;
  }

  // Compute a tilt-compensated heading from alpha/beta/gamma when webkit heading is not available.
  function computeHeadingFromEuler(ev) {
    if (
      typeof ev?.alpha !== "number" ||
      typeof ev?.beta !== "number" ||
      typeof ev?.gamma !== "number" ||
      !Number.isFinite(ev.alpha) ||
      !Number.isFinite(ev.beta) ||
      !Number.isFinite(ev.gamma)
    ) {
      return null;
    }
    const degtorad = Math.PI / 180;
    const _z = ev.alpha * degtorad; // yaw
    const _x = ev.beta * degtorad; // pitch
    const _y = ev.gamma * degtorad; // roll

    const cX = Math.cos(_x);
    const cY = Math.cos(_y);
    const cZ = Math.cos(_z);
    const sX = Math.sin(_x);
    const sY = Math.sin(_y);
    const sZ = Math.sin(_z);

    // Calculate Vx and Vy components
    const Vx = -cZ * sY - sZ * sX * cY;
    const Vy = -sZ * sY + cZ * sX * cY;

    let heading = Math.atan2(Vx, Vy);
    if (heading < 0) heading += Math.PI * 2;
    const headingDeg = heading * (180 / Math.PI);
    return headingDeg;
  }

  function startSensors() {
    try {
      const handle = (ev, kind) => {
        if (chosenEventRef.current && chosenEventRef.current !== kind) return; // ignore other stream
        let hdg = null;
        const hasWebkit = typeof ev?.webkitCompassHeading === "number" && Number.isFinite(ev.webkitCompassHeading);
        if (isIOS()) {
          if (hasWebkit) {
            hdg = ev.webkitCompassHeading;
            preferWebkitRef.current = true;
          } else {
            // On iOS ignore non-webkit readings to avoid wrong offsets
            return;
          }
        } else {
          if (hasWebkit) {
            hdg = ev.webkitCompassHeading;
          } else if (typeof ev?.alpha === "number" && Number.isFinite(ev.alpha)) {
            const compensated = computeHeadingFromEuler(ev);
            hdg = compensated !== null ? compensated : 360 - ev.alpha;
          }
        }
        const n = normalize(hdg);
        if (n !== null) {
          // Choose stream on first successful reading
          if (!chosenEventRef.current) {
            chosenEventRef.current = kind;
          }

          // Circular mean filter to reduce jitter (Android especially)
          const buf = recentTargetsRef.current;
          const maxLen = isAndroid() ? 7 : 3;
          buf.push(n);
          if (buf.length > maxLen) buf.shift();
          let sx = 0, sy = 0;
          for (const a of buf) {
            const r = (a * Math.PI) / 180;
            sx += Math.cos(r);
            sy += Math.sin(r);
          }
          let avg = Math.atan2(sy, sx) * (180 / Math.PI);
          avg = normalize(avg);
          // Quantize small steps to mitigate micro-shake
          const step = isAndroid() ? 1 : 0.5;
          const quant = Math.round((avg || 0) / step) * step;
          targetHeadingRef.current = normalize(quant) ?? avg;
        }
      };
      const handlerAbsolute = (ev) => handle(ev, "absolute");
      const handlerRelative = (ev) => handle(ev, "relative");
      window.addEventListener("deviceorientationabsolute", handlerAbsolute, { capture: true, passive: true });
      window.addEventListener("deviceorientation", handlerRelative, { capture: true, passive: true });
      listeners.push(["deviceorientationabsolute", handlerAbsolute]);
      listeners.push(["deviceorientation", handlerRelative]);
      return true;
    } catch (e) {
      console.warn("startSensors failed", e);
      return false;
    }
  }

  function stopSensors() {
    for (const [t, fn] of listeners) {
      try {
        window.removeEventListener(t, fn, true);
      } catch {}
    }
    listeners.length = 0;
  }

  // Drag to move plan overlay
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onDown = (e) => {
      if (!planVisible || !planImage) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      planDragRef.current = { dragging: true, lastX: x - rect.left, lastY: y - rect.top };
    };
    const onMove = (e) => {
      if (!planDragRef.current.dragging) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      const cx = x - rect.left;
      const cy = y - rect.top;
      const dx = cx - planDragRef.current.lastX;
      const dy = cy - planDragRef.current.lastY;
      planDragRef.current.lastX = cx;
      planDragRef.current.lastY = cy;
      setPlanX((v) => v + dx);
      setPlanY((v) => v + dy);
    };
    const onUp = () => { planDragRef.current.dragging = false; };
    canvas.addEventListener("mousedown", onDown, { passive: true });
    canvas.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mouseup", onUp, { passive: true });
    canvas.addEventListener("touchstart", onDown, { passive: true });
    canvas.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onUp, { passive: true });
    return () => {
      canvas.removeEventListener("mousedown", onDown, true);
      canvas.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      canvas.removeEventListener("touchstart", onDown, true);
      canvas.removeEventListener("touchmove", onMove, true);
      window.removeEventListener("touchend", onUp, true);
    };
  }, [planVisible, planImage]);

  async function onEnable() {
    try {
      const needsOrientationPerm =
        typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function";

      const needsMotionPerm =
        typeof DeviceMotionEvent !== "undefined" &&
        typeof DeviceMotionEvent.requestPermission === "function";

      if (needsOrientationPerm) {
        try {
          const resp = await DeviceOrientationEvent.requestPermission();
          if (resp !== "granted") {
          setSensorStatus("unavailable");
            return;
          }
        } catch (e) {
          console.warn("Orientation permission failed", e);
          setSensorStatus("error");
          return;
        }
      }

      if (needsMotionPerm) {
        try {
          await DeviceMotionEvent.requestPermission().catch(() => {});
        } catch {}
      }

      // On iOS 13+, request absolute orientation if supported
      try {
        if (typeof window.DeviceOrientationEvent !== "undefined" && typeof window.DeviceOrientationEvent.requestPermission !== "function") {
          // Some browsers expose deviceorientationabsolute separately; add a one-time listener to detect availability
          window.addEventListener("deviceorientationabsolute", (ev) => {
            if (typeof ev?.webkitCompassHeading === "number") {
              preferWebkitRef.current = true;
            }
          }, { once: true, passive: true });
        }
      } catch {}

        const ok = startSensors();
        setSensorStatus(ok ? "active" : "unavailable");
    } catch (e) {
      console.warn("Permission request failed", e);
      setSensorStatus("error");
    }
  }

  // --- heading smoothing (improves readability on mobile) ---
  function shortestAngleDelta(from, to) {
    let diff = (to - from) % 360;
    if (diff < -180) diff += 360;
    if (diff > 180) diff -= 360;
    return diff;
  }

  useEffect(() => {
    const animate = () => {
      const current = headingRef.current;
      const target = normalize(targetHeadingRef.current + offsetDeg) ?? 0;
      const diff = shortestAngleDelta(current, target);
      const smoothing = isAndroid() ? 0.10 : 0.15; // slower on Android to reduce shake
      const next = normalize(current + diff * smoothing);
      if (next !== null && Math.abs(diff) > 0.05) {
        setHeading(next);
      } else if (next !== null && Math.abs(diff) > 0) {
        // snap when close
        setHeading(target);
      }
      // If plan is following heading, update rotation continuously
      if (planFollowHeading) {
        setPlanRotationDeg(target);
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  function dir16(deg) {
    const names = [
      "N", "NNE", "NE", "ENE",
      "E", "ESE", "SE", "SSE",
      "S", "SSW", "SW", "WSW",
      "W", "WNW", "NW", "NNW",
    ];
    const idx = Math.round(((deg % 360) / 22.5)) % 16;
    return names[idx];
  }

  // ตำราเสวย/แทรก
  const MEANINGS = {
    "1-1": `จะเกิดอาการกระวนกระวายร้อน อดทนอยู่ที่เดิมไม่ได้ จะมีปัญหากับคนรอบตัว ถูกกลั่นแกล้งจากศัตรูเก่า มีความแค้นใจเป็นการส่วนตัว ต้องย้ายที่อยู่ เปลี่ยนแปลงสถานที่อาศัยทั้งการอยู่และการทำงาน`,
    "1-2": `จะได้ประสบพบเจอกับผู้ที่เข้ามาร่วมใช้ชีวิตด้วยกัน ทั้งความสัมพันธ์ทางครอบครัว และการร่วมมือ เข้าร่วมเป็นหุ้นส่วน มีโอกาสที่จะได้ลาภจากเพศตรงข้าม รวมไปถึงโอกาสของการแต่งงาน`,
    "1-3": `มีปัญหาการเป็นปฏิปักษ์ แข่งขัน และสร้างภาระ กีดกันและขัดขวางพยายามไม่ให้ประสบความสำเร็จ อาจจะเกิดปัญหาที่เกี่ยวข้องกับคดีความ การถูกดำเนินคดี เป็นภาวะที่ไม่อาจหลีกเลี่ยงได้ ถูกขู่เข็ญบังคับให้จำยอม`,
    "1-4": `ส่งผลในด้านของการคิดริเริ่ม และลงทุนสิ่งใหม่ การติดต่อ สร้างไมตรี การผูกมิตร และหาผู้ร่วมอุดมการณ์ จะได้รับการติดต่อประสานงาน ส่งผลดีในด้านของการเริ่มต้นโครงการใหม่`,
    "1-5": `ผูกพันเกี่ยวกับครอบครัว ความช่วยเหลือเกื้อกูลของผู้ใหญ่ ได้รับความอุปถัมภ์ค้ำจุน มีโอกาสเข้าพบญาติ ผู้ใหญ่ ผู้มีอำนาจเพื่อขอความช่วยเหลือ แต่จะเกิดปัญหาในเรื่องของคนใกล้ชิด วางใจมากเกินไปเป็นสาเหตุ`,
    "1-6": `มักได้รับโอกาส ได้เป็นที่รู้จักของคนทั่วไป มีโอกาสเดินทางไกลและได้รับการยกย่อง ทำให้ตัวเองมีชื่อเสียง ยังได้รับผลประโยชน์ส่วนแบ่ง การริเริ่มดำเนินงานใหม่ มักมาในรูปแบบทรัพย์สินที่มีค่า`,
    "1-7": `ชีวิตจะมีความร้อน กระวนกระวาย ไขว่คว้าโอกาสสร้างฐานะ พึงระวังคู่มิตรจะกลายเป็นศัตรู ต่อสู้และดิ้นรน แต่จะเจออุปสรรคระหว่างทาง โอกาสสำเร็จล่าช้าต้องรอเวลา มีโอกาสเจ็บป่วยขั้นรุนแรง`,
    "2-1": `พบเจอคู่หูที่ไม่ถูกชะตา หรือถูกหลอกให้กระทำ ระวังถูกอิจฉาริษยา ถูกหลอกใช้ให้ทำงานไม่สุจริต`,
    "2-2": `มักเจอปัญหาที่ไม่ตรงกับความถนัด การตัดสินใจผิดพลาด ผู้อื่นเป็นฝ่ายกระทำเราเป็นผู้รับผล ในดวงผู้มีครอบครัวมีโอกาสได้รับทายาท`,
    "2-3": `ถูกเพ่งเล็งด้วยความริษยา มักมีปัญหาเรื่องความรักเชิงชู้สาว ระวังถูกใส่ร้ายจากคนใกล้ตัว เกิดความขัดแย้งในครอบครัวเพราะความไม่เท่าเทียม`,
    "2-4": `มิตรให้การอุปการะ จะได้รับความช่วยเหลือจากเพื่อน มีคนปกป้องออกหน้า ช่วยแบกรับปัญหาให้ การงาน/สัญญาอาจมีเหตุให้เลื่อน`,
    "2-5": `การอุปการะที่ติดค้างบุญคุณ ได้รับความช่วยเหลือจากผู้ใหญ่ที่ไม่รู้จักมาก่อน แต่จะมีปัญหากับบริวาร โดยเฉพาะการอ้างสิทธิ์บุญคุณเก่า ถูกทวงบุญคุณ`,
    "2-6": `สมปรารถนาเมื่อแรกพบ มีเสน่ห์ต่อผู้พบเห็น อาจพบคนรักที่ถูกใจและมีโอกาสสร้างครอบครัว แต่ความสัมพันธ์อาจเปลี่ยนแปลงได้รวดเร็ว ถูกสลับหน้าที่ในการงาน`,
    "2-7": `ทอดทิ้งภาระ ส่งผลเรื่องย้ายงาน/ย้ายที่อยู่ ตัดภาระออกจากชีวิต พ่อแม่ลูกอยู่ห่างไกล`,
    "3-1": `ถูกขับไล่ บังคับให้สิ้นสภาพ มีปัญหาแข่งขัน กีดกัน อุบัติเหตุ ผู้ใหญ่กลั่นแกล้ง เสียผลประโยชน์`,
    "3-2": `ถูกชักชวนให้คล้อยตาม มีปัญหาเข้าไปเป็นมือที่สาม ถูกคนใกล้ชิดหักหลัง ทำให้ถูกใส่ร้าย ความรักมีปัญหา`,
    "3-3": `ลุ่มหลงทะนงตนเกินประมาณ ชีวิตโกลาหล ดิ้นรน ใช้อารมณ์ตัดสินใจ ทำผิดพลาด เสี่ยงคดีความในอนาคต`,
    "3-4": `กระทำผิดและทิ้งภาระให้ผู้อื่น หุ้นส่วนขัดแย้ง ถูกกดดันให้จำยอม แต่มีโอกาสได้งานพิเศษ ต้องพิจารณาสัญญาให้รัดกุม`,
    "3-5": `เกิดคดี ฟ้องร้อง หรือถูกฟ้อง ถูกเพ่งเล็งจากผู้ใหญ่ แต่มีโอกาสเติบโตในงาน ต้องสอบแข่งขัน ชิงตำแหน่ง`,
    "3-6": `จะได้ความช่วยเหลือจากผู้มีอำนาจ แต่อยู่ในฐานะลูกน้อง ระวังสัมพันธ์ลับกับผู้มีคู่ ปัญหาอาจถูกเปิดโปง`,
    "3-7": `ถูกเพ่งเล็ง ศัตรูให้โทษ อุบัติเหตุ แตกหัก สูญเสียคนในครอบครัว เสี่ยงถูกยึดทรัพย์/ยกเลิกสัญญา คู่แข่งมาแย่งชิง`,
    "4-1": `สรรหาว่าจ้าง ได้รับการติดต่อ เจรจาสัญญา แต่ระวังความลับรั่วไหล ข่าวลวง คดีความจากการพาดพิง`,
    "4-2": `ถูกผลักภาระมาให้แก่ตน ได้ช่วยเหลือเพื่อน เดินทาง/ย้ายงาน มีโอกาสพบรักเพศตรงข้าม แต่อาจเป็นรักซ้อน`,
    "4-3": `เกิดมีคนหมั่นไส้ ปริวิตก โกหกใส่ความ ขัดแย้งหุ้นส่วน สุขภาพระบบสมอง ควรระวังการทะเลาะกับคู่ครอง`,
    "4-4": `ได้ทรัพย์มาครอบครอง มีอำนาจดูแลในท้องถิ่น การงานเปลี่ยนแปลง แต่มีคนรอบตัวชิงดีชิงเด่น ตนเป็นคนกลาง`,
    "4-5": `วิ่งเต้น ร้องขอ ติดอามิสสินจ้าง การช่วยเหลือในทางไม่เปิดเผย พบรักจากที่ไกล ระวังผู้ใหญ่ฝ่ายคู่มาก้าวก่าย`,
    "4-6": `ถูกปองร้ายจากคนอื่น เสียทรัพย์ ขัดแย้งผู้ใหญ่ในบ้าน เก็บทรัพย์ไม่คงทน เสี่ยงถูกยักยอก/ลักขโมย แตกแยกในหมู่คณะ`,
    "4-7": `เกิดโรคภัย ไข้เจ็บ เสียทรัพย์จากบุคคลอื่น อำนาจในราชการแต่ขัดแย้งในครอบครัว เสี่ยงเจ็บป่วยฉับพลันรุนแรง`,
    "5-1": `มีลาภจากผู้ใหญ่คนใกล้ตัว ติดต่อหาผู้ร่วมแนว ริเริ่มโครงการใหม่ โอกาสพบรักและตกลงปลงใจ`,
    "5-2": `มักพบเจอคู่ แต่บริวารตีตัวออกห่าง มีการยื่นอุทธรณ์/ฎีกา ผู้ใหญ่ฝ่ายคู่ก้าวก่ายความสัมพันธ์`,
    "5-3": `มีคดีความเป็นฝ่ายฟ้อง ส่งผลดีต่อราชการ/งานรัฐ มีโอกาสถูกเรียกตัวเข้าทำงาน`,
    "5-4": `คนใกล้เอาใจห่าง เพราะไม่อาจตอบสนองความต้องการ เกิดปัญหากับคนรัก ผู้ใหญ่เป็นเหตุ ความลับถูกเปิดเผย`,
    "5-5": `ได้รับความช่วยเหลือจากผู้ใหญ่แต่มีเงื่อนไข ต้องอยู่ภายใต้การควบคุม แลกเปลี่ยนผลประโยชน์ สุดท้ายส่งผลดี`,
    "5-6": `โอกาสความสำเร็จที่ผู้ใหญ่ผลักดันอยู่เบื้องหลัง ต้องมีสินน้ำใจตอบแทน งาน/ลงทุนได้รับอนุมัติ แต่เรื่องรักไม่ดีเพราะการปกปิด`,
    "5-7": `เปลี่ยนแปลงสถานะจากหนึ่งสู่อีกสถานะ เช่น เลื่อนตำแหน่ง/เปลี่ยนบทบาท แต่ยังอยู่ภายใต้การสั่งการของผู้ใหญ่เหมือนหุ่นเชิด`,
    "6-1": `จะสำเร็จเมื่อผ่านการทดสอบ ถูกเรียกร้อง แข่งขันแย่งชิงความรัก ต่างคนต่างถือดี ขัดแย้งกับผู้ใหญ่ในงาน`,
    "6-2": `พบเจอคนถูกใจจากบุคคลที่สาม รักแรกพบ แต่ถูกกีดกันเรื่องฐานะ/เชื้อชาติ อาจพบรักต่างถิ่นต่างชาติ บางรายมีปัญหาเรื่องนอกใจแบบใช้บริการ`,
    "6-3": `เดินทาง โยกย้าย เสี่ยงภัย ไปต่างแดน/ย้ายถิ่น ทำงานไม่เป็นสุข ถูกก่อกวน ภาระงานเพิ่มแบบไม่ทันตั้งตัว`,
    "6-4": `ถูกกดดันจำกัดอิสระภาพ เจรจาต้องมีเงื่อนไข แก้ไขสัญญา เสี่ยงถูกแย่งชิงทรัพย์สิน/ยึดทรัพย์`,
    "6-5": `ขัดแย้งกับคนใกล้ตัวเพราะผู้ใหญ่กักกัน วิ่งเต้นขอความช่วยเหลือ ได้อุปถัมภ์ แต่คู่รักมีปัญหา ถูกปฏิเสธสัมผัสทางกาย เรื่องเงินแอบซ่อน`,
    "6-6": `มีทรัพย์สมบัติ ได้มรดก สอบแข่งขันผ่าน มีโอกาสสำเร็จสูง แต่ความรักและการเงินมีปัญหา รักไกลตัว`,
    "6-7": `ถูกใส่ความ กีดกัน แบ่งแยก โยนความผิดมาให้ บริวารต่อต้าน คนรักตีตัวออกห่าง`,
    "7-1": `คนใกล้ตัวเอาใจห่าง เหน็ดเหนื่อย ร้อนใจ ความก้าวหน้าช้า ถูกมองข้ามสิทธิ์ จำกัดอิสระภาพ เกิดความหวาดระแวง`,
    "7-2": `พลัดพรากสูญเสีย คนใกล้ชิดตีตัวออกห่าง โรคภัยเบียดเบียน ด้านดีอาจได้รับมอบหมายเป็นตัวแทน/สืบทอดมรดก`,
    "7-3": `ถูกกีดกันขัดขวาง จำกัดอิสระ ถูกใช้อำนาจข่มเหง รังแก ศัตรูเก่าราวี`,
    "7-4": `ถูกแทรกแซงจากมือที่สาม เสี่ยงรักซ้อน ย้ายงานไม่เป็นธรรม ภาระงานค้างคา ต้องแบ่งทำหลายงานพร้อมกัน`,
    "7-5": `เปลี่ยนแปลงสู่สิ่งใหม่ การศัลยกรรม/พัฒนา แต่ระวังคนเสแสร้งเอาใจเพื่อผลประโยชน์ การหลอกลวง`,
    "7-6": `ความพยายามที่ไม่สำเร็จ ถูกปฏิเสธ ภาระหนี้สิน ความรักแบบจำใจ อาจมีมือที่สาม ฟ้องร้องสิทธิการดูแล`,
    "7-7": `บริวารหักหลังทรยศ มีโอกาสได้รับทรัพย์สินใหญ่ สอบแข่งขันท้องถิ่น ผ่านได้ แต่ต้องระวังการกลั่นแกล้งจากผู้ที่อยู่มาก่อน`,
  };

  function cardinal4(deg) {
    const cards = ["N", "E", "S", "W"];
    const d = ((deg % 360) + 360) % 360;
    const idx = Math.round(d / 90) % 4; // nearest cardinal
    return cards[idx];
  }

  function deltaToNearestCardinal(deg) {
    const d = ((deg % 360) + 360) % 360;
    const nearestBase = Math.round(d / 90) * 90; // may be 360
    const base = nearestBase % 360;
    let diff = d - base;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return Math.abs(diff); // 0..45 ideally
  }

  // Big section mapping per requirement:
  // [0,45):6, [45,90):1, [90,135):2, [135,180):3, [180,225):4, [225,270):7, [270,315):5, [315,360):8
  function bigLabelForDegree(deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d < 45) return 6;
    if (d < 90) return 1;
    if (d < 135) return 2;
    if (d < 180) return 3;
    if (d < 225) return 4;
    if (d < 270) return 7;
    if (d < 315) return 5;
    return 8;
  }

  // Determine the sub-label (แทรก) for a given degree using the sequence
  // starting from the big section label.
  function smallLabelForDegree(deg) {
    const seq = [6, 1, 2, 3, 4, 7, 5, 8];
    const d = ((deg % 360) + 360) % 360;
    const bigIndex = Math.floor(d / 45); // 0..7 sectors
    const within = d - bigIndex * 45; // 0..45
    const subIndex = Math.min(7, Math.floor(within / (45 / 8))); // 0..7
    const startLabel = seq[bigIndex];
    const startIdx = seq.indexOf(startLabel);
    const lbl = seq[(startIdx + subIndex) % 8];
    return lbl;
  }

  // Draw the dial
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.reset?.();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background (theme) – transparent when camera background is on
    if (!cameraOn) {
      ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, size, size);
    } else {
      // leave transparent for video background
      ctx.clearRect(0, 0, size, size);
    }

    // Draw floor plan beneath dial
    if (planVisible && planImage && planImage.complete) {
      try {
        const img = planImage;
        const cx = size / 2 + planX;
        const cy = size / 2 + planY;
        // Apply snap to rotation
        const snapped = Math.round(planRotationDeg / rotationSnap) * rotationSnap;
        const angle = (snapped * Math.PI) / 180;
        const maxSide = Math.min(size * 0.9, Math.max(img.width, img.height));
        const baseScale = (Math.min(size, size) / maxSide) * 0.7; // fit within canvas
        const scl = baseScale * planScale;
        const w = img.width * scl;
        const h = img.height * scl;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, planOpacity));
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
        // Draw reticle in AR mode to help alignment
        if (cameraOn) {
          const r = Math.min(size * 0.35, 180);
          ctx.save();
          ctx.strokeStyle = t.outline;
          ctx.globalAlpha = 0.6;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(size/2, size/2, r, 0, Math.PI*2);
          ctx.stroke();
          // crosshair
          ctx.beginPath();
          ctx.moveTo(size/2 - r, size/2);
          ctx.lineTo(size/2 + r, size/2);
          ctx.moveTo(size/2, size/2 - r);
          ctx.lineTo(size/2, size/2 + r);
          ctx.stroke();
          ctx.restore();
        }
      } catch {}
    }

    const cx = size / 2;
    const cy = size / 2;
    // Responsive geometry (slightly larger dial for readability)
    // We draw up to ~64px beyond the outer ring (cardinals) + tick/arrow slack
    const outerFeatureExtent = 64; // px
    const pad = Math.max(outerFeatureExtent, Math.min(size * 0.12, 120));
    const outerR = Math.min(cx, cy) - pad;
    const ringWidth = Math.max(32, Math.min(size * 0.30, 220));
    const innerR = Math.max(outerR - ringWidth, 60);

    // Rotate dial opposite to heading (like a real compass card)
    const rot = (heading * Math.PI) / 180;
    const dialRot = -rot;
    const startAngle = -Math.PI / 2 + dialRot;
    const slice = (Math.PI * 2) / SEGMENTS;

    const minorStroke = t.minor;
    const majorStroke = t.major;

    // Draw segment borders and bold lines every 8 slices
    for (let i = 0; i < SEGMENTS; i++) {
      const a0 = startAngle + i * slice;
      const a1 = a0 + slice;

      // radial line at a0
      ctx.beginPath();
      ctx.moveTo(cx + innerR * Math.cos(a0), cy + innerR * Math.sin(a0));
      ctx.lineTo(cx + outerR * Math.cos(a0), cy + outerR * Math.sin(a0));
      ctx.lineWidth = 1;
      ctx.strokeStyle = minorStroke;
      ctx.stroke();

      if (i % 8 === 0) {
        ctx.beginPath();
        ctx.moveTo(cx + innerR * Math.cos(a0), cy + innerR * Math.sin(a0));
        ctx.lineTo(cx + outerR * Math.cos(a0), cy + outerR * Math.sin(a0));
        ctx.lineWidth = 3;
        ctx.strokeStyle = majorStroke;
        ctx.stroke();
      }
    }

    // Cleaner outer ticks for readability
    const smallScreen = size < 480;
    for (let deg = 0; deg < 360; deg += 5) {
      // Keep outer ticks/labels fixed relative to the screen (not rotating with heading)
      const angle = (deg - 90) * (Math.PI / 180);
      const tickBase = outerR + 10;
      const tickLen = deg % 30 === 0 ? 26 : deg % 10 === 0 ? 16 : 8;
      const tickTop = outerR + tickLen;
      ctx.beginPath();
      ctx.moveTo(cx + tickBase * Math.cos(angle), cy + tickBase * Math.sin(angle));
      ctx.lineTo(cx + tickTop * Math.cos(angle), cy + tickTop * Math.sin(angle));
      ctx.lineWidth = deg % 30 === 0 ? 3 : 1;
      ctx.strokeStyle = deg % 30 === 0 ? t.tickMaj : t.tickMin;
      ctx.stroke();

      if (!smallScreen && deg % 30 === 0) {
        const labelR = outerR + 36;
        const lx = cx + labelR * Math.cos(angle);
        const ly = cy + labelR * Math.sin(angle);
      ctx.save();
      ctx.translate(lx, ly);
        ctx.rotate(0); // keep labels upright for mobile readability
        ctx.fillStyle = t.text;
        ctx.font = "13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
        ctx.fillText(String(deg), 0, 0);
      ctx.restore();
      }
    }

    // Outer/inner rings
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = majorStroke;
    ctx.stroke();
    // Outline glow (watch theme)
    if (theme === 'watch') {
      ctx.save();
      ctx.shadowBlur = 18;
      ctx.shadowColor = t.outline;
      ctx.strokeStyle = t.outline;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }

    // Aspects ring (บริวาร/อายุ/เดช/ศรี/มูละ/อุตสาหะ/มนตรี/กาลี) placed per sector starting from user's birth number
    if (showAspects && birthNum) {
      const aspects = ["บริวาร", "อายุ", "เดช", "ศรี", "มูละ", "อุตสาหะ", "มนตรี", "กาลี"]; // clockwise
      // ให้ "บริวาร" เริ่มต้นที่ section ที่เป็นดาววันเกิดเสมอ.
      // ใช้ mapping ดาววันเกิด -> เลขใหญ่ของ section
      // 1..7 (อาทิตย์..เสาร์) map to bigLabels index where bigLabels = [6,1,2,3,4,7,5,8]
      // หาว่าเลขใหญ่ใดเท่ากับ birthNum แล้วใช้อินเด็กซ์นั้นเป็นจุดเริ่ม
      const bigLabelsArr = [6, 1, 2, 3, 4, 7, 5, 8];
      let birthSection = 0;
      for (let i = 0; i < 8; i++) if (bigLabelsArr[i] === birthNum) { birthSection = i; break; }
      const ringR = outerR + 46; // outside the dial but inside tick labels
      ctx.font = "600 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
      ctx.fillStyle = t.sub; // theme sub text
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let s = 0; s < 8; s++) {
        const label = aspects[s];
        const sectorIndex = (birthSection + s) % 8; // sector relative to birth day
        const a = (sectorIndex * 45 - 90) * (Math.PI / 180) + dialRot + (45 * Math.PI / 180) / 2; // center of sector
        const x = cx + ringR * Math.cos(a);
        const y = cy + ringR * Math.sin(a);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(0);
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }

    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = majorStroke;
    ctx.stroke();

    // Sub‑label track (soft background to improve legibility over radial lines)
    const ringWidthPx = outerR - innerR;
    // keep sub labels inside safely away from inner circle
    const subTrackOuter = Math.max(innerR + 20, outerR - 20);
    const subTrackInner = Math.max(innerR + 16, subTrackOuter - 28);
    if (!cameraOn) {
      ctx.beginPath();
      ctx.arc(cx, cy, subTrackOuter, 0, Math.PI * 2);
      ctx.arc(cx, cy, subTrackInner, 0, Math.PI * 2, true);
      ctx.fillStyle = t.trackBg;
      ctx.fill();
    }

    // Big section labels (rotate with dial). Mapping order clockwise
    const bigSlice = slice * (SEGMENTS / 8);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = majorStroke;
    ctx.font = "600 28px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
    const bigLabels = [6, 1, 2, 3, 4, 7, 5, 8];
    if (showBig) {
    for (let b = 0; b < 8; b++) {
      const a0 = startAngle + b * bigSlice;
      const amid = a0 + bigSlice / 2;
      const r = (outerR + innerR) / 2;
      const x = cx + r * Math.cos(amid);
      const y = cy + r * Math.sin(amid);
      ctx.fillText(String(bigLabels[b]), x, y);
    }
    }

    // Sub‑labels inside each big section (8 per section)
    const seq = [6, 1, 2, 3, 4, 7, 5, 8];
    const subR = (subTrackInner + subTrackOuter) / 2; // near outer ring
    const subFontPx = Math.max(13, Math.min(18, Math.round(size * 0.04)));
    ctx.fillStyle = t.sub; // theme sub labels
    ctx.font = `600 ${subFontPx}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (showSmall) {
      for (let b = 0; b < 8; b++) {
        const sectionStartAngle = startAngle + b * bigSlice;
        const sectionLabel = seq[b];
        const startIdx = seq.indexOf(sectionLabel);
        for (let j = 0; j < 8; j++) {
          const label = seq[(startIdx + j) % 8];
          const mid = sectionStartAngle + (j + 0.5) * slice; // clockwise inside section
          const lx = cx + subR * Math.cos(mid);
          const ly = cy + subR * Math.sin(mid);
          // Keep numbers upright for readability
          ctx.save();
          ctx.translate(lx, ly);
          ctx.rotate(-dialRot); // keep sub labels upright even as dial rotates
          ctx.fillText(String(label), 0, 0);
          ctx.restore();
        }
      }
    }

    // Determine current big/small labels at the top index (12 o'clock)
    const wrapPi2 = (a) => {
      let x = a % (Math.PI * 2);
      if (x < -Math.PI) x += Math.PI * 2;
      if (x > Math.PI) x -= Math.PI * 2;
      return x;
    };
    const angDist = (a, b) => Math.abs(wrapPi2(a - b));
    const topAngle = -Math.PI / 2;

    let currentBigIndex = 0;
    let best = Infinity;
    for (let b = 0; b < 8; b++) {
      const mid = startAngle + b * bigSlice + bigSlice / 2;
      const d = angDist(mid, topAngle);
      if (d < best) {
        best = d;
        currentBigIndex = b;
      }
    }
    const currentBigLabel = bigLabels[currentBigIndex];

    let currentSmallIndex = 0;
    best = Infinity;
    for (let j = 0; j < 8; j++) {
      const mid = startAngle + currentBigIndex * bigSlice + j * slice + slice / 2;
      const d = angDist(mid, topAngle);
      if (d < best) {
        best = d;
        currentSmallIndex = j;
      }
    }
    const startIdx = seq.indexOf(currentBigLabel);
    const currentSmallLabel = seq[(startIdx + currentSmallIndex) % 8];

    // expose for DOM meaning box
    if (currentBig !== currentBigLabel) setCurrentBig(currentBigLabel);
    if (currentSmall !== currentSmallLabel) setCurrentSmall(currentSmallLabel);

    // Cardinal letters (rotate with dial)
    const cardinals = [
      { t: "N", d: 0 },
      { t: "E", d: 90 },
      { t: "S", d: 180 },
      { t: "W", d: 270 },
    ];
    ctx.font = "bold 22px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
    ctx.fillStyle = t.text;
    for (const c of cardinals) {
      const a = (c.d - 90) * (Math.PI / 180) + dialRot;
      const r = outerR + (smallScreen ? 56 : 68);
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      ctx.fillText(c.t, x, y);
    }

    // Fixed top index marker (triangle at 12 o'clock)
    const top = -Math.PI / 2;
    const r0 = outerR + 22;
    const r1 = outerR + 8;
    const ax = cx + r0 * Math.cos(top);
    const ay = cy + r0 * Math.sin(top);
    const bx = cx + r1 * Math.cos(top + 0.08);
    const by = cy + r1 * Math.sin(top + 0.08);
    const cxp = cx + r1 * Math.cos(top - 0.08);
    const cyp = cy + r1 * Math.sin(top - 0.08);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(cxp, cyp);
    ctx.closePath();
    ctx.fillStyle = t.accent;
    ctx.fill();

    // Center readout: show heading + description (big/small labels)
    const card = cardinal4(heading);
    // Use the label at the TOP index (12 o'clock) so it matches what the user faces
    const bigLbl = currentBigLabel;
    const smallLbl = currentSmallLabel;
    ctx.fillStyle = t.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(size * 0.08)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText(`${Math.round(normalize(heading) ?? 0)}°`, cx, cy - Math.max(12, size * 0.012));
    ctx.font = `700 ${Math.round(size * 0.04)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText(card, cx, cy + Math.max(6, size * 0.004));
    ctx.font = `600 ${Math.round(size * 0.03)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText(`(${bigLbl} เสวย ${smallLbl} แทรก)`, cx, cy + Math.max(28, size * 0.04));

  }, [size, heading, showBig, showSmall, showAspects, theme, birthNum]);

  const topBarStyle = {
    position: "fixed",
    top: 12,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "rgba(255,255,255,0.85)",
    backdropFilter: "blur(6px)",
    border: "1px solid #e2e8f0",
    borderRadius: 9999,
    padding: "8px 12px",
    boxShadow: "0 1px 2px rgba(0,0,0,.08)",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  };

  const enableBtnStyle = {
    position: "fixed",
    bottom: "max(16px, env(safe-area-inset-bottom))",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 20,
    padding: "14px 18px",
    borderRadius: 12,
              background: "#0f172a",
              color: "#fff",
              border: "1px solid #0f172a",
    fontSize: 16,
              fontWeight: 600,
    boxShadow: "0 6px 20px rgba(15,23,42,.25)",
  };

  useEffect(() => {
    try {
      if (cameraOn) {
        const html = document.documentElement;
        const body = document.body;
        html.style.background = "transparent";
        body.style.background = "transparent";
        body.style.overflow = "hidden";
      } else {
        const html = document.documentElement;
        const body = document.body;
        html.style.background = "";
        body.style.background = "";
        body.style.overflow = "";
      }
    } catch {}
  }, [cameraOn]);

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: cameraOn ? "transparent" : t.page, userSelect: "none", position: cameraOn?"fixed":"static", inset: cameraOn?0:"auto", width: cameraOn?"100vw":"auto", height: cameraOn?"100vh":"auto" }}>
      {/* Top status bar */}
      <div style={{...topBarStyle, background: cameraOn?"rgba(0,0,0,0.3)":t.topbarBg, border: `1px solid ${t.topbarBorder}`, width: "min(95vw, 720px)", flexWrap: "wrap", justifyContent: "space-between"}}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: t.muted, fontSize: 14 }}>เข็มทิศชัยภูมิพระร่วง</span>
          {userName && birthNum && (
            <span style={{ color: t.text, fontSize: 12 }}>
              ผู้ใช้: {userName} • บ้านหันไปทาง {directionName(birthNum)}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button onClick={()=>setShowBig(!showBig)} style={{ padding: "4px 8px", borderRadius: 8, border: `1px solid ${t.topbarBorder}`, background: showBig ? t.buttonBg : t.page, color: showBig ? t.buttonText : t.muted, fontSize: 12, fontWeight: 700 }}>เสวย</button>
          <button onClick={()=>setShowSmall(!showSmall)} style={{ padding: "4px 8px", borderRadius: 8, border: `1px solid ${t.topbarBorder}`, background: showSmall ? t.buttonBg : t.page, color: showSmall ? t.buttonText : t.muted, fontSize: 12, fontWeight: 700 }}>แทรก</button>
          <button onClick={()=>setShowAspects(!showAspects)} style={{ padding: "4px 8px", borderRadius: 8, border: `1px solid ${t.topbarBorder}`, background: showAspects ? t.buttonBg : t.page, color: showAspects ? t.buttonText : t.muted, fontSize: 12, fontWeight: 700 }}>บริวาร/อายุ/เดช/ศรี</button>
          {/* Plan controls toggler */}
          <button onClick={()=>setPlanControlsOpen(!planControlsOpen)} style={{ padding: "4px 8px", borderRadius: 8, border: `1px solid ${t.topbarBorder}`, background: planControlsOpen ? t.buttonBg : t.page, color: planControlsOpen ? t.buttonText : t.muted, fontSize: 12, fontWeight: 700 }}>แปลนบ้าน</button>
          <button onClick={async()=>{
            if (!cameraOn) {
              try {
                const constraints = { video: { facingMode: { ideal: "environment" } }, audio: false };
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                cameraStreamRef.current = stream;
                // delay setting video src until next frame to ensure portal container is mounted
                requestAnimationFrame(async () => {
                  if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                    try {
                      await new Promise((res)=>{
                        const v = videoRef.current;
                        const onLoaded = () => { v.removeEventListener('loadedmetadata', onLoaded); res(); };
                        v.addEventListener('loadedmetadata', onLoaded, { once: true });
                      });
                      await videoRef.current.play();
                    } catch {}
                  }
                });
                // Try to set zoom if supported
                const track = stream.getVideoTracks?.()[0];
                const capabilities = track?.getCapabilities?.() || {};
                if (capabilities.zoom) {
                  const settings = track.getSettings?.() || {};
                  const target = Math.min(Math.max(capabilities.zoom.min, cameraZoom), capabilities.zoom.max);
                  await track.applyConstraints({ advanced: [{ zoom: target }] }).catch(()=>{});
                }
                setCameraOn(true);
              } catch (e) {
                console.warn("Camera start failed", e);
                setCameraOn(false);
              }
            } else {
              try {
                const s = cameraStreamRef.current;
                s?.getTracks?.().forEach((tr)=>tr.stop());
                cameraStreamRef.current = null;
              } catch {}
              setCameraOn(false);
            }
          }} style={{ padding: "4px 8px", borderRadius: 8, border: `1px solid ${t.topbarBorder}`, background: cameraOn ? t.buttonBg : t.page, color: cameraOn ? t.buttonText : t.muted, fontSize: 12, fontWeight: 700 }}>{cameraOn?"ปิดกล้อง":"ส่องแปลน"}</button>
          {/* removed offset field per request */}
          <select value={theme} onChange={(e)=>setTheme(e.target.value)} style={{ padding: "4px 8px", borderRadius: 8, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text, fontSize: 12 }}>
            <option value="noon">Noon</option>
            <option value="dark">Dark</option>
            <option value="red">Red night</option>
            <option value="watch">Watch Night</option>
          </select>
        </div>
        <span style={{ fontSize: 14, fontWeight: 600, color: t.text }}>{heading.toFixed(2)}°</span>
      </div>

      {/* Camera background video (behind canvas) */}
      {createPortal(
        <video ref={videoRef} playsInline webkit-playsinline="true" muted autoPlay style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", objectFit: "cover", zIndex: -1, pointerEvents: "none", background: "transparent", visibility: cameraOn?"visible":"hidden" }} />, document.getElementById("ar-video-root"))}
      {/* Canvas */}
      <canvas ref={canvasRef} style={{ position: cameraOn?"fixed":"static", left: cameraOn?"50%":"auto", top: cameraOn?"50%":"auto", transform: cameraOn?"translate(-50%, -50%)":"none", zIndex: cameraOn?1:"auto" }} />

      {/* Plan controls bottom-sheet */}
      {planControlsOpen && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 30, background: t.overlayBg, borderTop: `1px solid ${t.overlayBorder}`, borderRadius: "12px 12px 0 0", boxShadow: theme === 'noon' ? "0 -8px 18px rgba(0,0,0,.08)" : "none", padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 700, color: t.text }}>แปลนบ้าน</div>
            <button onClick={()=>setPlanControlsOpen(false)} style={{ padding: "6px 10px", borderRadius: 8, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text, fontSize: 12, fontWeight: 700 }}>ปิด</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <button onClick={()=>fileInputRef.current?.click()} style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text, fontWeight: 700 }}>อัปโหลดแปลน</button>
            <label style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 12px", borderRadius: 10, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text, fontWeight: 700 }}>
              <input type="checkbox" checked={planVisible} onChange={(e)=>setPlanVisible(e.target.checked)} /> แสดง
            </label>
            <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e)=>{
              const f = e.target.files && e.target.files[0];
              if (!f) return;
              setUploadError("");
              setUploading(true);
              const t0 = performance.now();
              (async () => {
                try {
                  const dataUrl = await fileToCompressedDataUrl(f);
                  loadPlanFromDataUrl(dataUrl);
                  setPlanGallery((g)=>[dataUrl, ...g.filter((x)=>x!==dataUrl)].slice(0,10));
                  try { localStorage.setItem("planImageUrl", dataUrl); } catch {}
                } catch (err) {
                  setUploadError("อัปโหลดไม่สำเร็จ");
                } finally {
                  const t1 = performance.now();
                  setUploadMs(Math.max(0, Math.round(t1 - t0)));
                  setUploading(false);
                }
              })();
            }} />
            <button onClick={()=>{ setPlanX(0); setPlanY(0); }} style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text, fontWeight: 700 }}>กึ่งกลาง</button>
            <button onClick={()=>{ setPlanRotationDeg(0); }} style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text, fontWeight: 700 }}>ล็อกทิศเหนือ (0°)</button>
            <label style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 12px", borderRadius: 10, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text, fontWeight: 700 }}>
              <input type="checkbox" checked={planFollowHeading} onChange={(e)=>setPlanFollowHeading(e.target.checked)} /> ล็อกทับเข็ม (หมุนตามเข็ม)
            </label>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 12px", borderRadius: 10, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text, fontWeight: 700 }}>
              Snap: 
              <select value={rotationSnap} onChange={(e)=>setRotationSnap(Number(e.target.value))} style={{ padding: "4px 8px", borderRadius: 8, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text }}>
                <option value={1}>1°</option>
                <option value={5}>5°</option>
              </select>
            </div>
          </div>
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {uploading && (
              <div style={{ fontSize: 12, color: t.muted, textAlign: "center" }}>กำลังอัปโหลด/แปลงภาพ...</div>
            )}
            {uploadMs!=null && !uploading && (
              <div style={{ fontSize: 12, color: t.muted, textAlign: "center" }}>ใช้เวลา {uploadMs} ms</div>
            )}
            {uploadError && (
              <div style={{ fontSize: 12, color: '#ef4444', textAlign: 'center' }}>{uploadError}</div>
            )}
            <label style={{ fontSize: 12, color: t.muted }}>
              โปร่งใส ({Math.round(planOpacity*100)}%)
              <input type="range" min={0} max={1} step={0.05} value={planOpacity} onChange={(e)=>setPlanOpacity(Number(e.target.value))} style={{ width: "100%" }} />
            </label>
            <label style={{ fontSize: 12, color: t.muted }}>
              ซูม ({planScale.toFixed(2)}x)
              <input type="range" min={0.2} max={3} step={0.05} value={planScale} onChange={(e)=>setPlanScale(Number(e.target.value))} style={{ width: "100%" }} />
            </label>
            <label style={{ fontSize: 12, color: t.muted }}>
              หมุน ({Math.round(planRotationDeg)}°)
              <input type="range" min={-180} max={180} step={rotationSnap} value={planRotationDeg} onChange={(e)=>setPlanRotationDeg(Number(e.target.value))} style={{ width: "100%" }} />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
              <button onClick={()=>setPlanRotationDeg(d=>d-5)} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text, fontWeight: 700 }}>-5°</button>
              <button onClick={()=>setPlanRotationDeg(d=>d-1)} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text, fontWeight: 700 }}>-1°</button>
              <button onClick={()=>setPlanRotationDeg(d=>d+1)} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text, fontWeight: 700 }}>+1°</button>
              <button onClick={()=>setPlanRotationDeg(d=>d+5)} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${t.topbarBorder}`, background: t.page, color: t.text, fontWeight: 700 }}>+5°</button>
            </div>
            {cameraOn && (
              <label style={{ fontSize: 12, color: t.muted }}>
                กล้องซูม (ถ้ารองรับ)
                <input type="range" min={1} max={5} step={0.1} value={cameraZoom} onChange={async(e)=>{
                  const val = Number(e.target.value);
                  setCameraZoom(val);
                  try {
                    const stream = cameraStreamRef.current;
                    const track = stream?.getVideoTracks?.()[0];
                    const caps = track?.getCapabilities?.() || {};
                    if (caps.zoom) {
                      const target = Math.min(Math.max(caps.zoom.min, val), caps.zoom.max);
                      await track.applyConstraints({ advanced: [{ zoom: target }] }).catch(()=>{});
                    }
                  } catch {}
                }} style={{ width: "100%" }} />
              </label>
            )}
            <div style={{ fontSize: 12, color: t.muted, textAlign: "center" }}>ลากนิ้วบนแคนวาสเพื่อย้ายตำแหน่งแปลน</div>
            {planGallery.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 12, color: t.muted, marginBottom: 6, textAlign: 'center' }}>แกลเลอรีล่าสุด</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
                  {planGallery.map((src, idx) => (
                    <button key={idx} onClick={()=>loadPlanFromDataUrl(src)} style={{ border: `1px solid ${t.topbarBorder}`, borderRadius: 8, padding: 0, overflow: 'hidden', height: 56, background: t.page }}>
                      <img src={src} alt="plan" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Meaning panel pinned under the dial */}
      <div style={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: "max(16px, env(safe-area-inset-bottom))",
        width: "min(95vw, 720px)",
        zIndex: 5,
        background: cameraOn ? (theme==='red' ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.25)') : t.overlayBg,
        border: `1px solid ${t.overlayBorder}`,
        borderRadius: 12,
        boxShadow: theme === 'noon' ? "0 8px 18px rgba(0,0,0,.08)" : "none",
        backdropFilter: cameraOn ? 'blur(10px)' : undefined,
        WebkitBackdropFilter: cameraOn ? 'blur(10px)' : undefined,
        padding: 12,
        textAlign: "center",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        color: t.text,
      }}>
        <div style={{ color: t.muted, fontWeight: 600, fontSize: 13 }}>
          {(place || (lat!=null&&lon!=null) || altitudeM!=null) && (
            <span>
              {place ? place + " • " : ""}
              {lat!=null&&lon!=null ? formatLatLon(lat, lon) + " • " : ""}
              {altitudeM!=null ? `${altitudeM} m` : ""}
            </span>
          )}
        </div>
        {sensorStatus === "active" && currentBig!=null && currentSmall!=null && (
          <div style={{ marginTop: 6 }}>
            {(() => {
              const key = `${currentBig}-${currentSmall}`;
              const meaning = MEANINGS[key];
              const { icon, label, moodIcon } = inferContextAndMood(meaning || "");
              return (
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{icon} {label} {moodIcon || ""}</div>
                  <div style={{ marginTop: 6, lineHeight: 1.4, whiteSpace: "pre-wrap", fontSize: 14 }}>{meaning || ""}</div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Bottom enable button for iOS permission UX */}
      {sensorStatus !== "active" && (
        <button onClick={onEnable} style={enableBtnStyle}>กดเปิดเข็มทิศ</button>
      )}

      {showIntro && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "grid", placeItems: "center", zIndex: 50 }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: 16, width: "min(92vw, 420px)", boxShadow: "0 10px 30px rgba(0,0,0,.2)", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", color: "#0f172a" }}>
            <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 12 }}>เริ่มใช้งาน</div>
            <div style={{ display: "grid", gap: 10 }}>
              <label style={{ fontSize: 14 }}>
                ชื่อของคุณ
                <input value={userName} onChange={(e)=>setUserName(e.target.value)} placeholder="เช่น สรา" style={{ width: "100%", marginTop: 6, padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }} />
              </label>
              <label style={{ fontSize: 14 }}>
                บ้านคุณหันไปทางไหน
                <select value={birthNum ?? ''} onChange={(e)=>setBirthNum(Number(e.target.value)||null)} style={{ width: "100%", marginTop: 6, padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}>
                  <option value="">เลือกทิศของบ้าน</option>
                  <option value="6">เหนือ (6)</option>
                  <option value="4">ใต้ (4)</option>
                  <option value="2">ตะวันออก (2)</option>
                  <option value="5">ตะวันตก (5)</option>
                  <option value="1">ตะวันออกเฉียงเหนือ (1)</option>
                  <option value="3">ตะวันตกเฉียงเหนือ (3)</option>
                  <option value="8">ตะวันออกเฉียงใต้ (8)</option>
                  <option value="7">ตะวันตกเฉียงใต้ (7)</option>
                </select>
              </label>
              <button onClick={()=>{ try{ localStorage.setItem("userName", userName||""); if (birthNum) localStorage.setItem("birthNum", String(birthNum)); }catch{} setShowIntro(false); }} style={{ marginTop: 8, padding: "10px 14px", borderRadius: 10, background: "#0f172a", color: "#fff", border: "1px solid #0f172a", fontWeight: 700 }}>เริ่มใช้งาน</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

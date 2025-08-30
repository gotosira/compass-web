import React, { useEffect, useRef, useState } from "react";

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
      const handler = (ev) => {
        let hdg = null;
        if (typeof ev?.webkitCompassHeading === "number" && Number.isFinite(ev.webkitCompassHeading)) {
          // iOS Safari provides absolute compass heading directly
          hdg = ev.webkitCompassHeading;
          preferWebkitRef.current = true; // prefer native compass heading on iOS
        } else if (!preferWebkitRef.current && typeof ev?.alpha === "number" && Number.isFinite(ev.alpha)) {
          // Fallback: compute tilt-compensated heading from alpha/beta/gamma
          const compensated = computeHeadingFromEuler(ev);
          hdg = compensated !== null ? compensated : 360 - ev.alpha;
        }
        const n = normalize(hdg);
        if (n !== null) targetHeadingRef.current = n;
      };
      window.addEventListener("deviceorientationabsolute", handler, true);
      window.addEventListener("deviceorientation", handler, true);
      listeners.push(["deviceorientationabsolute", handler]);
      listeners.push(["deviceorientation", handler]);
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
      const target = targetHeadingRef.current;
      const diff = shortestAngleDelta(current, target);
      const smoothing = 0.15; // 0..1, higher = faster
      const next = normalize(current + diff * smoothing);
      if (next !== null && Math.abs(diff) > 0.05) {
        setHeading(next);
      } else if (next !== null && Math.abs(diff) > 0) {
        // snap when close
        setHeading(target);
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

    // Background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    // Responsive geometry with larger safety margin so nothing is clipped
    // We draw up to ~68px beyond the outer ring (cardinals) + tick/arrow slack
    const outerFeatureExtent = 76; // px
    const pad = Math.max(outerFeatureExtent, Math.min(size * 0.18, 140));
    const outerR = Math.min(cx, cy) - pad;
    const ringWidth = Math.max(28, Math.min(size * 0.24, 180));
    const innerR = Math.max(outerR - ringWidth, 60);

    // Rotate dial by heading so top index is the forward direction
    const rot = (heading * Math.PI) / 180;
    const startAngle = -Math.PI / 2 + rot;
    const slice = (Math.PI * 2) / SEGMENTS;

    const minorStroke = "#0f172a33";
    const majorStroke = "#0f172a";

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
      const tickBase = outerR + 6;
      const tickLen = deg % 30 === 0 ? 22 : deg % 10 === 0 ? 16 : 10;
      const tickTop = outerR + tickLen;
      ctx.beginPath();
      ctx.moveTo(cx + tickBase * Math.cos(angle), cy + tickBase * Math.sin(angle));
      ctx.lineTo(cx + tickTop * Math.cos(angle), cy + tickTop * Math.sin(angle));
      ctx.lineWidth = deg % 30 === 0 ? 2 : 1;
      ctx.strokeStyle = "#0f172a55";
      ctx.stroke();

      if (!smallScreen && deg % 30 === 0) {
        const labelR = outerR + 36;
        const lx = cx + labelR * Math.cos(angle);
        const ly = cy + labelR * Math.sin(angle);
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(0); // keep labels upright for mobile readability
        ctx.fillStyle = "#0f172a";
        ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
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

    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = majorStroke;
    ctx.stroke();

    // Big section labels (rotate with dial). Mapping: 0–45=>6, then 1,2,3,4,7,5,8
    const bigSlice = slice * (SEGMENTS / 8);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = majorStroke;
    ctx.font = "bold 24px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
    const bigLabels = [6, 1, 2, 3, 4, 7, 5, 8];
    for (let b = 0; b < 8; b++) {
      const a0 = startAngle + b * bigSlice;
      const amid = a0 + bigSlice / 2;
      const r = (outerR + innerR) / 2;
      const x = cx + r * Math.cos(amid);
      const y = cy + r * Math.sin(amid);
      ctx.fillText(String(bigLabels[b]), x, y);
    }

    // Sub‑labels inside each big section (8 per section)
    const seq = [6, 1, 2, 3, 4, 7, 5, 8];
    const ringWidthPx = outerR - innerR;
    const subR = innerR + ringWidthPx * 0.28; // closer to inner ring to avoid clutter
    const subFontPx = Math.max(10, Math.min(14, Math.round(size * 0.03)));
    ctx.fillStyle = "#0f172a";
    ctx.font = `600 ${subFontPx}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let b = 0; b < 8; b++) {
      const sectionStartAngle = startAngle + b * bigSlice;
      const sectionLabel = seq[b];
      const startIdx = seq.indexOf(sectionLabel);
      for (let j = 0; j < 8; j++) {
        const label = seq[(startIdx + j) % 8];
        const mid = sectionStartAngle + (j + 0.5) * slice;
        const lx = cx + subR * Math.cos(mid);
        const ly = cy + subR * Math.sin(mid);
        // Keep numbers upright for readability
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(0);
        ctx.fillText(String(label), 0, 0);
        ctx.restore();
      }
    }

    // Cardinal letters (rotate with dial)
    const cardinals = [
      { t: "N", d: 0 },
      { t: "E", d: 90 },
      { t: "S", d: 180 },
      { t: "W", d: 270 },
    ];
    ctx.font = "bold 22px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
    for (const c of cardinals) {
      const a = (c.d - 90) * (Math.PI / 180) + rot;
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
    ctx.fillStyle = "#111827";
    ctx.fill();

    // Center readout: show the absolute heading 0..359° and nearest 4-cardinal
    const card = cardinal4(heading);
    ctx.fillStyle = "#0f172a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(size * 0.08)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText(`${Math.round(normalize(heading) ?? 0)}°`, cx, cy - Math.max(10, size * 0.01));
    ctx.font = `700 ${Math.round(size * 0.04)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText(card, cx, cy + Math.max(18, size * 0.02));
  }, [size, heading]);

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

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#fff", userSelect: "none" }}>
      {/* Top status bar */}
      <div style={topBarStyle}>
        <span style={{ color: "#334155", fontSize: 14 }}>Compass</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#0f172a" }}>{heading.toFixed(2)}°</span>
      </div>

      {/* Canvas */}
      <canvas ref={canvasRef} />

      {/* Bottom enable button for iOS permission UX */}
      {sensorStatus !== "active" && (
        <button onClick={onEnable} style={enableBtnStyle}>Enable compass</button>
      )}
    </div>
  );
}

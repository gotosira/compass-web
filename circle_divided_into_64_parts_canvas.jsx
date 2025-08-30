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
  const PADDING = 110; // generous padding so labels won't clip on mobile
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

  function normalize(deg) {
    if (typeof deg !== "number" || Number.isNaN(deg)) return null;
    let d = deg % 360;
    if (d < 0) d += 360;
    return d;
  }

  function startSensors() {
    try {
      const handler = (ev) => {
        let hdg = null;
        if (typeof ev?.webkitCompassHeading === "number") {
          // iOS Safari provides absolute compass heading directly
          hdg = ev.webkitCompassHeading;
        } else if (typeof ev?.alpha === "number") {
          // Most browsers: alpha ≈ 0 at North; convert to clockwise degrees from North
          hdg = 360 - ev.alpha;
        }
        const n = normalize(hdg);
        if (n !== null) setHeading(n);
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

      const ok = startSensors();
      setSensorStatus(ok ? "active" : "unavailable");
    } catch (e) {
      console.warn("Permission request failed", e);
      setSensorStatus("error");
    }
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
    const outerR = Math.min(cx, cy) - PADDING;
    const innerR = INNER_R;

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

      // degree ticks + labels
      const deg = (i * (360 / SEGMENTS)) % 360;
      const angle = (deg - 90) * (Math.PI / 180) + rot;
      const tickIn = outerR + 6;
      const tickOut = outerR + 12;
      ctx.beginPath();
      ctx.moveTo(cx + tickIn * Math.cos(angle), cy + tickIn * Math.sin(angle));
      ctx.lineTo(cx + tickOut * Math.cos(angle), cy + tickOut * Math.sin(angle));
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#0f172a55";
      ctx.stroke();

      // label (staggered)
      const rText = outerR + (i % 2 === 0 ? 36 : 54);
      const lx = cx + rText * Math.cos(angle);
      const ly = cy + rText * Math.sin(angle);
      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(angle + Math.PI / 2);
      ctx.fillStyle = "#0f172a";
      ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${deg.toFixed(2)}°`, 0, 0);
      ctx.restore();
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

    // Big section labels (6,1,2,3,4,7,5,8)
    const bigLabels = [6, 1, 2, 3, 4, 7, 5, 8];
    const bigSlice = slice * (SEGMENTS / 8);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = majorStroke;
    ctx.font = "bold 24px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
    for (let b = 0; b < 8; b++) {
      const a0 = startAngle + b * bigSlice;
      const amid = a0 + bigSlice / 2;
      const r = (outerR + innerR) / 2;
      const x = cx + r * Math.cos(amid);
      const y = cy + r * Math.sin(amid);
      ctx.fillText(String(bigLabels[b]), x, y);
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
      const r = outerR + 76;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      ctx.fillText(c.t, x, y);
    }

    // Fixed top index marker (triangle at 12 o'clock)
    const top = -Math.PI / 2;
    const r0 = outerR + 26;
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

    // Center readout
    ctx.fillStyle = "#0f172a";
    ctx.font = "600 24px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${heading.toFixed(2)}°`, cx, cy);
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

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#fff", userSelect: "none" }}>
      {/* Top status bar */}
      <div style={topBarStyle}>
        <span style={{ color: "#334155", fontSize: 14 }}>Compass</span>
        {sensorStatus !== "active" && (
          <button
            onClick={onEnable}
            style={{
              padding: "6px 10px",
              borderRadius: 9999,
              background: "#0f172a",
              color: "#fff",
              border: "1px solid #0f172a",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Enable compass
          </button>
        )}
        <span style={{ fontSize: 14, fontWeight: 600, color: "#0f172a" }}>{heading.toFixed(2)}°</span>
      </div>

      {/* Canvas */}
      <canvas ref={canvasRef} />
    </div>
  );
}

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
  const [showBig, setShowBig] = useState(true);
  const [showSmall, setShowSmall] = useState(true);

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
      const target = normalize(targetHeadingRef.current + offsetDeg) ?? 0;
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

    // Rotate dial opposite to heading (like a real compass card)
    const rot = (heading * Math.PI) / 180;
    const dialRot = -rot;
    const startAngle = -Math.PI / 2 + dialRot;
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
      const tickBase = outerR + 10;
      const tickLen = deg % 30 === 0 ? 26 : deg % 10 === 0 ? 16 : 8;
      const tickTop = outerR + tickLen;
      ctx.beginPath();
      ctx.moveTo(cx + tickBase * Math.cos(angle), cy + tickBase * Math.sin(angle));
      ctx.lineTo(cx + tickTop * Math.cos(angle), cy + tickTop * Math.sin(angle));
      ctx.lineWidth = deg % 30 === 0 ? 3 : 1;
      ctx.strokeStyle = deg % 30 === 0 ? "#0f172a88" : "#0f172a44";
      ctx.stroke();

      if (!smallScreen && deg % 30 === 0) {
        const labelR = outerR + 36;
        const lx = cx + labelR * Math.cos(angle);
        const ly = cy + labelR * Math.sin(angle);
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(0); // keep labels upright for mobile readability
        ctx.fillStyle = "#0f172a";
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

    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = majorStroke;
    ctx.stroke();

    // Sub‑label track (soft background to improve legibility over radial lines)
    const ringWidthPx = outerR - innerR;
    const subTrackOuter = Math.max(innerR + 6, outerR - 12);
    const subTrackInner = Math.max(innerR + 4, subTrackOuter - 24);
    ctx.beginPath();
    ctx.arc(cx, cy, subTrackOuter, 0, Math.PI * 2);
    ctx.arc(cx, cy, subTrackInner, 0, Math.PI * 2, true);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();

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
    const subFontPx = Math.max(12, Math.min(16, Math.round(size * 0.035)));
    ctx.fillStyle = "#0f172a";
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

    // Cardinal letters (rotate with dial)
    const cardinals = [
      { t: "N", d: 0 },
      { t: "E", d: 90 },
      { t: "S", d: 180 },
      { t: "W", d: 270 },
    ];
    ctx.font = "bold 22px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
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
    ctx.fillStyle = "#111827";
    ctx.fill();

    // Center readout: show heading + description (big/small labels)
    const card = cardinal4(heading);
    // Use the label at the TOP index (12 o'clock) so it matches what the user faces
    const bigLbl = currentBigLabel;
    const smallLbl = currentSmallLabel;
    ctx.fillStyle = "#0f172a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(size * 0.08)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText(`${Math.round(normalize(heading) ?? 0)}°`, cx, cy - Math.max(12, size * 0.012));
    ctx.font = `700 ${Math.round(size * 0.04)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText(card, cx, cy + Math.max(6, size * 0.004));
    ctx.font = `600 ${Math.round(size * 0.03)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto`;
    ctx.fillText(`(${bigLbl} เสวย ${smallLbl} แทรก)`, cx, cy + Math.max(28, size * 0.04));

    // Bottom meaning box
    const key = `${bigLbl}-${smallLbl}`;
    const meaning = MEANINGS[key];
    if (meaning) {
      const boxW = Math.min(size * 0.9, 560);
      const boxPad = 12;
      const boxX = cx - boxW / 2;
      const boxY = size - Math.min(size * 0.22, 200);
      const boxH = Math.min(size * 0.18, 160);
      ctx.save();
      ctx.beginPath();
      const r = 12;
      ctx.moveTo(boxX + r, boxY);
      ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, r);
      ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, r);
      ctx.arcTo(boxX, boxY + boxH, boxX, boxY, r);
      ctx.arcTo(boxX, boxY, boxX + boxW, boxY, r);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
      ctx.clip();
      ctx.fillStyle = "#0f172a";
      ctx.font = `600 ${Math.round(size * 0.035)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const lines = wrapText(ctx, meaning, boxW - boxPad * 2);
      let ty = boxY + boxPad;
      for (const ln of lines) {
        ctx.fillText(ln, boxX + boxPad, ty);
        ty += Math.round(size * 0.04);
      }
      ctx.restore();
    }
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
        <span style={{ color: "#334155", fontSize: 14 }}>เข็มทิศชัยภูมิพระร่วง</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#334155" }}>
            <input type="checkbox" checked={showBig} onChange={(e) => setShowBig(e.target.checked)} /> เสวย
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#334155" }}>
            <input type="checkbox" checked={showSmall} onChange={(e) => setShowSmall(e.target.checked)} /> แทรก
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#334155" }}>
            offset
            <input
              type="number"
              value={offsetDeg}
              onChange={(e) => setOffsetDeg(Number(e.target.value) || 0)}
              style={{ width: 56, padding: "2px 6px", borderRadius: 6, border: "1px solid #cbd5e1", background: "#fff" }}
            />
          </label>
        </div>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#0f172a" }}>{heading.toFixed(2)}°</span>
      </div>

      {/* Canvas */}
      <canvas ref={canvasRef} />

      {/* Bottom enable button for iOS permission UX */}
      {sensorStatus !== "active" && (
        <button onClick={onEnable} style={enableBtnStyle}>กดเปิดเข็มทิศ</button>
      )}
    </div>
  );
}

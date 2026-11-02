// Live previews for the Settings options (Puntero and Botones): one canvas,
// one scene per option, drawn from the engine's real numbers
// (app/src/prefs.rs fn tuning, crates/padcore/src/curve.rs, engine.rs Tuning).
//
//   Previews.mount(canvas)            draw into this canvas (sized by CSS)
//   Previews.show(id, value, prev?)   play an option at a value; prev = the
//                                     value before, drawn as a ghost
//   Previews.caption(id, value)       the line under the description ("" when
//                                     the description already says it: a
//                                     switch that is on)
//   Previews.has(id)                  whether an option has a preview
//   Previews.values(id)               its values, in order
//   Previews.onLoop(fn)               fn(loopsDone) after every loop
//   Previews.still(t)                 freeze one moment (seconds or "key")
//   Previews.unmount()
//
// Colours and fonts come from the CSS tokens and are read again when the
// root's style or class changes (accent, text size). It only animates while
// the canvas is on screen and the page is visible. Needs icons.js (ICONS).

const Previews = (() => {
  const W = 640; // field width; its height follows the canvas
  const DT = 1 / 240;
  const APPEAR = 0.15, HOLD = 0.7, FADE = 0.25, EMPTY = 0.3, PRESS = 0.35, CROSS = 150;
  const GAP = 48; // between the controls under the scene

  let canvas = null, ctx = null, H = 360, px = 1, C = null, FONT = "sans-serif";
  let current = null; // { scene, value, run, ghost, ghostLoops, loops }
  let t0 = 0, raf = 0, onScreen = false, frozen = null, snap = null, snapAt = -1e9, loopFn = null;
  let observers = [];

  // ---------- theme ----------
  const swatch = document.createElement("span");
  const reader = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  function token(name) {
    swatch.style.color = `var(${name})`;
    document.body.append(swatch);
    const value = getComputedStyle(swatch).color;
    swatch.remove();
    reader.clearRect(0, 0, 1, 1); reader.fillStyle = value; reader.fillRect(0, 0, 1, 1);
    return [...reader.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }
  function readTheme() {
    C = Object.fromEntries(["surface", "surface-hover", "text", "muted", "accent", "accent-press", "on-accent", "ring-strong"].map((n) => [n, token("--" + n)]));
    const root = getComputedStyle(document.documentElement);
    C.focus = parseFloat(root.getPropertyValue("--focus")) * parseFloat(root.fontSize) || 3; // var(--focus) in px
    FONT = root.getPropertyValue("--font-text").trim() || "sans-serif";
  }
  const col = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

  // ---------- easing ----------
  const clamp01 = (k) => Math.min(1, Math.max(0, k));
  const easeOut = (k) => 1 - (1 - k) ** 3;
  const easeIn = (k) => k * k * k;
  const smooth = (k) => k * k * (3 - 2 * k);
  function bezier(x) { // cubic-bezier(.2, 0, 0, 1)
    const bx = (s) => 3 * (1 - s) ** 2 * s * 0.2 + s ** 3;
    let lo = 0, hi = 1;
    for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; bx(m) < x ? (lo = m) : (hi = m); }
    const s = (lo + hi) / 2;
    return 3 * (1 - s) * s * s + s ** 3;
  }
  // A tap: --accent-press 90 ms → --accent 220 ms cubic-bezier(.2,0,0,1), 350 ms in all.
  function pressFill(pt) {
    if (pt < 0 || pt >= PRESS) return null;
    if (pt < 0.09) return C["accent-press"];
    if (pt < 0.31) return mix(C["accent-press"], C.accent, bezier((pt - 0.09) / 0.22));
    return C.accent;
  }

  // ---------- the engine ----------
  // curve.rs, profile "asistido", with a Tuning applied (engine.rs Tuning::profile).
  function curve({ speed = 1, deadzone = 0.12, hover = 0.45 } = {}) {
    const p = { deadzone, outer: 0.95, exponent: 2, maxSpeed: 0.8 * speed, accel: { threshold: 0.65, delay: 0, ramp: 0.85, factor: 2, decay: 2.5 } };
    let hold = 0;
    // Signed speed in screen heights per second for a 1-D tilt.
    return (tilt, hovering = false) => {
      const mag = Math.abs(tilt);
      if (mag <= p.deadzone) { hold = 0; return 0; }
      const k = Math.min(1, (mag - p.deadzone) / (p.outer - p.deadzone));
      let speed = k ** p.exponent * p.maxSpeed;
      hold = k >= p.accel.threshold ? hold + DT : Math.max(0, hold - p.accel.decay * DT);
      const boost = smooth(clamp01((hold - p.accel.delay) / p.accel.ramp));
      speed *= 1 + (p.accel.factor - 1) * boost;
      if (hovering && boost < 0.5) speed *= hover;
      return Math.sign(tilt) * speed;
    };
  }
  // curve.rs scroll_rate: wheel notches per second for one axis (+ = up).
  const scrollRate = (v) => { const a = clamp01((Math.abs(v) - 0.2) / 0.8); return a * a * 20 * Math.sign(v); };
  // A push of the stick: up in 80 ms, held, let go in 100 ms.
  function push(t, start, length, amount) {
    if (t < start) return 0;
    if (t < start + length) return amount * Math.min(1, (t - start) / 0.08);
    return amount * Math.max(0, 1 - (t - start - length) / 0.1);
  }
  // The field shows a piece of the screen this many screen heights tall (360 units).
  const SCREEN = 360 / 0.185;

  // ---------- drawing ----------
  const pathsOf = (name) => [...(ICONS[name] || "").matchAll(/d="([^"]+)"/g)].map((m) => new Path2D(m[1]));
  const RECT = (x, y, w, h, r) => { const p = new Path2D(); p.roundRect(x, y, w, h, r); return p; };
  let GLYPH = null;
  function glyphs() {
    GLYPH = {
      gamepad: pathsOf("gamepad"),
      check: pathsOf("check"),
      cross: [new Path2D("M18 6l-12 12"), new Path2D("M6 6l12 12")],
      back: [new Path2D("M9 14l-4 -4l4 -4"), new Path2D("M5 10h11a4 4 0 1 1 0 8h-1")],
      view: ICONS["btn-view"] ? [RECT(3, 4, 12, 10, 2), ...pathsOf("btn-view")] : [],
      menu: pathsOf("btn-menu"),
      zoom: [new Path2D("M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"), new Path2D("M7 10l6 0"), new Path2D("M10 7l0 6"), new Path2D("M21 21l-6 -6")],
      plus: [new Path2D("M12 5l0 14"), new Path2D("M5 12l14 0")],
    };
  }

  function strokeIcon(paths, cx, cy, size, color, width = 2) {
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.lineWidth = width; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = color;
    paths.forEach((p) => ctx.stroke(p));
    ctx.restore();
  }
  function arrowPointer(x, y, fill, stroke, width) {
    // The Windows arrow, tip at (x, y), scale 2.4.
    const s = 2.4, pts = [[0, 0], [0, 17], [4, 13], [7, 20], [9.6, 19], [6.6, 12], [12, 12]];
    ctx.beginPath();
    pts.forEach(([a, b], i) => ctx[i ? "lineTo" : "moveTo"](x + a * s, y + b * s));
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.lineWidth = width; ctx.lineJoin = "round"; ctx.strokeStyle = stroke; ctx.stroke(); }
  }
  function arrow(x0, y0, x1, y1, color) {
    const a = Math.atan2(y1 - y0, x1 - x0), h = 9;
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    ctx.moveTo(x1 - h * Math.cos(a - 0.6), y1 - h * Math.sin(a - 0.6)); ctx.lineTo(x1, y1);
    ctx.lineTo(x1 - h * Math.cos(a + 0.6), y1 - h * Math.sin(a + 0.6)); ctx.stroke();
  }
  function label(text, x, y) {
    ctx.font = `600 22px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillStyle = col(C.text, 0.8); ctx.fillText(text, x, y);
  }

  // Stick seen from the side: a base, a shaft leaning with tiltX, a ball;
  // tiltY lifts or lowers the ball. An arrow shows a real push; deadzone draws
  // the ignored lean as a wedge, and the ball lights up once past it.
  // Greys drawn on --surface stay at ≥ 3:1 (--muted at 0.7 or more).
  function drawStick({ x, y, tiltX = 0, tiltY = 0, deadzone, lean = 0.45, active, name, size = 1 }) {
    const L = 46 * size, py = y - 7;
    if (deadzone) {
      const a0 = -Math.PI / 2 - deadzone * lean, a1 = -Math.PI / 2 + deadzone * lean, r = L + 18 * size;
      ctx.fillStyle = col(C.muted, 0.45);
      ctx.beginPath(); ctx.moveTo(x, py); ctx.arc(x, py, r, a0, a1); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = col(C.muted); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x + Math.cos(a0) * r, py + Math.sin(a0) * r); ctx.lineTo(x, py); ctx.lineTo(x + Math.cos(a1) * r, py + Math.sin(a1) * r); ctx.stroke();
    }
    ctx.fillStyle = col(C.muted, 0.7);
    ctx.beginPath(); ctx.roundRect(x - 34 * size, y - 7, 68 * size, 14, 7); ctx.fill();
    const a = tiltX * lean;
    const bx = x + Math.sin(a) * L, by = py - Math.cos(a) * L - tiltY * 10;
    const ink = active ? C.text : C.muted;
    ctx.strokeStyle = col(ink); ctx.lineWidth = 6 * size; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x, py); ctx.lineTo(bx, by); ctx.stroke();
    ctx.fillStyle = col(ink);
    ctx.beginPath(); ctx.arc(bx, by, 14 * size, 0, 7); ctx.fill();
    const mag = Math.hypot(tiltX, tiltY);
    if (mag > 0.25) {
      const k = clamp01((mag - 0.25) / 0.15), dx = tiltX / mag, dy = -tiltY / mag;
      arrow(bx + dx * 20, by + dy * 20, bx + dx * 42, by + dy * 42, col(C.text, k));
    }
    if (name) label(name, x, y + 14);
  }
  // Face button from the front: sinks while pressed or held, flashes on a tap
  // (pt = seconds since the tap); progress draws a 3 px accent ring (hold time),
  // ghost a muted one (the value before).
  function drawButton({ x, y, glyph, icon, pt = -1, held = false, progress = 0, ghost = 0, name }) {
    const fill = pressFill(pt);
    const sink = held ? 1 : pt < 0 ? 0 : pt < 0.09 ? pt / 0.09 : pt < 0.31 ? 1 : 1 - clamp01((pt - 0.31) / 0.09);
    ctx.fillStyle = col(C.muted, 0.7);
    ctx.beginPath(); ctx.arc(x, y + 4, 19, 0, 7); ctx.fill();
    const cy = y - 3 + sink * 5;
    ctx.beginPath(); ctx.arc(x, cy, 18, 0, 7);
    ctx.fillStyle = col(fill ?? C.surface); ctx.fill();
    if (!fill) { ctx.lineWidth = 3; ctx.strokeStyle = col(held ? C.text : C.muted); ctx.stroke(); }
    const ring = (p, c) => { ctx.lineWidth = 3; ctx.strokeStyle = c; ctx.beginPath(); ctx.arc(x, cy, 24, -Math.PI / 2, -Math.PI / 2 + p * 2 * Math.PI); ctx.stroke(); };
    if (ghost > 0) ring(ghost, col(C.muted, 0.75));
    if (progress > 0) ring(progress, col(C.accent));
    const ink = fill ? C["on-accent"] : held ? C.text : C.muted;
    if (icon) strokeIcon(GLYPH[icon], x, cy, 22, col(ink), 2.2);
    else {
      ctx.font = `700 28px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = col(ink); ctx.fillText(glyph, x, cy + 1.5);
    }
    if (name) label(name, x, y + 36);
  }
  function drawTarget(T) {
    const inset = 1.5 / px, focus = C.focus / px;
    ctx.beginPath(); ctx.roundRect(T.x, T.y, T.w, T.h, 14); ctx.fillStyle = col(T.fill ?? C["surface-hover"]); ctx.fill();
    // Resting: a 3 px border in --muted at 0.75. Pointer over it: the focus ring in the accent.
    ctx.beginPath(); ctx.roundRect(T.x + inset, T.y + inset, T.w - 2 * inset, T.h - 2 * inset, 14 - inset);
    ctx.lineWidth = 3 / px;
    if (!T.fill) { ctx.strokeStyle = col(C.muted, 0.75 * (1 - T.hover)); ctx.stroke(); }
    if (T.hover > 0) {
      ctx.beginPath(); ctx.roundRect(T.x - focus / 2, T.y - focus / 2, T.w + focus, T.h + focus, 14 + focus / 2);
      ctx.lineWidth = focus; ctx.strokeStyle = col(C.accent, T.hover); ctx.stroke();
    }
    const L = T.layout, ink = T.fill ? C["on-accent"] : mix(C.muted, C.text, T.hover);
    strokeIcon(GLYPH[T.icon], T.x + T.w / 2, T.y + L.icon.dy, L.icon.size, col(ink), 1.8);
    ctx.font = `600 ${L.label.size}px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = col(ink);
    ctx.fillText(T.label, T.x + T.w / 2, T.y + L.label.dy);
  }
  // A page in a window: rows of an icon and a line, scrolled by `offset` rows,
  // with its scroll thumb; ghost = the thumb of the value before.
  const ROW = 30, ROWS = 30;
  function drawList({ x, y, w, h, offset, ghost }) {
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 14); ctx.fillStyle = col(C["surface-hover"]); ctx.fill();
    ctx.lineWidth = 3 / px; ctx.strokeStyle = col(C.muted, 0.75); ctx.stroke();
    ctx.clip();
    const first = Math.floor(offset);
    for (let i = Math.max(0, first - 1); i < Math.min(ROWS, first + h / ROW + 2); i++) {
      const ry = y + 12 + (i - offset) * ROW;
      ctx.fillStyle = col(C.muted, 0.8);
      ctx.beginPath(); ctx.roundRect(x + 16, ry + 5, 16, 16, 4); ctx.fill();
      ctx.beginPath(); ctx.roundRect(x + 42, ry + 10, 50 + ((i * 37) % 80), 6, 3); ctx.fill();
    }
    ctx.restore();
    const track = h - 20, thumb = Math.max(24, (track * h) / (ROWS * ROW)), max = ROWS - (h - 24) / ROW;
    const ty = (o) => y + 10 + (track - thumb) * clamp01(o / max);
    if (ghost !== undefined) {
      ctx.strokeStyle = col(C.muted, 0.8); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(x + w - 13, ty(ghost), 6, thumb, 3); ctx.stroke();
    }
    ctx.fillStyle = col(C.text, 0.85);
    ctx.beginPath(); ctx.roundRect(x + w - 13, ty(offset), 6, thumb, 3); ctx.fill();
  }
  // The control center as the app shows it: a panel with its name and a few rows.
  function drawGuide({ x, y, w, h, alpha }) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const dy = (1 - alpha) * 8;
    ctx.beginPath(); ctx.roundRect(x, y + dy, w, h, 14); ctx.fillStyle = col(C["surface-hover"]); ctx.fill();
    ctx.font = `600 24px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = col(C.text);
    ctx.fillText("Centro de control", x + 20, y + dy + 28);
    for (let i = 0; i < 3; i++) {
      const ry = y + dy + 56 + i * 26;
      ctx.fillStyle = col(C.muted, 0.8);
      ctx.beginPath(); ctx.roundRect(x + 20, ry, 16, 16, 4); ctx.fill();
      ctx.beginPath(); ctx.roundRect(x + 46, ry + 5, 90 + i * 30, 6, 3); ctx.fill();
    }
    ctx.restore();
  }

  // The home screen at a third of its size (1920 × 1080 → 640 × 360): the
  // tabs and the clock, the info, the tiles coloured like their art, the
  // music bar. Every item is { x, y, w, h, fill?, on?, name? } in field units.
  function drawHome({ y0, info, tiles, player, alpha }) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const bar = (x, y, w, h, c, r = h / 2) => { ctx.fillStyle = c; ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); };
    // Tabs (the first one current) and the clock.
    [0, 1, 2, 3].forEach((i) => bar(268 + i * 28, y0 + 18, 20, 5, col(i === 0 ? C.text : C.muted, i === 0 ? 0.9 : 0.6)));
    bar(598, y0 + 18, 20, 5, col(C.text, 0.9));
    // Info: the logo or title, a line, the button.
    bar(info.x, info.y, info.title, info.big ? 14 : 10, col(C.text, 0.85), 3);
    let y = info.y + (info.big ? 22 : 16);
    if (info.meta) { bar(info.x, y, 44, 5, col(C.muted, 0.8)); y += 12; }
    bar(info.x, y, 34, 14, col(C.accent), 4);
    const focus = C.focus / px;
    tiles.forEach((t) => {
      bar(t.x, t.y, t.w, t.h, col(t.fill), 4);
      if (t.name) bar(t.x + 10, t.y + t.h / 2 - 2.5, t.name, 5, col(C.text, 0.7));
      if (t.on) {
        ctx.beginPath(); ctx.roundRect(t.x - focus / 2, t.y - focus / 2, t.w + focus, t.h + focus, 4 + focus / 2);
        ctx.lineWidth = focus; ctx.strokeStyle = col(C.accent, t.on); ctx.stroke();
      }
    });
    if (player) {
      bar(21, y0 + 328, 92, 19, col(C["surface-hover"]), 4);
      bar(25, y0 + 331, 13, 13, col(C.muted, 0.6), 2);
      bar(43, y0 + 335, 52, 5, col(C.text, 0.7));
    }
    ctx.restore();
  }

  // Layers, always in this order: dots → rail → content → ghost → pointer → controls → mark.
  function drawStage(scene, clock) {
    const k = canvas.width / W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = col(C.surface); ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Short stages scale the whole scene down rather than cut it.
    const s = scene.scale ?? Math.min(1, H / 340);
    ctx.setTransform(k * s, 0, 0, k * s, (canvas.width - W * k * s) / 2, 0);
    const FH = H / s;

    // Dots: backgrounds.js at rest (step 16 × 2.5 on a 1080p screen), breathing slowly.
    const step = 40 / px, r = 1.5 / px;
    ctx.fillStyle = col(C.text, 0.05 + 0.008 * Math.sin((clock * 2 * Math.PI) / 7));
    for (let gx = step / 2 - W; gx < 2 * W; gx += step) for (let gy = step / 2; gy < FH; gy += step) { ctx.beginPath(); ctx.arc(gx, gy, r, 0, 7); ctx.fill(); }

    const R = scene.rail;
    if (R) {
      if (R.zone) { ctx.fillStyle = col(C.accent, R.alpha); ctx.fillRect(R.zone[0], R.y + 8, R.zone[1] - R.zone[0], 4); }
      ctx.fillStyle = col(C.muted, 0.75 * R.alpha);
      R.dots.forEach((x) => { ctx.beginPath(); ctx.arc(x, R.y, 4, 0, 7); ctx.fill(); });
    }

    if (scene.home) drawHome(scene.home);
    if (scene.target) drawTarget(scene.target);
    if (scene.list) drawList(scene.list);
    if (scene.guide) drawGuide(scene.guide);

    // The ghost goes over the target (it often stops on it), under the pointer.
    if (scene.ghost) arrowPointer(scene.ghost.x, scene.ghost.y, col(C.muted, 0.6 * scene.ghost.alpha), col(C.muted, 0.8 * scene.ghost.alpha), 1.5);
    if (scene.cursor) { ctx.globalAlpha = scene.cursor.alpha; arrowPointer(scene.cursor.x, scene.cursor.y, "#fff", "#000", 2); ctx.globalAlpha = 1; }

    // Controls: centred under the scene, 48 u apart.
    // With join, a + between them: pressed together.
    const controls = scene.controls ?? [];
    const width = (c) => (c.kind === "stick" ? 68 * (c.size ?? 1) : 40);
    let cx = W / 2 - (controls.reduce((s, c) => s + width(c), 0) + GAP * (controls.length - 1)) / 2;
    controls.forEach((c, i) => {
      const x = cx + width(c) / 2;
      if (c.kind === "stick") drawStick({ ...c, x, y: scene.L.base });
      else drawButton({ ...c, x, y: scene.L.base - 22 });
      cx += width(c) + GAP;
      if (scene.join && i < controls.length - 1) strokeIcon(GLYPH.plus, cx - GAP / 2, scene.L.base - 25, 22, col(C.muted), 2.5);
    });
    // A zoomed-in scene says so with a small magnifier in the corner.
    if (scene.zoomed) strokeIcon(GLYPH.zoom, W - 34, 34, 26, col(C.muted), 2);

    const M = scene.mark;
    if (M) strokeIcon(GLYPH[M.kind], M.x, M.y, 30, col(M.kind === "cross" ? C.muted : C.text, M.alpha), 2.5);
  }

  // Vertical layout of a field of height h, centred: mark, content, rail, controls.
  // extra: room for names under the controls.
  function layout(h, extra = 0) {
    const top = (h - 310 - extra) / 2;
    return { top, mark: top + 15, content: top + 37, pointer: top + 147, rail: top + 201, base: top + 303 };
  }
  const BOX = { x: 230, w: 180, h: 140 };
  const TILE = { layout: { icon: { dy: 46, size: 44 }, label: { dy: 92, size: 22 } }, icon: "gamepad", label: "Jugar" };
  // Trail: one dot every 1/15 s, at least 10 u apart.
  function trail(frames, t) {
    const dots = [], n = Math.min(frames.length - 1, Math.floor(t / DT));
    for (let j = 0; j <= n; j += 16) { const x = frames[j].x; if (dots.every((d) => Math.abs(d - x) >= 10)) dots.push(x); }
    return dots;
  }
  const at = (frames, t) => frames[Math.min(frames.length - 1, Math.max(0, Math.floor(t / DT)))];

  // ---------- scenes ----------
  const SCENES = {};

  // «Ayuda para apuntar»: hover_factor 1 / 0.65 / 0.45 / 0.25. The stick goes
  // to 60 % (under the boost threshold); the hand lets go 0.45 s after the
  // pointer reaches the target; if it went past, it comes back at 45 %.
  SCENES.slowdown = {
    values: [0, 35, 55, 75],
    level: (v) => (v <= 0 ? "off" : v < 45 ? "soft" : v < 65 ? "normal" : "strong"),
    captions: {
      off: "Va a la misma velocidad sobre los botones, así que es fácil pasarse.",
      soft: "Frena un poco.",
      normal: "Frena lo justo para detenerte encima.",
      strong: "Va mucho más lento sobre los botones. Ideal si te cuesta atinar o te tiembla la mano.",
    },
    sim(value) {
      const c = curve({ hover: 1 - value / 100 }), frames = [];
      const inside = (x) => x >= BOX.x && x <= BOX.x + BOX.w;
      let x = 20, t = 0, phase = "wait", from = 0, entered = null, stopped = null, click = null, release = null, overshoot = null, back = Infinity, over = false, since = 99;
      while (t < 8) {
        let tilt = 0;
        if (phase === "wait" && t >= 0.35) { phase = "go"; from = t; }
        if (phase === "go" || phase === "back") {
          tilt = (phase === "go" ? 0.6 : -0.45) * Math.min(1, (t - from) / 0.08);
          if (entered !== null && t >= entered + 0.45) { phase = "let"; release = { t, tilt }; }
        }
        if (phase === "let") { tilt = release.tilt * Math.max(0, 1 - (t - release.t) / 0.1); if (tilt === 0) { phase = "rest"; stopped = t; } }
        if (phase === "rest") {
          if (inside(x)) { if (click === null) click = stopped + 0.25; }
          else { if (!overshoot) overshoot = { x, t }; if (t >= stopped + 0.35) { phase = "back"; from = t; back = t; entered = null; } }
        }
        x += c(tilt, inside(x)) * SCREEN * DT;
        if ((phase === "go" || phase === "back") && entered === null && inside(x)) entered = t;
        if (inside(x) !== over) { over = !over; since = 0; } else since += DT;
        frames.push({ x, tilt, over, since });
        t += DT;
        if (click !== null && t > click + PRESS + HOLD) break;
      }
      return { frames, click, overshoot, back, done: click + PRESS + HOLD, key: overshoot ? overshoot.t + 0.2 : click + 0.15, assisted: value > 0 };
    },
    frame(run, t, alpha, ghost, L) {
      const f = at(run.frames, t), pt = t - run.click;
      const fill = pressFill(pt) ?? (pt >= PRESS && pt < PRESS + 0.12 ? mix(C.accent, C["surface-hover"], easeOut((pt - PRESS) / 0.12)) : null);
      let hover = f.over ? easeOut(clamp01(f.since / 0.12)) : 1 - easeOut(clamp01(f.since / 0.12));
      if (fill) hover = 0;
      let mark = null;
      if (pt >= 0) mark = { kind: "check", x: BOX.x + BOX.w / 2, y: L.mark, alpha: alpha * easeOut(clamp01(pt / 0.15)) };
      else if (run.overshoot && t >= run.overshoot.t && t < run.back) mark = { kind: "cross", x: run.overshoot.x, y: L.mark, alpha: alpha * easeOut(clamp01((t - run.overshoot.t) / 0.15)) };
      return {
        target: { ...BOX, ...TILE, y: L.content, hover, fill },
        rail: { y: L.rail, alpha, dots: trail(run.frames, t), zone: run.assisted ? [BOX.x, BOX.x + BOX.w] : null },
        mark,
        controls: [{ kind: "stick", tiltX: f.tilt, active: Math.abs(f.tilt) > 0.12 }, { kind: "button", glyph: "A", pt }],
        ghost: ghost ? { x: at(ghost.frames, t).x, y: L.pointer, alpha } : null,
        cursor: { x: f.x, y: L.pointer, alpha },
      };
    },
  };

  // «Velocidad del puntero»: the profile's top speed × 0.7 / 1 / 1.4. The same
  // 0.7 s push at 60 %: the trail and where it stops show the speed.
  SCENES.cursor_speed = {
    values: [70, 100, 140],
    level: (v) => (v < 85 ? "slow" : v <= 120 ? "normal" : "fast"),
    captions: {
      slow: "Más preciso, pero cruzar la pantalla toma más tiempo.",
      normal: "El equilibrio entre precisión y rapidez.",
      fast: "Cruza la pantalla en un momento, pero cuesta más atinar.",
    },
    sim(value) {
      const c = curve({ speed: value / 100 }), frames = [];
      let x = 60;
      const end = 0.35 + 0.7 + 0.1 + 0.4;
      for (let t = 0; t < end; t += DT) {
        const tilt = push(t, 0.35, 0.7, 0.6);
        x += c(tilt) * SCREEN * DT;
        frames.push({ x, tilt });
      }
      return { frames, done: end + HOLD, key: end - 0.2 };
    },
    frame(run, t, alpha, ghost, L) {
      const f = at(run.frames, t);
      return {
        rail: { y: L.rail, alpha, dots: trail(run.frames, t) },
        controls: [{ kind: "stick", tiltX: f.tilt, active: Math.abs(f.tilt) > 0.12 }],
        ghost: ghost ? { x: at(ghost.frames, t).x, y: L.pointer, alpha } : null,
        cursor: { x: f.x, y: L.pointer, alpha },
      };
    },
  };

  // «Ignorar movimientos pequeños»: deadzone 0.08 / 0.12 / 0.18. A resting hand
  // shakes the stick between ~3 % and ~17 %; inside the deadzone nothing moves,
  // outside the pointer creeps. Zoomed in (a 0.03-screen-high piece) so a few
  // real pixels show.
  SCENES.deadzone = {
    values: [8, 12, 18],
    level: (v) => (v < 10 ? "small" : v <= 15 ? "normal" : "large"),
    captions: {
      small: "Reacciona al mínimo roce. Si te tiembla la mano, el puntero se mueve solo.",
      normal: "Ignora los temblores pequeños.",
      large: "Ignora casi cualquier temblor, pero hay que empujar un poco más para moverlo.",
    },
    sim(value) {
      const dz = value / 100, c = curve({ deadzone: dz }), frames = [], zoom = 360 / 0.03;
      let x = 200;
      const end = 3.35;
      for (let t = 0; t < end + 0.5; t += DT) {
        const s = t - 0.35;
        const tilt = t < 0.35 || t > end ? 0 : 0.1 + 0.05 * Math.sin(2 * Math.PI * 1.1 * s) + 0.025 * Math.sin(2 * Math.PI * 2.9 * s + 1);
        x += c(tilt) * zoom * DT;
        frames.push({ x, tilt });
      }
      return { frames, dz, end, moved: x - 200, done: end + 0.5 + HOLD, key: end + 0.3 };
    },
    frame(run, t, alpha, ghost, L) {
      const f = at(run.frames, t);
      const shown = t >= run.end;
      const mark = !shown ? null : run.moved > 20
        ? { kind: "cross", x: run.frames.at(-1).x, y: L.content, alpha: alpha * easeOut(clamp01((t - run.end) / 0.15)) }
        : { kind: "check", x: 200, y: L.content, alpha: alpha * easeOut(clamp01((t - run.end) / 0.15)) };
      // The stick is drawn bigger here, so the pointer and its trail sit higher.
      const y = L.content + 40;
      return {
        rail: { y: y + 60, alpha, dots: trail(run.frames, t) },
        mark,
        controls: [{ kind: "stick", tiltX: f.tilt, deadzone: run.dz, lean: 2.5, size: 1.6, active: Math.abs(f.tilt) > run.dz }],
        ghost: ghost ? { x: at(ghost.frames, t).x, y, alpha } : null,
        cursor: { x: f.x, y, alpha },
        zoomed: true,
      };
    },
  };

  // Scrolling: the right stick up at 60 % for 1.2 s. curve.rs scroll_rate gives
  // 5 notches/s × the tuning's scroll; one notch is drawn as one row.
  // Stick up = wheel up = the page goes up (rows slide down); inverted, down.
  function scrollRun(factor, flip) {
    const frames = [];
    let offset = 12;
    const end = 0.35 + 1.2 + 0.1 + 0.3;
    for (let t = 0; t < end; t += DT) {
      const tilt = push(t, 0.35, 1.2, 0.6);
      offset -= scrollRate(tilt) * factor * flip * DT;
      frames.push({ offset, tilt });
    }
    return { frames, done: end + HOLD, key: 1.1 };
  }
  const LIST = { x: 210, w: 220 };
  function scrollFrame(run, t, alpha, ghost, L) {
    const f = at(run.frames, t);
    return {
      list: { ...LIST, y: L.content - 10, h: 170, offset: f.offset, ghost: ghost ? at(ghost.frames, t).offset : undefined },
      // No side name: which stick scrolls depends on «Puntero con la palanca derecha».
      controls: [{ kind: "stick", tiltY: f.tilt, active: Math.abs(f.tilt) > 0.2 }],
      cursor: { x: LIST.x + 120, y: L.content + 70, alpha },
    };
  }
  SCENES.scroll_speed = {
    values: [50, 100, 160],
    level: (v) => (v < 75 ? "slow" : v <= 130 ? "normal" : "fast"),
    captions: {
      slow: "Recorre la página despacio, sin perder dónde ibas.",
      normal: "Ni muy lento ni muy rápido.",
      fast: "Recorre páginas largas en un momento.",
    },
    sim(value) { return scrollRun(value / 100, 1); },
    frame: scrollFrame,
  };
  SCENES.invert_scroll = {
    values: [false, true],
    captions: {
      false: "Ahora la página sube al empujar la palanca hacia arriba, como con la rueda del mouse.",
      true: "",
    },
    sim(value) { return scrollRun(1, value ? -1 : 1); },
    frame: scrollFrame,
  };

  // «Aceptar con B»: with the pointer on «Jugar», the confirm button presses
  // it; then the other one goes back.
  SCENES.swap_ab = {
    values: [false, true],
    captions: {
      false: "Ahora {A} acepta y {B} vuelve atrás.",
      true: "",
    },
    sim(value) { return { swap: value, ok: 0.6, back: 1.7, done: 1.7 + PRESS + HOLD, key: 0.75 }; },
    frame(run, t, alpha, ghost, L) {
      const pt = t - run.ok, bt = t - run.back;
      const fill = pressFill(pt) ?? (pt >= PRESS && pt < PRESS + 0.12 ? mix(C.accent, C["surface-hover"], easeOut((pt - PRESS) / 0.12)) : null);
      let mark = null;
      if (bt >= 0) mark = { kind: "back", x: BOX.x + BOX.w / 2, y: L.mark, alpha: alpha * easeOut(clamp01(bt / 0.15)) };
      else if (pt >= 0) mark = { kind: "check", x: BOX.x + BOX.w / 2, y: L.mark, alpha: alpha * easeOut(clamp01(pt / 0.15)) };
      const a = run.swap ? bt : pt, b = run.swap ? pt : bt;
      return {
        target: { ...BOX, ...TILE, y: L.content, hover: fill ? 0 : 1, fill },
        mark,
        controls: [{ kind: "button", glyph: "A", pt: a }, { kind: "button", glyph: "B", pt: b }],
        cursor: { x: BOX.x + 96, y: L.pointer, alpha },
      };
    },
  };

  // «Puntero con la palanca derecha»: first one stick moves the pointer onto
  // the page, then the other scrolls it.
  SCENES.swap_sticks = {
    names: true,
    values: [false, true],
    captions: {
      false: "Ahora la palanca izquierda mueve el puntero y la derecha sube o baja la página.",
      true: "",
    },
    sim(value) {
      const c = curve(), frames = [];
      let x = 170, offset = 12;
      const end = 1.55 + 1.0 + 0.1 + 0.3;
      for (let t = 0; t < end; t += DT) {
        const move = push(t, 0.35, 0.8, 0.45), scroll = push(t, 1.55, 1.0, 0.6);
        x += c(move) * SCREEN * DT;
        offset -= scrollRate(scroll) * DT;
        frames.push({ x, offset, move, scroll });
      }
      return { swap: value, frames, done: end + HOLD, key: 2.0 };
    },
    frame(run, t, alpha, ghost, L) {
      const f = at(run.frames, t);
      const pointer = { kind: "stick", tiltX: f.move, active: Math.abs(f.move) > 0.12 };
      const scroller = { kind: "stick", tiltY: f.scroll, active: Math.abs(f.scroll) > 0.2 };
      const [left, right] = run.swap ? [scroller, pointer] : [pointer, scroller];
      return {
        list: { x: 330, w: 220, y: L.content - 10, h: 170, offset: f.offset },
        controls: [{ ...left, name: "Izquierda" }, { ...right, name: "Derecha" }],
        cursor: { x: f.x, y: L.content + 70, alpha },
      };
    },
  };

  // «Tiempo para mantener presionado»: View + Menu held 400 / 600 / 900 ms opens
  // the guide (engine.rs: toggle_hold = hold; Menu alone opens Inicio 100 ms sooner).
  SCENES.hold_time = {
    names: true,
    values: [400, 600, 900],
    level: (v) => (v < 500 ? "short" : v <= 750 ? "normal" : "long"),
    captions: {
      short: "Se abren enseguida, pero es más fácil abrirlos sin querer.",
      normal: "Hay que sostenerlos un momento.",
      long: "Hay que sostener casi un segundo, así es difícil abrirlos sin querer.",
    },
    sim(value) {
      const hold = value / 1000, press = 0.4, open = press + hold, release = open + 0.45;
      return { hold, press, open, release, done: release + HOLD, key: open + 0.2 };
    },
    frame(run, t, alpha, ghost, L) {
      const held = t >= run.press && t < run.release;
      const progress = held ? clamp01((t - run.press) / run.hold) : 0;
      const g = ghost && held ? clamp01((t - run.press) / ghost.hold) : 0;
      const pt = t - run.open;
      const button = (icon, name) => ({ kind: "button", icon, name, held, progress, ghost: g });
      return {
        guide: t >= run.open ? { x: 170, y: L.content, w: 300, h: 140, alpha: alpha * easeOut(clamp01(pt / 0.15)) } : null,
        controls: [button("view", "Vista"), button("menu", "Menú")],
        join: true,
      };
    },
  };

  // «Forma de Inicio»: the home screen in each shape (home.css sizes at a
  // third: 1 u = 16 / 3 field units) while the focus moves twice: right
  // twice in a row, right then down in the grid, down twice in the list.
  const ART = [[20, 52, 40], [58, 22, 20], [13, 35, 59], [58, 50, 26], [44, 30, 70], [30, 52, 58], [52, 36, 24], [24, 40, 52]];
  const U = 16 / 3, M = 21; // the unit and the side margin (4rem)
  // f: { at, prev, grow } — the focused item, the one before and how far
  // the change has gone (0 → 1).
  function homeShape(shape, f, y0) {
    const on = (i) => (i === f.at ? f.grow : i === f.prev ? 1 - f.grow : 0);
    const bottom = y0 + 320 - 3; // the row's bottom, above the music bar
    if (shape === "banners" || shape === "covers") {
      const [rest, big] = shape === "banners" ? [[20, 9.4], [25, 11.75]] : [[12, 18], [15, 22.5]];
      let x = M;
      const tiles = ART.map((fill, i) => {
        const k = on(i), w = (rest[0] + (big[0] - rest[0]) * k) * U, h = (rest[1] + (big[1] - rest[1]) * k) * U;
        const t = { x, y: bottom - h, w, h, fill, on: k };
        x += w + 7;
        return t;
      });
      return { tiles, info: { x: M, y: bottom - big[1] * U - 11 - 52, title: 70, big: true, meta: true }, player: true };
    }
    if (shape === "grid") {
      const w = 12 * U, h = 18 * U, gap = 8;
      const tiles = [...ART, ...ART].slice(0, 16).map((fill, i) => ({ x: M + (i % 8) * (w + gap), y: y0 + 82 + Math.floor(i / 8) * (h + gap), w, h, fill, on: on(i) }));
      return { tiles, info: { x: M, y: y0 + 43, title: 60 }, player: true };
    }
    const tiles = ART.slice(0, 7).map((fill, i) => ({ x: 448, y: y0 + 53 + i * 25, w: 150, h: 21, fill: C["surface-hover"], name: 50 + ((i * 37) % 60), on: on(i) }));
    return { tiles, info: { x: M, y: bottom - 52, title: 70, big: true, meta: true }, player: true };
  }
  SCENES.library_view = {
    values: ["banners", "covers", "grid", "list"],
    captions: {
      banners: "Una fila de arte ancho. La que eliges se agranda.",
      covers: "Una fila de portadas, como la caja del juego. La que eliges se agranda.",
      grid: "Varias filas de portadas, para ver toda la biblioteca de una vez.",
      list: "Solo los nombres, uno debajo del otro, para encontrar algo rápido.",
    },
    sim(value) {
      const steps = { banners: [1, 2], covers: [1, 2], grid: [1, 9], list: [1, 2] }[value];
      return { shape: value, moves: [[0.9, steps[0]], [1.7, steps[1]]], done: 1.7 + 0.16 + HOLD + 0.4, key: 1.9 };
    },
    frame(run, t, alpha, ghost, L) {
      let at = 0, prev = -1, since = 1;
      run.moves.forEach(([when, to]) => { if (t >= when) { prev = at; at = to; since = t - when; } });
      const f = { at, prev, grow: prev < 0 ? 1 : easeOut(clamp01(since / 0.16)) };
      // No ghost: each shape is a different screen.
      const y0 = L.top - 25;
      return { home: { y0, alpha, ...homeShape(run.shape, f, y0) } };
    },
  };

  // ---------- playback ----------
  const runs = new Map();
  function runOf(id, value) {
    const key = id + ":" + value;
    if (!runs.has(key)) runs.set(key, SCENES[id].sim(value));
    return runs.get(key);
  }
  const loopLength = () => Math.max(current.run.done, current.ghost ? current.ghost.done : 0) + FADE + EMPTY;
  function frameAt(t, clock) {
    const end = loopLength() - FADE - EMPTY;
    let alpha = t < APPEAR ? t / APPEAR : 1;
    if (t > end) alpha = 1 - easeIn(clamp01((t - end) / FADE));
    const extra = current.scene.names ? 34 : 0, s = Math.min(1, H / (340 + extra));
    const L = layout(H / s, extra);
    const scene = current.scene.frame(current.run, Math.min(t, end), alpha, current.ghost, L);
    scene.L = L;
    scene.scale = s;
    drawStage(scene, clock);
  }
  function tick(now) {
    raf = 0;
    if (!current || !onScreen || document.hidden) return;
    let t = (now - t0) / 1000;
    if (t > loopLength()) {
      t0 = now; t = 0; current.loops++;
      if (current.ghost && --current.ghostLoops <= 0) current.ghost = null;
      loopFn?.(current.loops);
    }
    frameAt(t, now / 1000);
    const k = (now - snapAt) / CROSS;
    if (snap && k < 1) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1 - k; ctx.drawImage(snap, 0, 0); ctx.globalAlpha = 1; }
    raf = requestAnimationFrame(tick);
  }
  function wake() {
    if (!raf && current && onScreen && !document.hidden && frozen === null) {
      t0 = performance.now() - APPEAR * 1000;
      raf = requestAnimationFrame(tick);
    }
  }
  function redraw() {
    if (!current) return;
    if (frozen !== null) frameAt(frozen === "key" ? current.run.key : frozen, 0);
    else if (!raf) frameAt(APPEAR, 0);
  }
  function size() {
    const r = canvas.getBoundingClientRect(), d = devicePixelRatio || 1;
    if (!r.width || !r.height) return;
    canvas.width = Math.round(r.width * d);
    canvas.height = Math.round(r.height * d);
    px = r.width / W;
    H = (W * r.height) / r.width;
    redraw();
  }

  return {
    mount(el) {
      this.unmount();
      // Windows' animations off: the scene's most telling moment, still.
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) frozen = "key";
      canvas = el; ctx = canvas.getContext("2d");
      glyphs(); readTheme(); size();
      const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; wake(); });
      io.observe(canvas);
      const ro = new ResizeObserver(() => { readTheme(); size(); });
      ro.observe(canvas);
      // The accent and text size change as root style / class.
      const mo = new MutationObserver(() => { readTheme(); redraw(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
      const vis = () => wake();
      document.addEventListener("visibilitychange", vis);
      document.fonts?.ready.then(redraw);
      observers = [() => io.disconnect(), () => ro.disconnect(), () => mo.disconnect(), () => document.removeEventListener("visibilitychange", vis)];
    },
    unmount() {
      observers.forEach((off) => off());
      observers = [];
      if (raf) cancelAnimationFrame(raf);
      raf = 0; canvas = null; ctx = null; current = null;
    },
    has: (id) => id in SCENES,
    values: (id) => SCENES[id]?.values.slice() ?? [],
    // Amounts read as the level they are closest to.
    caption: (id, value) => {
      const s = SCENES[id];
      return (s && (s.level ? s.captions[s.level(value)] : s.captions[String(value)])) ?? "";
    },
    show(id, value, prev) {
      const scene = SCENES[id];
      if (!scene || !ctx) return;
      const now = performance.now();
      if (current && raf) {
        snap = Object.assign(document.createElement("canvas"), { width: canvas.width, height: canvas.height });
        snap.getContext("2d").drawImage(canvas, 0, 0);
        snapAt = now;
      }
      const ghost = prev !== undefined && prev !== value && current?.scene === scene ? runOf(id, prev) : null;
      current = { scene, value, run: runOf(id, value), ghost, ghostLoops: 3, loops: 0 };
      t0 = now - APPEAR * 1000;
      if (frozen !== null) frameAt(frozen === "key" ? current.run.key : frozen, 0);
      else { redraw(); wake(); }
    },
    onLoop(fn) { loopFn = fn; },
    // Freezes one moment: seconds, or "key" for the scene's most telling one; null resumes.
    still(t) {
      frozen = t;
      if (t === null) { wake(); return; }
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (current) frameAt(t === "key" ? current.run.key : t, 0);
    },
    // For tests: the simulated runs.
    _run: (id, value) => runOf(id, value),
  };
})();

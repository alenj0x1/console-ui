// The app's own animated backgrounds: dot fields and fine lines over the
// theme's background colour, drawn by the GPU (WebGL fragment shaders), so
// they cost almost no CPU. Each one is laid out on a virtual 768 × 432 field
// scaled to cover the screen, so it looks the same at any resolution. Ids
// match sources/builtin.rs.

const Backgrounds = (() => {
  // Slow animations: 30 frames per second are enough.
  const FRAME_MS = 1000 / 30;
  // A tile is about a seventh of the screen's width: zoomed in, it shows the
  // dots at the size they have on screen.
  const PREVIEW_ZOOM = 2.5;
  // Per animation: a moment that shows it well and how much brighter its
  // dots are drawn, since a tile only shows a small part of the field.
  const PREVIEW = { rain: { t: 57.5, gain: 1.5 }, breath: { t: 9, gain: 1.6 } };

  // A theme colour as RGB in 0..1, whatever CSS form it has (a 2D canvas
  // normalises it to #rrggbb).
  const probe = document.createElement("canvas").getContext("2d");
  const color = (name) => {
    probe.fillStyle = "#000";
    probe.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const hex = probe.fillStyle.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  };
  const themeColors = () => ({ bg: color("--bg"), text: color("--text"), accent: color("--accent") });
  // Read again by refresh() when the settings change the accent.
  let colors = themeColors();

  const VERTEX = `attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

  // Shared header: virtual coordinates, colours and an anti-aliased dot.
  const COMMON = `
    precision highp float;
    uniform vec2 uRes;
    uniform float uTime;
    uniform float uZoom;
    uniform vec3 uBg;
    uniform vec3 uText;
    uniform vec3 uAccent;
    uniform float uGain;
    const vec2 FIELD = vec2(768.0, 432.0);
    const float STEP = 16.0;
    float scale() { return max(uRes.x / FIELD.x, uRes.y / FIELD.y) * uZoom; }
    vec2 field() {
      vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
      return (px - (uRes - FIELD * scale()) * 0.5) / scale();
    }
    // Colour of a dot of radius r and opacity a at distance d (1 px soft edge).
    vec4 dot(float d, float r, vec3 col, float a) {
      float edge = 0.5 / scale();
      return vec4(col, a * (1.0 - smoothstep(r - edge, r + edge, d)));
    }
    vec4 cell(vec2 p, out vec2 c) {
      c = (floor(p / STEP) + 0.5) * STEP;
      return vec4(0.0);
    }
  `;

  const BODY = {
    // A diagonal wave crosses the grid; its crests light up in the accent.
    diagonal: `
      vec4 paint(vec2 p) {
        vec2 c; cell(p, c);
        float w = sin(c.x * 0.025 + c.y * 0.015 - uTime * 1.2) * 0.5 + 0.5;
        float v = sin(c.x * 0.009 - c.y * 0.025 + uTime * 0.6) * 0.5 + 0.5;
        float k = w * v;
        bool hi = k > 0.72;
        return dot(distance(p, c), 0.7 + 2.2 * k, hi ? uAccent : uText, hi ? 0.95 : 0.12 + 0.4 * k);
      }`,
    // Rings spread from a point that wanders across the screen.
    ripples: `
      vec4 paint(vec2 p) {
        vec2 c; cell(p, c);
        vec2 o = FIELD * 0.5 + vec2(sin(uTime * 0.3) * 240.0, cos(uTime * 0.4) * 110.0);
        float r = distance(c, o);
        float k = (sin(r * 0.06 - uTime * 2.0) * 0.5 + 0.5) * max(0.0, 1.0 - r / 520.0);
        bool hi = k > 0.6;
        return dot(distance(p, c), 0.7 + 2.3 * k, hi ? uAccent : uText, hi ? 0.9 : 0.1 + 0.45 * k);
      }`,
    // Each column lights up from the top as a drop falls through it.
    rain: `
      vec4 paint(vec2 p) {
        vec2 c; cell(p, c);
        float i = floor(p.x / STEP);
        float speed = 30.0 + mod(i * 37.0, 50.0);
        float start = mod(i * 131.0, 400.0);
        float head = mod(uTime * speed + start, FIELD.y + 160.0) - 30.0;
        float behind = head - c.y;
        float k = behind >= 0.0 && behind < 150.0 ? 1.0 - behind / 150.0 : 0.0;
        bool tip = behind >= 0.0 && behind < STEP;
        return dot(distance(p, c), 0.8 + 1.8 * k, tip ? uAccent : uText, tip ? 0.95 : 0.1 + 0.5 * k);
      }`,
    // The whole grid breathes slowly; no accent.
    breath: `
      vec4 paint(vec2 p) {
        vec2 c; cell(p, c);
        float k = ((sin(c.x * 0.013 + uTime * 0.4) + sin(c.y * 0.019 - uTime * 0.3) + sin((c.x + c.y) * 0.008 + uTime * 0.25)) / 3.0) * 0.5 + 0.5;
        return dot(distance(p, c), 0.6 + 2.0 * k * k, uText, 0.08 + 0.45 * k * k);
      }`,
    // Fine lines flowing sideways; one of them in the accent.
    lines: `
      vec4 paint(vec2 p) {
        vec4 out_ = vec4(0.0);
        float half_ = 0.6 + 0.5 / scale();
        for (int j = 0; j < 26; j++) {
          float fj = float(j);
          float y = fj * 17.0 + 4.0 + sin(p.x * 0.012 + uTime * 0.5 + fj * 0.3) * 13.0 + sin(p.x * 0.004 - uTime * 0.3 + fj * 0.15) * 20.0;
          float cover = 1.0 - smoothstep(half_ - 1.0 / scale(), half_, abs(p.y - y));
          if (cover > 0.0) {
            bool hi = j == 13;
            vec4 line = vec4(hi ? uAccent : uText, (hi ? 0.9 : 0.16) * cover);
            out_ = line.a > out_.a ? line : out_;
          }
        }
        return out_;
      }`,
  };

  const name = (id) => id.replace(/^builtin:/, "");

  // One WebGL canvas with a compiled program per animation.
  function renderer(canvas, options) {
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, ...options });
    if (!gl) return null;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // One triangle that covers the screen.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const programs = {};
    const compile = (key) => {
      const shader = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const fragment = `${COMMON}${BODY[key]}
        void main() {
          vec4 c = paint(field());
          gl_FragColor = vec4(mix(uBg, c.rgb, min(1.0, c.a * uGain)), 1.0);
        }`;
      const p = gl.createProgram();
      gl.attachShader(p, shader(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(p);
      const u = (n) => gl.getUniformLocation(p, n);
      return { p, a: gl.getAttribLocation(p, "a"), res: u("uRes"), time: u("uTime"), zoom: u("uZoom"), bg: u("uBg"), text: u("uText"), accent: u("uAccent"), gain: u("uGain") };
    };
    return (id, t, zoom = 1, gain = 1) => {
      const key = name(id);
      if (!(key in BODY)) return;
      const prog = (programs[key] ??= compile(key));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(prog.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(prog.a);
      gl.vertexAttribPointer(prog.a, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(prog.res, canvas.width, canvas.height);
      gl.uniform1f(prog.time, t);
      gl.uniform1f(prog.zoom, zoom);
      gl.uniform1f(prog.gain, gain);
      gl.uniform3fv(prog.bg, colors.bg);
      gl.uniform3fv(prog.text, colors.text);
      gl.uniform3fv(prog.accent, colors.accent);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
  }

  let running = null;
  const draws = new WeakMap();
  let previewer = null;

  return {
    has: (id) => name(id) in BODY,

    // Draws `id` on the canvas until stop(); follows the window's size. With
    // Windows' animations off it draws one still frame.
    start(id, canvas) {
      this.stop();
      if (!draws.has(canvas)) draws.set(canvas, renderer(canvas));
      const draw = draws.get(canvas);
      if (!draw) return;
      const begin = performance.now();
      let last = 0;
      const tick = (now) => {
        if (running?.canvas !== canvas) return;
        running.raf = requestAnimationFrame(tick);
        if (now - last < FRAME_MS) return;
        last = now;
        const [w, h] = [canvas.clientWidth, canvas.clientHeight];
        if (canvas.width !== w || canvas.height !== h) [canvas.width, canvas.height] = [w, h];
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
          draw(id, PREVIEW[name(id)]?.t ?? 7, 1, PREVIEW[name(id)]?.gain ?? 1);
          cancelAnimationFrame(running.raf);
          return;
        }
        draw(id, (now - begin) / 1000 + 4);
      };
      running = { canvas, id, raf: requestAnimationFrame(tick) };
    },

    stop() {
      if (running) cancelAnimationFrame(running.raf);
      running = null;
    },

    running: () => running?.id ?? null,

    // The theme's colours changed: draw with the new ones.
    refresh() {
      colors = themeColors();
    },

    // One still frame as a picture, for the tiles.
    preview(id, w = 560, h = 262) {
      const { t = 7, gain = 1 } = PREVIEW[name(id)] ?? {};
      if (!previewer) {
        const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
        previewer = { canvas, draw: renderer(canvas, { preserveDrawingBuffer: true }) };
      }
      if (!previewer.draw) return "";
      previewer.draw(id, t, PREVIEW_ZOOM, gain);
      return previewer.canvas.toDataURL("image/png");
    },
  };
})();

// The boss — a giant pixel octopus built from a cell grid, in the spirit of
// Glyph's manta (MIT, askglyph/glyph): the creature is larger than the screen,
// cropped by the edges, multi-tone, and the composer sits over its middle.
//
// Geometry instead of a hand-drawn bitmap: a superellipse mantle, two eyes,
// and eight cubic-bezier arms sampled into cells. Cells are computed on
// resize, then only drawn per frame.

const BODY = ["#c9c7c1", "#c2c0ba", "#d0cec8", "#bab8b2", "#d6d4ce"];
const ACCENT = ["#9aa6bb", "#d8a273", "#86d9b6"];
const EYE = "#26241f";

const CELL = 13; // css px, scaled with the viewport

function hash(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function startSwarm(canvas) {
  if (!canvas) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = canvas.getContext("2d");

  let w = 0;
  let h = 0;
  let t = 0;
  let cells = [];   // { x, y, color }
  let eyes = [];    // { x, y }
  let s = CELL;

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    s = Math.max(9, Math.min(16, Math.round(Math.min(w, h) / 58)));
    build();
  }

  function build() {
    cells = [];
    eyes = [];

    const cx = w / 2;
    const cy = h * 0.5;
    const rx = Math.min(w * 0.27, 340);
    const ry = Math.min(h * 0.135, 118);

    // mantle: superellipse dome, flat-ish where the arms attach
    const cols = Math.ceil(w / s) + 2;
    const rows = Math.ceil(h / s) + 2;

    const arms = Array.from({ length: 8 }, (_, i) => {
      const p = (i - 3.5) / 3.5; // -1 .. 1
      const root = { x: cx + p * rx * 0.82, y: cy + ry * 0.4 };
      const end = { x: cx + p * w * 0.8, y: h * 1.16 + Math.abs(p) * 30 };
      const c1 = { x: root.x + p * rx * 0.85, y: cy + ry * 1.15 };
      const c2 = { x: end.x - p * w * 0.1, y: h * 0.78 };
      return { root, c1, c2, end };
    });

    const samples = arms.map(({ root, c1, c2, end }) => {
      const pts = [];
      for (let k = 0; k <= 48; k++) {
        const u = k / 48;
        const v = 1 - u;
        pts.push({
          x: v * v * v * root.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * end.x,
          y: v * v * v * root.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * end.y,
          r: s * (1.65 - 0.8 * u),
        });
      }
      return pts;
    });

    function inMantle(x, y) {
      const dx = Math.abs((x - cx) / rx);
      const dy = Math.abs((y - cy) / ry);
      return dx ** 2.3 + dy ** 2.1 <= 1 && y < cy + ry * 0.62;
    }

    function inArm(x, y) {
      for (const arm of samples) {
        for (let k = 0; k < arm.length; k += 2) {
          const p = arm[k];
          const dx = x - p.x;
          const dy = y - p.y;
          if (dx * dx + dy * dy <= p.r * p.r) return true;
        }
      }
      return false;
    }

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = col * s + s / 2;
        const y = row * s + s / 2;
        if (!inMantle(x, y) && !inArm(x, y)) continue;

        // eyes: two tall blocks set into the mantle, high enough to clear the composer
        const ex = Math.abs(x - cx);
        const ey = Math.abs(y - (cy - ry * 0.08));
        if (ex > rx * 0.22 && ex < rx * 0.22 + s * 2.2 && ey < ry * 0.2) {
          eyes.push({ x, y });
          continue;
        }

        const n = hash(col, row);
        const color =
          n > 0.998 ? ACCENT[1] : n > 0.996 ? ACCENT[0] : n > 0.994 ? ACCENT[2] : BODY[Math.floor(n * BODY.length) % BODY.length];

        cells.push({ x, y, color });
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);

    const bob = reduce ? 0 : Math.sin(t / 110) * s * 0.28;
    const blink = !reduce && t % 330 < 8;

    for (const c of cells) {
      ctx.fillStyle = c.color;
      const x = c.x - s / 2 + s * 0.06;
      const y = c.y - s / 2 + s * 0.06 + bob;
      const d = s * 0.88;
      const r = s * 0.18;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, d, d, r);
      else ctx.rect(x, y, d, d);
      ctx.fill();
    }

    if (!blink) {
      ctx.fillStyle = EYE;
      for (const e of eyes) {
        const x = e.x - s / 2 + s * 0.06;
        const y = e.y - s / 2 + s * 0.06 + bob;
        const d = s * 0.88;
        const r = s * 0.3;
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, d, d, r);
        else ctx.rect(x, y, d, d);
        ctx.fill();
      }
    }
  }

  function frame() {
    t += 1;
    draw();
    requestAnimationFrame(frame);
  }

  window.addEventListener("resize", layout);
  layout();
  if (!reduce) frame();
}

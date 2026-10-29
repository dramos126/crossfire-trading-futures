/**
 * The parity report's markup: one self-contained page per day and the index
 * over them. Opened from the NAS in a browser with nothing else to hand, so
 * every byte is inline — the SVG, the styles, a little script for the
 * tooltips and the highlight — and nothing names a network address.
 *
 * Colours are the app's tokens (`globals.css`), copied as custom properties
 * because the page cannot load the app's stylesheet; the two series hues and
 * the light set exist only here, validated with the dataviz palette checks
 * (both modes, both pass). Identity is never colour alone: live is a triangle
 * and a circle on a solid line, the backtest an arrow and a square on a dashed
 * one, and a long points up.
 */
import {
  IRREGULARITIES_HEADING,
  IRREGULARITIES_LEAD,
  etClock,
  type AccountView,
  type ChartTrade,
  type ChartView,
  type DifferenceItem,
  type IndexRow,
  type LegView,
  type ReportView,
  type TableRow,
  type Tile,
  type Tone,
} from "./parity-report-model";
import type { LogEvidence } from "./parity-logs";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Bold then italic, each pair matched only within the text between tags an
 * earlier pair wrote, so every tag closes inside its parent: `**a *b** c*`
 * is bold `a *b` and a literal `c*`, never `<em>` straddling `</strong>`.
 */
const EMPHASIS: ReadonlyArray<[RegExp, string]> = [
  [/\*\*(.+?)\*\*/g, "<strong>$1</strong>"],
  [/__(.+?)__/g, "<strong>$1</strong>"],
  [/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "$1<em>$2</em>"],
  [/(^|[^\w])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1<em>$2</em>"],
];
const EMPHASIS_TAG = /^<\/?(?:strong|em)>$/;

/** Bold, italic and inline code, on text escaped first: the only tags in the
 *  result are the three written here, and escaping produces none of `*_\``. */
function inlineMarkdown(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      let html = escapeHtml(part);
      for (const [pattern, replacement] of EMPHASIS) {
        html = html
          .split(/(<\/?(?:strong|em)>)/)
          .map((piece) => (EMPHASIS_TAG.test(piece) ? piece : piece.replace(pattern, replacement)))
          .join("");
      }
      return html;
    })
    .join("");
}

/**
 * `notes.md` as markup: headings, paragraphs, bulleted and numbered lists,
 * bold, italic, inline code. A file someone typed, so everything is escaped
 * and nothing else of markdown is honoured — a link or raw HTML is its text.
 */
export function renderMarkdown(markdown: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  // A holder rather than a `let`: the flushes reassign it from closures,
  // which control-flow narrowing does not see.
  const open: { list: { tag: "ul" | "ol"; items: string[] } | null } = { list: null };
  const flushParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    const list = open.list;
    if (list != null) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inlineMarkdown(i)}</li>`).join("")}</${list.tag}>`);
    open.list = null;
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading != null) {
      flushParagraph();
      flushList();
      out.push(`<h4>${inlineMarkdown(heading[1])}</h4>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const numbered = bullet == null ? /^\d+[.)]\s+(.*)$/.exec(line) : null;
    const entry = bullet ?? numbered;
    if (entry != null) {
      flushParagraph();
      const tag = bullet != null ? "ul" : "ol";
      if (open.list?.tag !== tag) flushList();
      open.list ??= { tag, items: [] };
      open.list.items.push(entry[1]);
      continue;
    }
    // An indented line under an item continues it.
    if (open.list != null && /^\s/.test(raw)) {
      open.list.items[open.list.items.length - 1] += ` ${line}`;
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return out.join("");
}

function notesHtml(markdown: string): string {
  return `<section class="panel" id="notes"><h3>Notes</h3><div class="notes-md">${renderMarkdown(markdown)}</div></section>`;
}

function logEvidenceHtml(logs: LogEvidence | null): string {
  if (logs == null) return "";
  if (logs.empty != null) return `<p class="log-empty">${escapeHtml(logs.empty)}</p>`;
  return `<ul class="log-lines">${logs.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
}

function irregularitiesHtml(lines: readonly string[]): string {
  return (
    `<section class="panel" id="irregularities"><h3>${escapeHtml(IRREGULARITIES_HEADING)}</h3>` +
    `<p class="sub">${escapeHtml(IRREGULARITIES_LEAD)}</p>` +
    (lines.length === 0
      ? `<p class="clean spaced">None.</p>`
      : `<ul class="plain spaced log-list">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`) +
    `</section>`
  );
}

const CSS = `
:root {
  color-scheme: dark light;
  --background: #0B0F1A;
  --card: #161B2A;
  --card-border: #1E293B;
  --foreground: #E2E8F0;
  --muted: #94A3B8;
  --muted-secondary: #6B7A8F;
  --bg-row: #1C2333;
  --bg-row-alt: #161B2A;
  --bg-row-deep: #232C42;
  --accent: #38BDF8;
  --success: #4ADE80;
  --danger: #F87171;
  --warning: #FBBF24;
  --series-live: oklch(0.65 0.18 250);
  --series-backtest: oklch(0.66 0.16 55);
  --chart-bg: var(--card);
  --grid: var(--bg-row-deep);
  --cash-band: var(--bg-row);
  --candle-up: var(--muted);
  --candle-down: var(--muted-secondary);
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root {
    --background: oklch(0.97 0.005 250);
    --card: oklch(0.99 0.003 250);
    --card-border: oklch(0.88 0.012 250);
    --foreground: oklch(0.26 0.03 260);
    --muted: oklch(0.47 0.03 255);
    --muted-secondary: oklch(0.58 0.025 255);
    --bg-row: oklch(0.955 0.006 250);
    --bg-row-alt: oklch(0.99 0.003 250);
    --bg-row-deep: oklch(0.92 0.008 250);
    --accent: oklch(0.55 0.15 235);
    --success: oklch(0.52 0.15 150);
    --danger: oklch(0.53 0.19 25);
    --warning: oklch(0.6 0.15 75);
    --series-live: oklch(0.55 0.19 255);
    --series-backtest: oklch(0.62 0.17 50);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--background); color: var(--foreground); font: 14px/1.45 var(--sans); }
main, .page-head { max-width: 1180px; margin: 0 auto; padding: 0 24px; }
.page-head { padding-top: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--card-border); }
.page-head nav { font-size: 12px; margin-bottom: 6px; }
a { color: var(--accent); text-decoration: none; }
a:hover, a:focus-visible { text-decoration: underline; }
h1 { font-size: 24px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 18px; font-weight: 600; margin: 0; }
h3 { font-size: 12px; font-weight: 600; margin: 20px 0 8px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
h4 { font-size: 12px; font-weight: 600; margin: 12px 0 4px; font-family: var(--mono); color: var(--foreground); }
.sub { color: var(--muted); font-size: 12px; margin: 4px 0 0; }
.note { color: var(--warning); font-size: 12px; margin: 8px 0 0; }
.mono, td, .tile .value, .tip-row strong { font-family: var(--mono); font-variant-numeric: tabular-nums; }
section.account, section.panel, .legs { background: var(--card); border: 1px solid var(--card-border); margin: 20px 0; padding: 16px; }
section.panel > h3:first-child { margin-top: 0; }
.account-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.account-head .sub { margin: 0; }
.refusal { color: var(--danger); font-size: 14px; margin: 8px 0 0; }
.tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1px; background: var(--card-border); border: 1px solid var(--card-border); margin-top: 12px; }
.tile { background: var(--bg-row); padding: 8px 10px; min-width: 0; }
.tile:nth-child(10n+6), .tile:nth-child(10n+7), .tile:nth-child(10n+8), .tile:nth-child(10n+9), .tile:nth-child(10n+10) { background: var(--bg-row-alt); }
.tile .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tile .value { font-size: 18px; font-weight: 600; white-space: nowrap; }
.pos { color: var(--success); }
.neg { color: var(--danger); }
figure.chart { margin: 16px 0 0; }
figure.chart figcaption { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
figure.chart figcaption .what { font-family: var(--mono); font-size: 12px; font-weight: 600; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11px; color: var(--muted); align-items: center; }
.legend span { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.legend svg { display: block; }
svg.chart { display: block; width: 100%; height: auto; background: var(--chart-bg); border: 1px solid var(--card-border); }
svg.chart text { font-family: var(--mono); font-size: 11px; fill: var(--muted); }
svg.chart .stamp { font-size: 10px; letter-spacing: 0.08em; }
.grid { stroke: var(--grid); stroke-width: 1; }
.cash { fill: var(--cash-band); }
.wick { stroke-width: 1; }
.up { fill: var(--chart-bg); stroke: var(--candle-up); stroke-width: 1; }
.up-wick { stroke: var(--candle-up); }
.down { fill: var(--candle-down); stroke: var(--candle-down); stroke-width: 1; }
.down-wick { stroke: var(--candle-down); }
.link-live { stroke: var(--series-live); stroke-width: 1.5; fill: none; }
.link-backtest { stroke: var(--series-backtest); stroke-width: 1.5; fill: none; stroke-dasharray: 4 4; }
.glyph { stroke: var(--chart-bg); stroke-width: 2; paint-order: stroke; }
.live .glyph { fill: var(--series-live); }
.backtest .glyph { fill: var(--series-backtest); }
.blocked .glyph { stroke: var(--muted); stroke-width: 2; fill: none; }
.hit { fill: transparent; }
.mk { cursor: pointer; outline: none; }
.mk:hover .glyph, .mk:focus-visible .glyph { stroke: var(--foreground); }
.blocked:hover .glyph, .blocked:focus-visible .glyph { stroke: var(--foreground); }
svg.has-hl .mk:not(.hl), svg.has-hl .link-live:not(.hl), svg.has-hl .link-backtest:not(.hl) { opacity: 0.3; }
.mk.hl .glyph { stroke: var(--foreground); stroke-width: 2.5; }
.blocked.hl .glyph { stroke: var(--foreground); }
ol.diffs, ul.plain { list-style: none; margin: 0; padding: 0; border: 1px solid var(--card-border); }
ol.diffs li, ul.plain li { background: var(--bg-row); }
ol.diffs li:nth-child(even), ul.plain li:nth-child(even) { background: var(--bg-row-alt); }
ul.plain li, .diff-text { display: block; padding: 6px 10px; }
.spaced { margin-top: 12px; }
td.prose { font-family: var(--sans); }
pre.summary { white-space: pre-wrap; font-size: 12px; }
button.diff { all: unset; display: block; width: 100%; box-sizing: border-box; padding: 6px 10px 6px 26px; cursor: pointer; position: relative; }
button.diff::before { content: ""; position: absolute; left: 10px; top: 12px; width: 6px; height: 6px; border: 1px solid var(--muted); }
button.diff:hover, button.diff:focus-visible { background: var(--bg-row-deep); }
button.diff.active { background: var(--bg-row-deep); box-shadow: inset 2px 0 0 var(--accent); }
button.diff.active::before { background: var(--accent); border-color: var(--accent); }
.clean { color: var(--muted); margin: 0; }
.table-wrap { overflow-x: auto; border: 1px solid var(--card-border); }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th { font: 600 10px/1.3 var(--sans); text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); text-align: left; padding: 6px 8px; background: var(--bg-row-deep); white-space: nowrap; }
th.group { text-align: center; border-left: 1px solid var(--card-border); }
td { padding: 5px 8px; white-space: nowrap; border-top: 1px solid var(--card-border); }
td.first-of-group, th.first-of-group { border-left: 1px solid var(--card-border); }
tbody tr:nth-child(odd) { background: var(--bg-row); }
tbody tr:nth-child(even) { background: var(--bg-row-alt); }
td.empty { color: var(--muted-secondary); }
details.legs > summary { cursor: pointer; font-weight: 600; font-size: 14px; }
details.legs > summary .sub { font-weight: 400; display: inline; margin-left: 8px; }
.leg { border-top: 1px solid var(--card-border); margin-top: 16px; padding-top: 12px; }
#tip { position: fixed; z-index: 10; max-width: 340px; background: var(--card); border: 1px solid var(--muted-secondary); padding: 8px 10px; font-size: 12px; pointer-events: none; }
#tip .tip-title { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
.tip-row { display: flex; gap: 8px; align-items: baseline; }
.tip-row strong { font-weight: 600; color: var(--foreground); }
.tip-row span { color: var(--muted); font-size: 11px; }
.log-lines { list-style: none; margin: 0; padding: 0 10px 6px 26px; }
ol.diffs .log-lines li, ul.plain .log-lines li { background: transparent; padding: 0; }
.log-lines li, .log-list li { font: 11px/1.45 var(--mono); color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.log-empty { margin: 0; padding: 0 10px 6px 26px; font-size: 12px; color: var(--muted-secondary); }
ul.plain .log-lines, ul.plain .log-empty { padding: 2px 0 0 16px; }
.notes-md h4 { font-family: var(--sans); font-size: 13px; }
.notes-md p, .notes-md ul, .notes-md ol { margin: 6px 0; }
.notes-md ul, .notes-md ol { padding-left: 20px; }
.notes-md code { font-family: var(--mono); font-size: 12px; background: var(--bg-row); padding: 0 3px; }
@media (max-width: 760px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
`;

const SCRIPT = `
(() => {
  const tips = JSON.parse(document.getElementById("tips").textContent);
  const tip = document.getElementById("tip");
  const show = (el) => {
    const t = tips[el.dataset.mark];
    if (!t) return;
    tip.replaceChildren();
    const title = document.createElement("div");
    title.className = "tip-title";
    title.textContent = t.title;
    tip.append(title);
    for (const [label, value] of t.rows) {
      const row = document.createElement("div");
      row.className = "tip-row";
      const v = document.createElement("strong");
      v.textContent = value;
      const l = document.createElement("span");
      l.textContent = label;
      row.append(v, l);
      tip.append(row);
    }
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = r.right + 12, y = r.top - 8;
    if (x + w > window.innerWidth - 8) x = r.left - w - 12;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  };
  const hide = () => { tip.hidden = true; };
  for (const el of document.querySelectorAll(".mk")) {
    el.addEventListener("pointerenter", () => show(el));
    el.addEventListener("pointerleave", hide);
    el.addEventListener("focus", () => show(el));
    el.addEventListener("blur", hide);
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  for (const btn of document.querySelectorAll("button.diff")) {
    btn.addEventListener("click", () => {
      const section = btn.closest("section");
      const turnOn = !btn.classList.contains("active");
      for (const el of section.querySelectorAll(".active, .hl")) el.classList.remove("active", "hl");
      for (const svg of section.querySelectorAll("svg.chart")) svg.classList.remove("has-hl");
      btn.setAttribute("aria-pressed", "false");
      if (!turnOn) return;
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
      let first = null;
      for (const mark of btn.dataset.marks.split(" ")) {
        for (const el of section.querySelectorAll('[data-mark="' + CSS.escape(mark) + '"]')) {
          el.classList.add("hl");
          el.closest("svg").classList.add("has-hl");
          first = first || el;
        }
      }
      if (first) first.closest("figure").scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }
})();
`;

function page(title: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
${script}
</body>
</html>
`;
}

function toneClass(tone: Tone): string {
  return tone == null ? "" : ` ${tone}`;
}

function tilesHtml(tiles: readonly Tile[]): string {
  if (tiles.length === 0) return "";
  return `<div class="tiles">${tiles
    .map(
      (t) =>
        `<div class="tile" title="${escapeHtml(t.title)}"><div class="label">${escapeHtml(t.label)}</div>` +
        `<div class="value${toneClass(t.tone)}">${escapeHtml(t.value)}</div></div>`,
    )
    .join("")}</div>`;
}

// ── The chart ────────────────────────────────────────────────────────────

const W = 1100;
const H = 340;
const PAD_LEFT = 8;
const PAD_RIGHT = 78;
const PAD_TOP = 20;
const PAD_BOTTOM = 24;
const PLOT_W = W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = H - PAD_TOP - PAD_BOTTOM;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const PRICE_PAD_FRACTION = 0.06;
const PRICE_TICK_TARGET = 6;
const MAX_HOURLY_TICKS = 12;
/** Live sits left of the bar's centre and the backtest right, so two marks
 *  on one bar at one price stay two marks. */
const SERIES_OFFSET = 4;
const ENTRY_HALF = 7;
const EXIT_RADIUS = 5;
const SQUARE_HALF = 4.5;
const BLOCKED_HALF = 5;
/** A pointer target well past the painted glyph. */
const HIT_RADIUS = 12;
const BLOCKED_RUG_INSET = 10;
/** Half the width of an `HH:MM` axis label at 11px mono, plus a margin. */
const TIME_LABEL_HALF = 22;

function fmt(n: number): string {
  return n.toFixed(1);
}

function niceStep(raw: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** Up for a long, down for a short: `dir` is −1 up the screen. */
function directionOf(side: number): 1 | -1 {
  return side === 1 ? 1 : -1;
}

function liveEntryPath(cx: number, cy: number, side: number): string {
  const d = directionOf(side);
  const s = ENTRY_HALF;
  return `M${fmt(cx)} ${fmt(cy + d * s)}L${fmt(cx + s)} ${fmt(cy - d * s * 0.85)}L${fmt(cx - s)} ${fmt(cy - d * s * 0.85)}Z`;
}

/** A block arrow: a different silhouette from the live triangle, same direction rule. */
function backtestEntryPath(cx: number, cy: number, side: number): string {
  const d = directionOf(side);
  const s = ENTRY_HALF;
  const stem = s * 0.4;
  const pts: Array<[number, number]> = [
    [cx, cy + d * s],
    [cx + s, cy],
    [cx + stem, cy],
    [cx + stem, cy - d * s],
    [cx - stem, cy - d * s],
    [cx - stem, cy],
    [cx - s, cy],
  ];
  return `M${pts.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join("L")}Z`;
}

function legendHtml(hasBlocked: boolean): string {
  const icon = (inner: string, w = 16) =>
    `<svg width="${w}" height="16" viewBox="0 0 ${w} 16" aria-hidden="true">${inner}</svg>`;
  const items = [
    `<span>${icon(`<path class="glyph" style="fill:var(--series-live)" d="${liveEntryPath(8, 8, 0)}"/>`)}Live entry</span>`,
    `<span>${icon(`<circle class="glyph" style="fill:var(--series-live)" cx="8" cy="8" r="${EXIT_RADIUS}"/>`)}Live exit</span>`,
    `<span>${icon(`<line class="link-live" x1="1" y1="8" x2="21" y2="8"/>`, 22)}Live trade</span>`,
    `<span>${icon(`<path class="glyph" style="fill:var(--series-backtest)" d="${backtestEntryPath(8, 8, 0)}"/>`)}Backtest entry</span>`,
    `<span>${icon(`<rect class="glyph" style="fill:var(--series-backtest)" x="${8 - SQUARE_HALF}" y="${8 - SQUARE_HALF}" width="${SQUARE_HALF * 2}" height="${SQUARE_HALF * 2}"/>`)}Backtest exit</span>`,
    `<span>${icon(`<line class="link-backtest" x1="1" y1="8" x2="21" y2="8"/>`, 22)}Backtest trade</span>`,
    ...(hasBlocked
      ? [
          `<span>${icon(`<g class="blocked"><path class="glyph" d="M3 3L13 13M13 3L3 13"/></g>`)}Blocked signal</span>`,
        ]
      : []),
    `<span>Entries point up for a long, down for a short</span>`,
  ];
  return `<div class="legend">${items.join("")}</div>`;
}

function chartSvg(chart: ChartView): string {
  const { window: win } = chart;
  const span = win.endMs - win.startMs;
  const candleMs = chart.candleMinutes * MS_PER_MINUTE;
  const x = (ms: number) => PAD_LEFT + ((ms - win.startMs) / span) * PLOT_W;
  const barCentre = (ms: number) => x(Math.floor(ms / candleMs) * candleMs + candleMs / 2);

  const prices = [
    ...chart.candles.flatMap((c) => [c.high, c.low]),
    ...chart.trades.flatMap((t) => [t.entry?.price, t.exit?.price]).filter((p): p is number => p != null),
  ];
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const pad = (hi - lo) * PRICE_PAD_FRACTION;
  lo -= pad;
  hi += pad;
  const y = (price: number) => PAD_TOP + ((hi - price) / (hi - lo)) * PLOT_H;

  const parts: string[] = [];
  // The cash session, under everything.
  const cashX0 = Math.max(PAD_LEFT, x(chart.cash.startMs));
  const cashX1 = Math.min(PAD_LEFT + PLOT_W, x(chart.cash.endMs));
  if (cashX1 > cashX0) {
    parts.push(`<rect class="cash" x="${fmt(cashX0)}" y="${PAD_TOP}" width="${fmt(cashX1 - cashX0)}" height="${PLOT_H}"/>`);
    parts.push(
      `<text class="stamp" x="${fmt(cashX0 + 4)}" y="${PAD_TOP - 7}">CASH SESSION ${escapeHtml(
        `${etClock(chart.cash.startMs).replace(" ET", "")}–${etClock(chart.cash.endMs)}`,
      )}</text>`,
    );
  }

  // Price grid and axis, on the right as a trading chart has it.
  const step = niceStep((hi - lo) / PRICE_TICK_TARGET);
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const py = y(p);
    parts.push(`<line class="grid" x1="${PAD_LEFT}" x2="${PAD_LEFT + PLOT_W}" y1="${fmt(py)}" y2="${fmt(py)}"/>`);
    parts.push(
      `<text x="${PAD_LEFT + PLOT_W + 6}" y="${fmt(py + 4)}">${escapeHtml(
        p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      )}</text>`,
    );
  }
  // Time axis: whole hours (ET is a whole-hour offset from UTC).
  const hours = Math.ceil(span / MS_PER_HOUR);
  const hourStep = hours > MAX_HOURLY_TICKS ? 2 : 1;
  for (let t = Math.ceil(win.startMs / MS_PER_HOUR) * MS_PER_HOUR; t <= win.endMs; t += MS_PER_HOUR * hourStep) {
    const tx = x(t);
    parts.push(`<line class="grid" x1="${fmt(tx)}" x2="${fmt(tx)}" y1="${PAD_TOP}" y2="${PAD_TOP + PLOT_H}"/>`);
    // A centred label this close to an edge is clipped by it; the grid line stays.
    if (tx < PAD_LEFT + TIME_LABEL_HALF || tx > PAD_LEFT + PLOT_W - TIME_LABEL_HALF) continue;
    parts.push(`<text x="${fmt(tx)}" y="${H - 7}" text-anchor="middle">${escapeHtml(etClock(t).replace(" ET", ""))}</text>`);
  }
  parts.push(`<text x="${PAD_LEFT + PLOT_W + 6}" y="${H - 7}">ET</text>`);

  // Candles.
  const bodyW = Math.max(1, (PLOT_W * candleMs) / span - 2);
  for (const c of chart.candles) {
    const cx = x(c.ms + candleMs / 2);
    const up = c.close >= c.open;
    const top = y(Math.max(c.open, c.close));
    const height = Math.max(1, y(Math.min(c.open, c.close)) - top);
    parts.push(
      `<line class="wick ${up ? "up-wick" : "down-wick"}" x1="${fmt(cx)}" x2="${fmt(cx)}" y1="${fmt(y(c.high))}" y2="${fmt(y(c.low))}"/>` +
        `<rect class="${up ? "up" : "down"}" x="${fmt(cx - bodyW / 2)}" y="${fmt(top)}" width="${fmt(bodyW)}" height="${fmt(height)}"/>`,
    );
  }

  const candleClose = new Map(chart.candles.map((c) => [c.ms, c.close]));
  const markParts: string[] = [];
  const linkParts: string[] = [];
  for (const t of chart.trades) {
    const offset = t.source === "live" ? -SERIES_OFFSET : SERIES_OFFSET;
    const entry = t.entry == null ? null : { x: barCentre(t.entry.ms) + offset, y: y(t.entry.price) };
    const exit = t.exit == null ? null : { x: barCentre(t.exit.ms) + offset, y: y(t.exit.price) };
    const mark = escapeHtml(t.mark);
    if (entry != null && exit != null) {
      linkParts.push(
        `<line class="link-${t.source}" data-mark="${mark}" x1="${fmt(entry.x)}" y1="${fmt(entry.y)}" x2="${fmt(exit.x)}" y2="${fmt(exit.y)}"/>`,
      );
    }
    const label = `${t.source === "live" ? "Live" : "Backtest"} ${t.side === 1 ? "short" : "long"}`;
    if (entry != null) {
      const d = t.source === "live" ? liveEntryPath(entry.x, entry.y, t.side) : backtestEntryPath(entry.x, entry.y, t.side);
      markParts.push(
        `<g class="mk ${t.source}" data-mark="${mark}" tabindex="0" role="img" aria-label="${escapeHtml(`${label} entry`)}">` +
          `<circle class="hit" cx="${fmt(entry.x)}" cy="${fmt(entry.y)}" r="${HIT_RADIUS}"/><path class="glyph" d="${d}"/></g>`,
      );
    }
    if (exit != null) {
      const glyph =
        t.source === "live"
          ? `<circle class="glyph" cx="${fmt(exit.x)}" cy="${fmt(exit.y)}" r="${EXIT_RADIUS}"/>`
          : `<rect class="glyph" x="${fmt(exit.x - SQUARE_HALF)}" y="${fmt(exit.y - SQUARE_HALF)}" width="${SQUARE_HALF * 2}" height="${SQUARE_HALF * 2}"/>`;
      markParts.push(
        `<g class="mk ${t.source}" data-mark="${mark}" tabindex="0" role="img" aria-label="${escapeHtml(`${label} exit`)}">` +
          `<circle class="hit" cx="${fmt(exit.x)}" cy="${fmt(exit.y)}" r="${HIT_RADIUS}"/>${glyph}</g>`,
      );
    }
  }
  for (const b of chart.blocked) {
    const bucket = Math.floor(b.ms / candleMs) * candleMs;
    const close = candleClose.get(bucket);
    // With no bar to sit on, a blocked signal is a rug mark along the bottom.
    const by = close == null ? PAD_TOP + PLOT_H - BLOCKED_RUG_INSET : y(close);
    const bx = barCentre(b.ms);
    const s = BLOCKED_HALF;
    markParts.push(
      `<g class="mk blocked" data-mark="${escapeHtml(b.mark)}" tabindex="0" role="img" aria-label="Blocked signal">` +
        `<circle class="hit" cx="${fmt(bx)}" cy="${fmt(by)}" r="${HIT_RADIUS}"/>` +
        `<path class="glyph" d="M${fmt(bx - s)} ${fmt(by - s)}L${fmt(bx + s)} ${fmt(by + s)}M${fmt(bx + s)} ${fmt(by - s)}L${fmt(bx - s)} ${fmt(by + s)}"/></g>`,
    );
  }

  return (
    `<svg class="chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="${escapeHtml(`${chart.ticker} price, session candles with live and backtest trades`)}">` +
    parts.join("") +
    linkParts.join("") +
    markParts.join("") +
    `</svg>`
  );
}

function chartHtml(chart: ChartView): string {
  const what = `${chart.ticker} · ${chart.candleMinutes}-minute candles`;
  return (
    `<figure class="chart"><figcaption><span class="what">${escapeHtml(what)}</span>${legendHtml(chart.blocked.length > 0)}</figcaption>` +
    chartSvg(chart) +
    (chart.barsNote == null ? "" : `<p class="note">${escapeHtml(chart.barsNote)}</p>`) +
    `</figure>`
  );
}

// ── Differences and tables ───────────────────────────────────────────────

function diffItemHtml(item: DifferenceItem, clickable: boolean): string {
  const logs = logEvidenceHtml(item.logs);
  if (!clickable || item.marks.length === 0) return `<li><span class="diff-text">${escapeHtml(item.text)}</span>${logs}</li>`;
  return `<li><button type="button" class="diff" aria-pressed="false" data-marks="${escapeHtml(item.marks.join(" "))}">${escapeHtml(item.text)}</button>${logs}</li>`;
}

/** One side's four cells; a side that did not trade says so in each. */
function sideCells(cells: TableRow["live"]): string {
  if (cells == null) {
    return `<td class="first-of-group empty">—</td><td class="empty">—</td><td class="empty">—</td><td class="empty">—</td>`;
  }
  const pnlCls = cells.pnlSign == null || cells.pnlSign === 0 ? "" : cells.pnlSign > 0 ? ' class="pos"' : ' class="neg"';
  return (
    `<td class="first-of-group">${escapeHtml(cells.entry)}</td><td>${escapeHtml(cells.exit)}</td>` +
    `<td>${escapeHtml(cells.reason)}</td><td${pnlCls}>${escapeHtml(cells.pnl)}</td>`
  );
}

function tableHtml(rows: readonly TableRow[], backtestWord: string): string {
  if (rows.length === 0) return `<p class="clean">No trades on either side.</p>`;
  const head =
    `<thead><tr><th colspan="3"></th><th class="group" colspan="4">Live</th><th class="group" colspan="4">${escapeHtml(backtestWord)}</th><th class="group" colspan="2"></th></tr>` +
    `<tr><th>Signal bar</th><th>Playbook</th><th>Side</th>` +
    `<th class="first-of-group">Entry</th><th>Exit</th><th>Exit reason</th><th>P&amp;L</th>` +
    `<th class="first-of-group">Entry</th><th>Exit</th><th>Exit reason</th><th>P&amp;L</th>` +
    `<th class="first-of-group">Slippage</th><th>Result</th></tr></thead>`;
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.signalBar)}</td><td>${escapeHtml(r.playbook)}</td><td>${escapeHtml(r.side)}</td>` +
        sideCells(r.live) +
        sideCells(r.backtest) +
        `<td class="first-of-group">${escapeHtml(r.slippage)}</td><td>${escapeHtml(r.result)}</td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table>${head}<tbody>${body}</tbody></table></div>`;
}

function noDifferences(matched: number, backtestWord: string): string {
  return matched === 0
    ? `Neither live nor ${backtestWord} entered.`
    : `No differences: ${matched} entr${matched === 1 ? "y" : "ies"} matched, with the same exits and no slippage.`;
}

function accountHtml(acct: AccountView): string {
  const head =
    `<div class="account-head"><h2>${escapeHtml(acct.title)}</h2>` +
    `<p class="sub">Every playbook on the account backtested together — one position per contract, the account's daily limit — against all of its live trades.</p></div>`;
  if (acct.refusal != null) {
    return `<section class="account" id="${escapeHtml(acct.key)}">${head}<p class="refusal">Not compared: ${escapeHtml(acct.refusal)}</p></section>`;
  }
  const matched = acct.tiles.find((t) => t.label === "Matched")?.value ?? "0";
  const diffs =
    acct.groups.length === 0
      ? `<p class="clean">${escapeHtml(noDifferences(Number(matched), "the book"))}</p>`
      : acct.groups
          .map((g) => `<h4>${escapeHtml(g.name)}</h4><ol class="diffs">${g.items.map((i) => diffItemHtml(i, acct.charts.length > 0)).join("")}</ol>`)
          .join("");
  return (
    `<section class="account" id="${escapeHtml(acct.key)}">${head}` +
    acct.notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join("") +
    tilesHtml(acct.tiles) +
    (acct.charts.length === 0 ? `<p class="clean spaced">No trades on this account in the session.</p>` : acct.charts.map(chartHtml).join("")) +
    `<h3>Differences</h3>${diffs}` +
    `<h3>Every trade, live beside the book</h3>${tableHtml(acct.rows, "Book")}` +
    `</section>`
  );
}

function legHtml(leg: LegView): string {
  const head = `<h4>${escapeHtml(leg.title)}</h4>`;
  if (leg.refusal != null) return `<div class="leg">${head}<p class="refusal">Not compared: ${escapeHtml(leg.refusal)}</p></div>`;
  const matched = Number(leg.tiles.find((t) => t.label === "Matched")?.value ?? "0");
  return (
    `<div class="leg">${head}` +
    leg.notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join("") +
    tilesHtml(leg.tiles) +
    `<h3>Differences</h3>` +
    (leg.items.length === 0
      ? `<p class="clean">${escapeHtml(noDifferences(matched, "the backtest"))}</p>`
      : `<ul class="plain">${leg.items.map((i) => `<li>${escapeHtml(i.text)}${logEvidenceHtml(i.logs)}</li>`).join("")}</ul>`) +
    `<h3>Every trade, live beside this playbook's backtest</h3>${tableHtml(leg.rows, "Backtest")}` +
    `</div>`
  );
}

/** A `<script>` body may not contain `</script>`; JSON may. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderReport(view: ReportView): string {
  const accounts =
    view.accounts == null
      ? `<p class="note">This day has no book comparison: each playbook alone is below.</p>`
      : view.accounts.map(accountHtml).join("");
  const legs =
    view.legs == null
      ? ""
      : `<details class="legs"${view.accounts == null ? " open" : ""}><summary>Each playbook alone` +
        `<span class="sub">${view.legs.length} playbook${view.legs.length === 1 ? "" : "s"}, each backtested on its own and compared with its own live trades</span></summary>` +
        view.legs.map(legHtml).join("") +
        `</details>`;
  const body =
    `<header class="page-head"><nav><a href="../index.html">All days</a></nav>` +
    `<h1>Live against backtest · session ${escapeHtml(view.date)}</h1>` +
    `<p class="sub">What each account's playbooks did live, beside what the backtest did on the same bars. Hover a mark for the trade; select a difference to find it on the chart.</p>` +
    view.notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join("") +
    `</header><main>` +
    (view.notesMarkdown == null ? "" : notesHtml(view.notesMarkdown)) +
    accounts +
    (view.irregularities == null ? "" : irregularitiesHtml(view.irregularities)) +
    `${legs}</main>` +
    `<div id="tip" role="tooltip" hidden></div>`;
  const script =
    `<script type="application/json" id="tips">${jsonForScript(view.tips)}</script>` + `<script>${SCRIPT}</script>`;
  return page(`Parity ${view.date}`, body, script);
}

/** What a day gets when its report could not be built: the reason, its notes
 *  and the summary the run wrote, so the day is still readable. */
export function renderFallback(date: string, reason: string, summary: string | null, notes: string | null = null): string {
  const body =
    `<header class="page-head"><nav><a href="../index.html">All days</a></nav>` +
    `<h1>Live against backtest · session ${escapeHtml(date)}</h1></header><main>` +
    `<p class="refusal">The report for this day could not be built: ${escapeHtml(reason)}</p>` +
    (notes == null ? "" : notesHtml(notes)) +
    `<p class="sub">The day's comparison itself is recorded in full. Its summary follows.</p>` +
    (summary == null ? "" : `<pre class="mono summary">${escapeHtml(summary)}</pre>`) +
    `</main>`;
  return page(`Parity ${date}`, body, "");
}

function count(n: number | null): string {
  return n == null ? "—" : String(n);
}

export function renderIndex(rows: readonly IndexRow[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr><td><a href="${escapeHtml(`${r.date}/report.html`)}">${escapeHtml(r.date)}</a></td>` +
        `<td>${count(r.accounts)}</td><td>${count(r.matched)}</td><td>${count(r.missed)}</td><td>${count(r.extra)}</td><td>${count(r.blocked)}</td>` +
        `<td class="${r.livePnlTone ?? ""}">${escapeHtml(r.livePnl)}</td><td class="${r.bookPnlTone ?? ""}">${escapeHtml(r.bookPnl)}</td>` +
        `<td class="prose">${escapeHtml(r.note ?? "")}</td>` +
        `<td>${r.hasNotes ? `<a href="${escapeHtml(`${r.date}/report.html#notes`)}">Notes</a>` : ""}</td></tr>`,
    )
    .join("");
  const html =
    `<header class="page-head"><h1>Live against backtest · every day</h1>` +
    `<p class="sub">One row per session, newest first, counted over every account's book. Open a day for its charts and every difference.</p></header><main>` +
    (rows.length === 0
      ? `<p class="clean">No day has been compared yet.</p>`
      : `<div class="table-wrap spaced"><table><thead><tr><th>Session</th><th>Accounts</th><th>Matched</th><th>Missed</th><th>Extra</th><th>Blocked</th><th>Live P&amp;L</th><th>Book P&amp;L</th><th>Note</th><th>Notes</th></tr></thead><tbody>${body}</tbody></table></div>`) +
    `</main>`;
  return page("Parity — every day", html, "");
}

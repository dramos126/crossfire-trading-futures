import {
  exitColor,
  exitLabel,
  type TradeMarker,
} from "@/components/chart/trade-markers";

/**
 * The line colours are the overlay's own tokens (`resolvePalette`), so a
 * swatch and the stroke it names cannot drift apart.
 */
const LINE_ENTRY = "var(--accent-blue)";
const LINE_TP = "var(--success)";
const LINE_SL = "var(--danger)";
const LINE_BEST = "var(--success-dim)";
const LINE_WORST = "var(--danger-dim)";

/**
 * Legend for a chart showing one trade. Lists only what this trade's chart
 * draws, one entry per thing — a legend that names every possible line
 * reads as two TPs when a marker and a line share a colour.
 */
export function TradeLegend({ marker }: { marker: TradeMarker }) {
  const isLong = marker.side === 0;
  const exitGlyph =
    marker.exitReason === "tp" ? (isLong ? "▲" : "▼")
    : marker.exitReason === "sl" ? (isLong ? "▼" : "▲")
    : "●";
  return (
    <>
      <LegendSwatch color={LINE_ENTRY} dashed label={`Entry ${isLong ? "▲" : "▼"}`} />
      {marker.exitTime != null && (
        <LegendSwatch
          color={exitColor(marker.exitReason, marker.isWin)}
          label={`Exit ${exitLabel(marker.exitReason, null, marker.exitCode)} ${exitGlyph}`}
        />
      )}
      {marker.tpPrice != null && <LegendSwatch color={LINE_TP} dashed label="TP" />}
      {marker.slPrice != null && (
        <LegendSwatch color={LINE_SL} dashed label={marker.breakEvenMoved ? "SL (moved to BE)" : "SL"} />
      )}
      {marker.mfePrice != null && <LegendSwatch color={LINE_BEST} dotted label="Best price reached" />}
      {marker.maePrice != null && <LegendSwatch color={LINE_WORST} dotted label="Worst price reached" />}
      {marker.exitTime == null && <span>Faded lines: trade still open</span>}
    </>
  );
}

/** Legend for a chart showing many trades: the line roles once, then the
 *  three exit glyphs, whose colour is how the trade ended. */
export function MultiTradeLegend() {
  return (
    <>
      <LegendSwatch color={LINE_ENTRY} dashed label="Entry ▲▼" />
      <LegendSwatch color={LINE_TP} dashed label="TP" />
      <LegendSwatch color={LINE_SL} dashed label="SL" />
      <LegendSwatch color={exitColor("tp", true)} label="Exit at TP ▲▼" />
      <LegendSwatch color={exitColor("sl", false)} label="Exit at SL ▼▲" />
      <LegendSwatch color={exitColor(null, null)} label="Other exit ●" />
    </>
  );
}

/**
 * The swatch mirrors the canvas stroke it stands for: solid for a marker,
 * 4-on-4-off for a bracket line, 1-on-3-off for an excursion — the dash
 * patterns `drawBrackets` uses.
 */
export function LegendSwatch({
  color,
  label,
  dashed = false,
  dotted = false,
  hollow = false,
  faded = false,
}: {
  color: string;
  label: string;
  dashed?: boolean;
  dotted?: boolean;
  /** Empty ring instead of a bar — matches the backtest replay's hollow
   *  markers on the live per-trade chart. */
  hollow?: boolean;
  /** At --bt-bracket-alpha, for the ghosted backtest replay lines. */
  faded?: boolean;
}) {
  if (hollow) {
    return (
      <span className="flex items-center gap-1">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <circle cx="5" cy="5" r="3.5" fill="none" stroke={color} strokeWidth="1.5" />
        </svg>
        <span>{label}</span>
      </span>
    );
  }
  const stroke = dotted
    ? { backgroundImage: `repeating-linear-gradient(to right, ${color} 0 1px, transparent 1px 4px)` }
    : dashed
      ? { backgroundImage: `repeating-linear-gradient(to right, ${color} 0 4px, transparent 4px 8px)` }
      : { backgroundColor: color };
  return (
    <span className="flex items-center gap-1" style={faded ? { opacity: 0.4 } : undefined}>
      <span className="inline-block w-4 h-px" style={stroke} />
      <span>{label}</span>
    </span>
  );
}

/**
 * Internal parquet I/O helpers used by ParquetCacheBarSource and the Phase 2
 * fetcher (when it lands). Centralises the parquet-wasm + apache-arrow init
 * dance and the conversion between canonical bar rows and Arrow tables.
 *
 * Why ESM init: parquet-wasm's CJS Node entry has a packaging bug
 * (package.json declares "type": "module" but node/parquet_wasm.js uses
 * module.exports). The ESM entry works in both Node and Next.js server
 * runtime; we standardise on it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Table as ArrowTable,
  Vector,
  Float64,
  Int64,
  TimestampNanosecond,
  Utf8,
  makeData,
  vectorFromArray,
  tableToIPC,
  tableFromIPC,
} from "apache-arrow";

import type { Bar } from "./bar-source";

let wasmReady: Promise<void> | null = null;

async function ensureWasmReady(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const mod = await import("parquet-wasm/esm");
      const wasmUrl = new URL(
        "../../../node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm",
        import.meta.url,
      );
      const wasmBytes = readFileSync(fileURLToPath(wasmUrl));
      await mod.default({ module_or_path: wasmBytes });
    })();
  }
  return wasmReady;
}

async function getWasm() {
  await ensureWasmReady();
  return import("parquet-wasm/esm");
}

export async function readParquetToBars(parquetBytes: Uint8Array): Promise<Bar[]> {
  const wasm = await getWasm();
  const wasmTable = wasm.readParquet(parquetBytes);
  const ipc = wasmTable.intoIPCStream();
  const table = tableFromIPC(ipc);
  return arrowTableToBars(table);
}

export async function writeBarsToParquet(bars: Bar[]): Promise<Uint8Array> {
  const wasm = await getWasm();
  const table = barsToArrowTable(bars);
  const ipc = tableToIPC(table, "stream");
  const wasmTable = wasm.Table.fromIPCStream(ipc);
  const props = new wasm.WriterPropertiesBuilder()
    .setCompression(wasm.Compression.ZSTD)
    .build();
  return wasm.writeParquet(wasmTable, props);
}

function barsToArrowTable(bars: Bar[]): ArrowTable {
  const n = bars.length;
  const tsBuf = new BigInt64Array(n);
  const openBuf = new Float64Array(n);
  const highBuf = new Float64Array(n);
  const lowBuf = new Float64Array(n);
  const closeBuf = new Float64Array(n);
  const volBuf = new BigInt64Array(n);
  const symbols: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    tsBuf[i] = b.tsUtc;
    openBuf[i] = b.open;
    highBuf[i] = b.high;
    lowBuf[i] = b.low;
    closeBuf[i] = b.close;
    volBuf[i] = b.volume;
    symbols[i] = b.symbol;
  }
  const tsVec = new Vector([
    makeData({ type: new TimestampNanosecond(), data: tsBuf, length: n }),
  ]);
  const openVec = new Vector([
    makeData({ type: new Float64(), data: openBuf, length: n }),
  ]);
  const highVec = new Vector([
    makeData({ type: new Float64(), data: highBuf, length: n }),
  ]);
  const lowVec = new Vector([
    makeData({ type: new Float64(), data: lowBuf, length: n }),
  ]);
  const closeVec = new Vector([
    makeData({ type: new Float64(), data: closeBuf, length: n }),
  ]);
  const volVec = new Vector([
    makeData({ type: new Int64(), data: volBuf, length: n }),
  ]);
  const symVec = vectorFromArray(symbols, new Utf8());
  return new ArrowTable({
    ts_utc: tsVec,
    open: openVec,
    high: highVec,
    low: lowVec,
    close: closeVec,
    volume: volVec,
    symbol: symVec,
  });
}

function arrowTableToBars(table: ArrowTable): Bar[] {
  const tsCol = table.getChild("ts_utc");
  const openCol = table.getChild("open");
  const highCol = table.getChild("high");
  const lowCol = table.getChild("low");
  const closeCol = table.getChild("close");
  const volCol = table.getChild("volume");
  const symCol = table.getChild("symbol");
  if (!tsCol || !openCol || !highCol || !lowCol || !closeCol || !volCol || !symCol) {
    throw new Error("parquet file missing one or more canonical OHLCV columns");
  }
  const n = table.numRows;
  const bars: Bar[] = new Array(n);
  // Read ts via the underlying BigInt64Array buffers — Arrow JS's TimestampNanosecond
  // getter returns ms-as-number for JS-Date convenience and would lose nanosecond fidelity.
  let cursor = 0;
  for (const data of tsCol.data) {
    const buf = data.values as unknown as BigInt64Array;
    for (let i = 0; i < data.length; i++) {
      const tsUtc = buf[i];
      const open = openCol.get(cursor) as number;
      const high = highCol.get(cursor) as number;
      const low = lowCol.get(cursor) as number;
      const close = closeCol.get(cursor) as number;
      const volRaw = volCol.get(cursor);
      const volume = typeof volRaw === "bigint" ? volRaw : BigInt(volRaw as number);
      const symbol = symCol.get(cursor) as string;
      bars[cursor] = { tsUtc, open, high, low, close, volume, symbol };
      cursor++;
    }
  }
  return bars;
}

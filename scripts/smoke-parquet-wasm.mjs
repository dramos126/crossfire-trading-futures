#!/usr/bin/env node
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
import initWasm, {
  Table as WasmTable,
  writeParquet,
  readParquet,
  WriterPropertiesBuilder,
  Compression,
} from "parquet-wasm/esm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wasmPath = fileURLToPath(
  new URL("../node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm", import.meta.url),
);
await initWasm({ module_or_path: readFileSync(wasmPath) });

const tsValues = [
  1700000000000000000n,
  1700000060000000000n,
  1700000120000000000n,
];

const tsBuf = BigInt64Array.from(tsValues);
const tsData = makeData({ type: new TimestampNanosecond(), data: tsBuf, length: tsBuf.length });
const tsVec = new Vector([tsData]);

const opens = Float64Array.from([100.25, 100.5, 100.75]);
const highs = Float64Array.from([100.75, 101.0, 101.25]);
const lows = Float64Array.from([100.0, 100.25, 100.5]);
const closes = Float64Array.from([100.5, 100.75, 101.0]);
const volumes = BigInt64Array.from([10n, 20n, 30n]);

const openVec = new Vector([makeData({ type: new Float64(), data: opens, length: opens.length })]);
const highVec = new Vector([makeData({ type: new Float64(), data: highs, length: highs.length })]);
const lowVec = new Vector([makeData({ type: new Float64(), data: lows, length: lows.length })]);
const closeVec = new Vector([makeData({ type: new Float64(), data: closes, length: closes.length })]);
const volVec = new Vector([makeData({ type: new Int64(), data: volumes, length: volumes.length })]);
const symVec = vectorFromArray(["ES.c.0", "ES.c.0", "ES.c.0"], new Utf8());

const table = new ArrowTable({
  ts_utc: tsVec,
  open: openVec,
  high: highVec,
  low: lowVec,
  close: closeVec,
  volume: volVec,
  symbol: symVec,
});

console.log("Arrow table built. rows =", table.numRows, "cols =", table.numCols);

const ipc = tableToIPC(table, "stream");
const wasmTable = WasmTable.fromIPCStream(ipc);
const props = new WriterPropertiesBuilder().setCompression(Compression.ZSTD).build();
const parquetBytes = writeParquet(wasmTable, props);
console.log("Wrote parquet bytes:", parquetBytes.byteLength);

const wasmTable2 = readParquet(parquetBytes);
const ipc2 = wasmTable2.intoIPCStream();
const table2 = tableFromIPC(ipc2);
console.log("Read back rows:", table2.numRows);

const tsCol = table2.getChild("ts_utc");
const openCol = table2.getChild("open");
const symCol = table2.getChild("symbol");
console.log("ts[0] raw =", tsCol.get(0));
console.log("open[0] =", openCol.get(0));
console.log("symbol[0] =", symCol.get(0));

const expectedTs = tsValues[0];
const tsRawValues = tsCol.data[0].values;
console.log("ts raw underlying buffer[0] =", tsRawValues[0]);
const actualTs = tsRawValues[0];
if (actualTs !== expectedTs) {
  console.error(`ts roundtrip failed: expected ${expectedTs}, got ${actualTs}`);
  process.exit(1);
}
console.log("Nanosecond ts roundtrip OK (raw BigInt64Array preserved).");

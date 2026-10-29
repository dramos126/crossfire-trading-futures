import { describe, it, expect } from "vitest";

import { buildFolds } from "./folds";

const GEOMETRY = { trainMonths: 18, testMonths: 6, stepMonths: 6 };

describe("buildFolds", () => {
  it("cuts one 18/6 fold over exactly two years, spanning the year boundary", () => {
    const folds = buildFolds({ from: "2023-01-03", to: "2024-12-31", ...GEOMETRY });
    expect(folds).toEqual([
      {
        foldId: 0,
        train: { from: "2023-01-03", to: "2024-06-30" },
        test: { from: "2024-07-01", to: "2024-12-31" },
      },
    ]);
  });

  it("steps by six months and rolls the training window forward", () => {
    const folds = buildFolds({ from: "2021-01-01", to: "2024-12-31", ...GEOMETRY });
    expect(folds.map((f) => [f.train.from, f.train.to, f.test.from, f.test.to])).toEqual([
      ["2021-01-01", "2022-06-30", "2022-07-01", "2022-12-31"],
      ["2021-07-01", "2022-12-31", "2023-01-01", "2023-06-30"],
      ["2022-01-01", "2023-06-30", "2023-07-01", "2023-12-31"],
      ["2022-07-01", "2023-12-31", "2024-01-01", "2024-06-30"],
      ["2023-01-01", "2024-06-30", "2024-07-01", "2024-12-31"],
    ]);
  });

  it("emits nothing when the range cannot hold one whole train+test", () => {
    expect(buildFolds({ from: "2023-01-03", to: "2024-11-30", ...GEOMETRY })).toEqual([]);
  });

  it("clamps the first training window to --from", () => {
    const folds = buildFolds({ from: "2023-01-17", to: "2024-12-31", ...GEOMETRY });
    expect(folds[0].train.from).toBe("2023-01-17");
    expect(folds[0].test).toEqual({ from: "2024-07-01", to: "2024-12-31" });
  });

  it("drops a fold whose test window would run past --to rather than clamping it", () => {
    expect(buildFolds({ from: "2023-01-17", to: "2024-12-15", ...GEOMETRY })).toEqual([]);
  });

  it("keeps a month-end training boundary on a leap February", () => {
    const folds = buildFolds({
      from: "2022-09-01",
      to: "2024-08-31",
      trainMonths: 6,
      testMonths: 6,
      stepMonths: 6,
    });
    expect(folds[1]).toEqual({
      foldId: 1,
      train: { from: "2023-03-01", to: "2023-08-31" },
      test: { from: "2023-09-01", to: "2024-02-29" },
    });
  });
});

import { describe, it, expect } from "vitest";

import { slugOfName } from "./key-slug";

describe("slugOfName", () => {
  it("gives the six production-shaped keys from their display names", () => {
    expect(slugOfName("Alpha Breakout (capped) — MNQ")).toBe("alpha-breakout-capped-mnq");
    expect(slugOfName("Beta Pullback Fade — MNQ")).toBe("beta-pullback-fade-mnq");
    expect(slugOfName("Gamma Hold — MNQ")).toBe("gamma-hold-mnq");
    expect(slugOfName("Delta Structure Break — MES")).toBe("delta-structure-break-mes");
    expect(slugOfName("Epsilon Close Break — MES")).toBe("epsilon-close-break-mes");
    expect(slugOfName("Gamma Hold — MES")).toBe("gamma-hold-mes");
  });

  it("folds accents to ASCII and trims separators at either end", () => {
    expect(slugOfName("  Café  Fade (v2) — ")).toBe("cafe-fade-v2");
  });
});

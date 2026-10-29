import { describe, it, expect, beforeEach } from "vitest";
import { noteTopstepRequest, noteTopstepResponse, takeTopstepRequestWindow } from "./request-counter";

beforeEach(() => {
  takeTopstepRequestWindow();
});

describe("takeTopstepRequestWindow", () => {
  it("reports an empty window as zero", () => {
    expect(takeTopstepRequestWindow()).toBe("rest 0/win");
  });

  it("lists every path busiest first, with its refusals", () => {
    for (let i = 0; i < 3; i++) noteTopstepRequest("/api/Position/searchOpen");
    noteTopstepResponse("/api/Position/searchOpen", 429);
    noteTopstepResponse("/api/Position/searchOpen", 200);
    noteTopstepRequest("/api/Order/searchOpen");
    noteTopstepResponse("/api/Order/searchOpen", 200);

    expect(takeTopstepRequestWindow()).toBe(
      "rest 4/win, 1 refused (Position/searchOpen 3 ×1, Order/searchOpen 1)",
    );
  });

  it("counts only 429 as refused", () => {
    noteTopstepRequest("/api/Order/place");
    noteTopstepResponse("/api/Order/place", 500);
    expect(takeTopstepRequestWindow()).toBe("rest 1/win, 0 refused (Order/place 1)");
  });

  it("starts the next window from zero", () => {
    noteTopstepRequest("/api/Trade/search");
    takeTopstepRequestWindow();
    expect(takeTopstepRequestWindow()).toBe("rest 0/win");
  });
});

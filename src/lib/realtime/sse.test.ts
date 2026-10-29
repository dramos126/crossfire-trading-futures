/**
 * The SSE wire's reader against its writer: what the remote engine handle
 * makes of the bytes the engine process's events stream sends, however the
 * reads split them.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/connection", () => ({ registerAfterCloseHook: vi.fn() }));

import type { BroadcastEvent } from "./event-broadcaster";
import { formatSseEvent, parseSseEvents } from "./sse";

const EVENTS: BroadcastEvent[] = [
  { kind: "status", connected: true },
  { kind: "deploymentsChanged" },
  { kind: "marketTrade", contractId: "CON.F.US.MNQ.Z26", lastPrice: 21000.25, timestamp: "2026-10-27T14:30:00Z" },
];

describe("parseSseEvents", () => {
  it("reads back every event the writer framed, dropping comments", () => {
    const wire = ": padding\n\n" + EVENTS.map(formatSseEvent).join(": heartbeat 1\n\n");
    expect(parseSseEvents(wire)).toEqual({ events: EVENTS, rest: "" });
  });

  it("carries an incomplete frame into the next read, at any split point", () => {
    const wire = EVENTS.map(formatSseEvent).join("");
    for (let cut = 0; cut <= wire.length; cut++) {
      const first = parseSseEvents(wire.slice(0, cut));
      const second = parseSseEvents(first.rest + wire.slice(cut));
      expect([...first.events, ...second.events]).toEqual(EVENTS);
      expect(second.rest).toBe("");
    }
  });

  it("drops a frame whose data is not an event, and keeps the rest", () => {
    const wire = "data: not json\n\n" + 'data: {"no":"kind"}\n\n' + formatSseEvent(EVENTS[1]);
    expect(parseSseEvents(wire).events).toEqual([EVENTS[1]]);
  });

  it("reads CRLF line ends", () => {
    expect(parseSseEvents(formatSseEvent(EVENTS[1]).replace(/\n/g, "\r\n")).events).toEqual([EVENTS[1]]);
  });
});

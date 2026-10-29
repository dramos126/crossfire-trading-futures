/**
 * What `sendDiscordAlert` reports back. A caller that throttles a page on
 * "already announced" needs to tell an alert the operator chose not to receive
 * from one that should have arrived and did not — the second must be retried,
 * the first must not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getNotificationsEnabled, resolveTopstepWebhookUrl } = vi.hoisted(() => ({
  getNotificationsEnabled: vi.fn((): boolean => true),
  resolveTopstepWebhookUrl: vi.fn((): string | null => "https://discord.test/webhook"),
}));
vi.mock("@/lib/db/settings", () => ({ getNotificationsEnabled }));
vi.mock("@/lib/db/settings-cache", () => ({ resolveTopstepWebhookUrl }));

import { sendDiscordAlert } from "./discord";
import { log } from "@/lib/logger";

const EMBED = { title: "Tradovate broker unavailable" };

function stubFetch(impl: () => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  getNotificationsEnabled.mockReturnValue(true);
  resolveTopstepWebhookUrl.mockReturnValue("https://discord.test/webhook");
  vi.spyOn(log, "event").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendDiscordAlert", () => {
  it("answers sent when the webhook accepted it", async () => {
    stubFetch(async () => ({ ok: true, status: 204, text: async () => "" }));
    await expect(sendDiscordAlert(EMBED)).resolves.toBe("sent");
  });

  it("answers silenced, and posts nothing, when notifications are off", async () => {
    getNotificationsEnabled.mockReturnValue(false);
    const fetchMock = stubFetch(async () => ({ ok: true, status: 204, text: async () => "" }));
    await expect(sendDiscordAlert(EMBED)).resolves.toBe("silenced");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers silenced when no webhook is configured", async () => {
    resolveTopstepWebhookUrl.mockReturnValue(null);
    const fetchMock = stubFetch(async () => ({ ok: true, status: 204, text: async () => "" }));
    await expect(sendDiscordAlert(EMBED)).resolves.toBe("silenced");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Fails closed — nothing is posted — but nobody chose that, so it is not
  // the switch's answer.
  it("answers failed when the notifications setting cannot be read", async () => {
    getNotificationsEnabled.mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    const fetchMock = stubFetch(async () => ({ ok: true, status: 204, text: async () => "" }));
    await expect(sendDiscordAlert(EMBED)).resolves.toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers failed when the webhook refuses it", async () => {
    stubFetch(async () => ({ ok: false, status: 429, text: async () => "rate limited" }));
    await expect(sendDiscordAlert(EMBED)).resolves.toBe("failed");
  });

  it("answers failed when the request throws", async () => {
    stubFetch(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(sendDiscordAlert(EMBED)).resolves.toBe("failed");
  });
});

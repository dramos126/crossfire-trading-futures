import { describe, it, expect, vi, beforeEach } from "vitest";

const validateSession = vi.hoisted(() => vi.fn<(token: string) => boolean>());
const warn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/auth", () => ({ validateSession, APP_SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000 }));
vi.mock("@/lib/logger", () => ({ log: { warn } }));

import { NextRequest, NextResponse } from "next/server";
import {
  clearSessionCookie,
  hasSession,
  LEGACY_SESSION_HEADER,
  requestIsHttps,
  requireSession,
  resetLegacyHeaderLogForTests,
  SESSION_COOKIE,
  setSessionCookie,
} from "./session";

function makeRequest({
  cookie,
  header,
  url = "http://localhost/api/anything",
  forwardedProto,
}: {
  cookie?: string;
  header?: string;
  url?: string;
  forwardedProto?: string;
} = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = `other=1; ${SESSION_COOKIE}=${cookie}`;
  if (header !== undefined) headers[LEGACY_SESSION_HEADER] = header;
  if (forwardedProto !== undefined) headers["x-forwarded-proto"] = forwardedProto;
  return new NextRequest(url, { headers });
}

beforeEach(() => {
  validateSession.mockReset();
  validateSession.mockReturnValue(true);
  warn.mockReset();
  resetLegacyHeaderLogForTests();
});

describe("requireSession — the cookie", () => {
  it("passes a request carrying a valid session cookie", () => {
    expect(requireSession(makeRequest({ cookie: "good" }))).toBeNull();
    expect(validateSession).toHaveBeenCalledWith("good");
  });

  it("401s when no session is presented, without consulting the store", () => {
    const denied = requireSession(makeRequest());
    expect(denied?.status).toBe(401);
    expect(validateSession).not.toHaveBeenCalled();
  });

  it("401s a present-but-unrecognised cookie — presence alone is not proof", () => {
    validateSession.mockReturnValue(false);
    expect(requireSession(makeRequest({ cookie: "x" }))?.status).toBe(401);
  });

  it("judges a request on its cookie when it sends both — a valid header does not rescue a dead cookie", () => {
    validateSession.mockImplementation((t) => t === "live-header");
    expect(requireSession(makeRequest({ cookie: "dead", header: "live-header" }))?.status).toBe(401);
  });

  it("reads only the session cookie and header — a token anywhere else is not a session", () => {
    const req = new NextRequest("http://localhost/api/anything", {
      headers: { "x-broker-token": "a-broker-jwt", cookie: "something_else=abc" },
    });
    expect(requireSession(req)?.status).toBe(401);
  });

  it("returns a JSON body with an error field", async () => {
    const denied = requireSession(makeRequest());
    expect(await denied!.json()).toHaveProperty("error");
  });
});

describe("requireSession — the deprecated header", () => {
  it("still accepts a valid header with no cookie, so a tab open across the deploy keeps working", () => {
    expect(requireSession(makeRequest({ header: "old-tab" }))).toBeNull();
    expect(validateSession).toHaveBeenCalledWith("old-tab");
  });

  it("logs the header as deprecated once per process, not per request", () => {
    requireSession(makeRequest({ header: "old-tab" }));
    hasSession(makeRequest({ header: "old-tab" }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatch(/deprecated/);
  });

  it("does not log a header that failed to validate, nor a cookie", () => {
    validateSession.mockImplementation((t) => t === "cookie");
    requireSession(makeRequest({ header: "garbage" }));
    requireSession(makeRequest({ cookie: "cookie" }));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the session cookie's flags", () => {
  function setCookieOf(response: NextResponse): string {
    return response.headers.get("set-cookie") ?? "";
  }

  it("is HttpOnly, SameSite=Strict, Path=/ and lives as long as the session", () => {
    const res = NextResponse.json({});
    setSessionCookie(res, "tok", false);
    const cookie = setCookieOf(res);
    expect(cookie.startsWith(`${SESSION_COOKIE}=tok;`)).toBe(true);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Strict/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);
  });

  it("carries Secure only when the request came over https", () => {
    const plain = NextResponse.json({});
    setSessionCookie(plain, "tok", requestIsHttps(makeRequest()));
    expect(setCookieOf(plain)).not.toMatch(/Secure/);

    const viaProxy = NextResponse.json({});
    setSessionCookie(viaProxy, "tok", requestIsHttps(makeRequest({ forwardedProto: "https" })));
    expect(setCookieOf(viaProxy)).toMatch(/; Secure/);

    const direct = NextResponse.json({});
    setSessionCookie(direct, "tok", requestIsHttps(makeRequest({ url: "https://box/api/auth" })));
    expect(setCookieOf(direct)).toMatch(/; Secure/);
  });

  it("believes the forwarded protocol over the URL — Next fills it from the socket", () => {
    expect(requestIsHttps(makeRequest({ url: "https://box/api/auth", forwardedProto: "http" }))).toBe(
      false,
    );
  });

  it("clearing expires it with the same attributes", () => {
    const res = NextResponse.json({});
    clearSessionCookie(res, false);
    const cookie = setCookieOf(res);
    expect(cookie.startsWith(`${SESSION_COOKIE}=;`)).toBe(true);
    expect(cookie).toMatch(/Max-Age=0/);
    expect(cookie).toMatch(/; HttpOnly/);
  });
});

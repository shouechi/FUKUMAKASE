import { describe, expect, test, vi } from "vitest";
import { proxyApiRequest } from "../apps/web/server/api-proxy";

describe("production API forwarding", () => {
  test.each([
    "/api",
    "/api/outfits/today",
    "/api/clothes/id/image",
    "/api/plans/weekly?week=2026-10-12",
  ])("%s belongs to API rather than page fallback", async (path) => {
    const request = new Request(`https://app.example.test${path}`, {
      headers: { Authorization: "Bearer fixture-token" },
    });
    const response = Response.json(
      {
        error: {
          code: "UNAUTHENTICATED",
          message: "ログインしてください",
          request_id: "fixture",
        },
      },
      { status: 401 },
    );
    const fetch = vi.fn(async () => response);
    expect(await proxyApiRequest(request, { API: { fetch } })).toBe(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
  });

  test("forwarding preserves mutation body, idempotency, and query", async () => {
    const request = new Request(
      "https://app.example.test/api/plans/weekly/regenerate?source=ui",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer fixture-token",
          Origin: "https://app.example.test",
          "Content-Type": "application/json",
          "Idempotency-Key": "fixture-operation",
        },
        body: JSON.stringify({ week: "2026-10-12" }),
      },
    );
    const fetch = vi.fn(async (forwarded: Request) => {
      expect(forwarded.url).toBe(request.url);
      expect(forwarded.method).toBe("POST");
      expect(forwarded.headers.get("Authorization")).toBe(
        "Bearer fixture-token",
      );
      expect(forwarded.headers.get("Origin")).toBe("https://app.example.test");
      expect(forwarded.headers.get("Idempotency-Key")).toBe(
        "fixture-operation",
      );
      expect(await forwarded.json()).toEqual({ week: "2026-10-12" });
      return Response.json({ ok: true });
    });
    expect((await proxyApiRequest(request, { API: { fetch } }))?.status).toBe(
      200,
    );
  });

  test.each(["/", "/today", "/apiary", "/api-preview/today", "/assets/app.js"])(
    "%s remains a web request",
    async (path) => {
      const fetch = vi.fn();
      expect(
        await proxyApiRequest(new Request(`https://app.example.test${path}`), {
          API: { fetch },
        }),
      ).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test.each(["missing binding", "binding unavailable"])(
    "%s returns safe JSON 503 rather than HTML",
    async (scenario) => {
      const env =
        scenario === "missing binding"
          ? {}
          : {
              API: {
                fetch: vi
                  .fn()
                  .mockRejectedValue(new Error("private-service-marker")),
              },
            };
      const response = await proxyApiRequest(
        new Request("https://app.example.test/api/outfits/today"),
        env,
      );
      expect(response?.status).toBe(503);
      expect(response?.headers.get("Content-Type")).toContain(
        "application/json",
      );
      expect(response?.headers.get("Cache-Control")).toContain("no-store");
      const body = await response!.json();
      expect(body.error.code).toBe("API_UNAVAILABLE");
      expect(body.error.request_id).toEqual(expect.any(String));
      expect(body.error.message).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(JSON.stringify(body)).not.toContain("private-service-marker");
    },
  );

  test("image response and cache headers remain untouched", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "private, no-store",
      },
    });
    const result = await proxyApiRequest(
      new Request("https://app.example.test/api/clothes/id/image"),
      { API: { fetch: async () => response } },
    );
    expect(result).toBe(response);
    expect(result?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await result?.arrayBuffer()).toEqual(
      new Uint8Array([1, 2, 3]).buffer,
    );
  });
});

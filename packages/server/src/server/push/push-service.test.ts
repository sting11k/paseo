import type pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PushService } from "./push-service.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

function respond(tickets: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: tickets }), { status: 200 })),
  );
}

describe("push service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const payload = { title: "1 việc cần bạn", body: "" };

  test("resolves once Expo accepted the push for a device", async () => {
    respond([{ status: "error", details: { error: "DeviceNotRegistered" } }, { status: "ok" }]);
    const revoked: string[] = [];
    const service = new PushService(createLogger(), (token) => revoked.push(token));

    await service.sendPush(["gone", "live"], payload);

    expect(revoked).toEqual(["gone"]);
  });

  test("rejects with why when the push reached no device", async () => {
    const service = new PushService(createLogger(), () => undefined);
    await expect(service.sendPush([], payload)).rejects.toThrow("No registered push device");

    respond([{ status: "error", details: { error: "DeviceNotRegistered" } }]);
    await expect(service.sendPush(["gone"], payload)).rejects.toThrow("DeviceNotRegistered");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    await expect(service.sendPush(["live"], payload)).rejects.toThrow("Expo push API error 503");
  });
});

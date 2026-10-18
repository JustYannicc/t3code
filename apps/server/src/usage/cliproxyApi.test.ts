import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import { makeCliproxyApi } from "./cliproxyApi.ts";

const config = {
  kind: "cliproxy",
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
} as const;
const accounts = [
  {
    id: "first.json",
    auth_index: "a",
    provider: "codex",
    email: "first@example.com",
    id_token: { chatgpt_account_id: "account-a" },
  },
  {
    id: "second.json",
    auth_index: "b",
    provider: "codex",
    email: "second@example.com",
    id_token: { chatgpt_account_id: "account-b" },
  },
];
const credit = (id: string, expires_at = "2099-01-01T00:00:00Z") => ({
  id,
  expires_at,
  status: "available",
  reset_type: "codex_rate_limits",
});
const RequestBody = Schema.Struct({
  auth_index: Schema.String,
  method: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  header: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  data: Schema.optional(Schema.String),
});
type RequestBody = typeof RequestBody.Type;
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture(
  options: {
    accounts?: Array<(typeof accounts)[number] & { disabled?: boolean }>;
    upstream?: (request: RequestBody) => { status: number; body: unknown };
    cooldownStatus?: number;
    /** Runs before the hub answers a cooldown reset, to hold a redeem mid-flight. */
    beforeCooldownReset?: Effect.Effect<void>;
  } = {},
) {
  const requests: Array<{ path: string; body?: RequestBody }> = [];
  const respond = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer management-secret");
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? decodeRequest(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ path, ...(body ? { body } : {}) });
      if (path.endsWith("/auth-files"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ files: options.accounts ?? accounts }),
        );
      if (path.endsWith("/reset-quota"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({}, { status: options.cooldownStatus ?? 200 }),
        );
      expect(path).toMatch(/\/v0\/management\/api-call$/);
      expect(body?.header?.Authorization).toBe("Bearer $TOKEN$");
      const upstream = options.upstream?.(body!) ?? {
        status: 200,
        body: body?.url?.endsWith("/consume")
          ? { code: "reset" }
          : body?.url?.endsWith("/rate-limit-reset-credits")
            ? {
                credits: [
                  credit("later", "2099-02-01T00:00:00Z"),
                  credit("first"),
                  credit("expired", "2000-01-01T00:00:00Z"),
                  { ...credit("used"), status: "redeemed" },
                ],
              }
            : {
                plan_type: "pro",
                rate_limit: {
                  secondary_window: {
                    used_percent: 78,
                    reset_at: 4070908800,
                    limit_window_seconds: 604800,
                  },
                },
              },
      };
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: upstream.status, body: encodeJson(upstream.body) }),
      );
    });
  const http = HttpClient.make((request) =>
    Effect.andThen(
      request.url.endsWith("/reset-quota")
        ? (options.beforeCooldownReset ?? Effect.void)
        : Effect.void,
      respond(request),
    ),
  );
  return {
    requests,
    api: makeCliproxyApi.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(NodeCrypto.layer),
    ),
  };
}

/** A hub API whose every request fails the way `fail` says. */
const unreachableHub = (
  fail: (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  ) => HttpClientError.HttpClientError,
) =>
  makeCliproxyApi.pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.fail(fail(request))),
    ),
    Effect.provide(NodeCrypto.layer),
  );

describe("CLIProxyAPI hub failures", () => {
  it.effect("names the TLS code when the hub's certificate is not trusted", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              // Node's fetch wraps the TLS error, which carries the code, in a generic TypeError.
              cause: new TypeError("fetch failed", {
                cause: Object.assign(new Error("unable to get local issuer certificate"), {
                  code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
                }),
              }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
      expect(error.detail).toContain("NODE_EXTRA_CA_CERTS");
    }),
  );

  it.effect("ignores a transport code that is not a short Node error code", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: Object.assign(new Error("odd"), { code: "X".repeat(200) }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toBe("The hub management request failed.");
    }),
  );

  it.effect("names the status, not the body, when the hub rejects the request", () =>
    Effect.gen(function* () {
      const test = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "management-secret is wrong" }, { status: 401 }),
          ),
        ),
      );
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(HttpClient.HttpClient, test),
        Effect.provide(NodeCrypto.layer),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toContain("401");
      expect(error.detail).not.toContain("management-secret");
    }),
  );

  it.effect("says when the hub does not answer in time", () =>
    Effect.gen(function* () {
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        ),
        Effect.provide(NodeCrypto.layer),
      );
      const pending = yield* Effect.flip(api.readAccounts(config)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("15 seconds");
      const error = yield* Fiber.join(pending);
      expect(error.detail).toContain("did not answer within 15 seconds");
    }),
  );

  it.effect("keeps a malformed account list generic", () =>
    Effect.gen(function* () {
      const test = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ nope: "hub-internal" })),
        ),
      );
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(HttpClient.HttpClient, test),
        Effect.provide(NodeCrypto.layer),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toBe("The hub could not list accounts.");
    }),
  );
});

describe("CLIProxyAPI built-in management API", () => {
  it.effect(
    "reads both accounts and their earliest unexpired credits without plugin endpoints",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1788710400000);
        const test = fixture();
        const api = yield* test.api;
        const result = yield* api.readAccounts(config);
        expect(result.map((account) => account.usageLimits.resetCredits)).toEqual([
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
        ]);
        expect(result[0]?.usageLimits.windows).toMatchObject([
          { id: "secondary", usedPercent: 78, kind: "weekly" },
        ]);
        const calls = test.requests.filter((request) => request.body?.url);
        expect(calls.map((request) => request.body?.auth_index).sort()).toEqual([
          "a",
          "a",
          "b",
          "b",
        ]);
        expect(
          calls.find((request) => request.body?.auth_index === "b")?.body?.header?.[
            "Chatgpt-Account-Id"
          ],
        ).toBe("account-b");
      }),
  );

  it.effect("keeps the path of a hub served under a prefix", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      yield* api.readAccounts({ ...config, url: "https://tools.test/cliproxy" });
      expect(test.requests.length).toBeGreaterThan(0);
      expect(
        test.requests.every((request) => request.path.startsWith("/cliproxy/v0/management/")),
      ).toBe(true);
    }),
  );

  it.effect("keeps usage when the credits endpoint fails", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.url?.endsWith("rate-limit-reset-credits")
            ? { status: 503, body: { token: "do-not-publish" } }
            : { status: 200, body: { rate_limit: { primary_window: { used_percent: 12 } } } },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(result[0]?.usageLimits.resetCredits).toBeUndefined();
    }),
  );

  it.effect("isolates a failed account and never publishes upstream error bodies", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.auth_index === "a"
            ? { status: 401, body: { token: "do-not-publish" } }
            : {
                status: 200,
                body: request.url?.endsWith("rate-limit-reset-credits")
                  ? { credits: [] }
                  : { rate_limit: { primary_window: { used_percent: 12 } } },
              },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(result[1]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(encodeJson(result)).not.toContain("do-not-publish");
    }),
  );

  it.effect("maps Claude scoped windows without a scheduler plugin", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        upstream: () => ({
          status: 200,
          body: {
            five_hour: { utilization: 10, resets_at: null },
            seven_day: { utilization: 50, resets_at: "2099-01-01T00:00:00Z" },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 80,
                resets_at: null,
                scope: { model: { display_name: "Fable" } },
              },
            ],
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(
        result[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([
        ["five_hour", 10],
        ["seven_day", 50],
        ["seven_day_fable", 80],
      ]);
    }),
  );

  it.effect("keeps Claude accounts' last read when the provider answers 429", () =>
    Effect.gen(function* () {
      const answered = new Set<string>();
      const test = fixture({
        accounts: [
          { ...accounts[0]!, provider: "claude" },
          { ...accounts[1]!, provider: "claude" },
        ],
        upstream: (request) => {
          if (answered.has(request.auth_index)) return { status: 429, body: {} };
          answered.add(request.auth_index);
          return { status: 200, body: { five_hour: { utilization: 10, resets_at: null } } };
        },
      });
      const api = yield* test.api;
      const usageProbes = () => test.requests.filter((request) => request.body?.url).length;
      yield* api.readAccounts(config);
      // A refresh straight after does not reach the provider.
      yield* api.readAccounts(config);
      expect(usageProbes()).toBe(2);
      yield* TestClock.adjust("1 minute");
      const result = yield* api.readAccounts(config);
      expect(usageProbes()).toBe(4);
      expect(result.map((account) => account.usageLimits.windows[0]?.usedPercent)).toEqual([
        10, 10,
      ]);
      // Backing off for two minutes after the 429s.
      yield* TestClock.adjust(2 * 60_000 - 1);
      yield* api.readAccounts(config);
      expect(usageProbes()).toBe(4);
      yield* TestClock.adjust(1);
      yield* api.readAccounts(config);
      expect(usageProbes()).toBe(6);
    }),
  );

  it.effect("says the provider is rate limiting when a 429 leaves nothing to show", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        upstream: () => ({ status: 429, body: {} }),
      });
      const api = yield* test.api;
      const [account] = yield* api.readAccounts(config);
      expect(account?.usageLimits.unavailable?.message).toContain("rate limiting");
    }),
  );

  it.effect("reads an account fresh after redeeming its reset", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      const usageProbes = () =>
        test.requests.filter((request) => request.body?.url?.endsWith("/wham/usage")).length;
      yield* api.readAccounts(config);
      yield* api.consume(config, "second.json", "credit-b");
      yield* api.readAccounts(config);
      // Only the redeemed account is read again inside the minute.
      expect(usageProbes()).toBe(3);
    }),
  );

  it.effect("reads an account fresh after a redeem interrupted once the credit is spent", () =>
    Effect.gen(function* () {
      const spent = yield* Deferred.make<void>();
      const test = fixture({
        beforeCooldownReset: Deferred.succeed(spent, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const api = yield* test.api;
      const usageProbes = () =>
        test.requests.filter((request) => request.body?.url?.endsWith("/wham/usage")).length;
      yield* api.readAccounts(config);
      const redeem = yield* Effect.forkChild(api.consume(config, "second.json", "credit-b"));
      yield* Deferred.await(spent);
      yield* Fiber.interrupt(redeem);
      yield* api.readAccounts(config);
      expect(usageProbes()).toBe(3);
    }),
  );

  it.effect("reads a credential replaced under the same file id as a new account", () =>
    Effect.gen(function* () {
      const listed = [{ ...accounts[0]!, provider: "claude" }];
      const test = fixture({
        accounts: listed,
        upstream: () => ({
          status: 200,
          body: {
            five_hour: {
              utilization: listed[0]!.email === "new@example.com" ? 70 : 10,
              resets_at: null,
            },
          },
        }),
      });
      const api = yield* test.api;
      yield* api.readAccounts(config);
      listed[0] = { ...listed[0]!, email: "new@example.com" };
      const [account] = yield* api.readAccounts(config);
      expect(account?.email).toBe("new@example.com");
      expect(account?.usageLimits.windows[0]?.usedPercent).toBe(70);
      // A Claude login replaced by Codex under the same file id and email.
      listed[0] = { ...listed[0]!, provider: "codex" };
      const [codex] = yield* api.readAccounts(config);
      expect(codex?.driver).toBe("codex");
    }),
  );

  it.effect("keeps an account's last read when the provider refuses a redeem with 429", () =>
    Effect.gen(function* () {
      let refuse = false;
      const test = fixture({
        upstream: (request) =>
          refuse
            ? { status: 429, body: {} }
            : {
                status: 200,
                body: request.url?.endsWith("rate-limit-reset-credits")
                  ? { credits: [] }
                  : { rate_limit: { primary_window: { used_percent: 12 } } },
              },
      });
      const api = yield* test.api;
      yield* api.readAccounts(config);
      refuse = true;
      const redeem = yield* api.consume(config, "first.json", "credit").pipe(Effect.flip);
      expect(redeem.detail).toContain("rate limiting");
      const [first] = yield* api.readAccounts(config);
      expect(first?.usageLimits.windows[0]?.usedPercent).toBe(12);
    }),
  );

  it.effect("pins redemption to the displayed credit and clears only that account's cooldown", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      const redemptions = test.requests.filter((request) =>
        request.body?.url?.endsWith("/consume"),
      );
      expect(redemptions).toHaveLength(2);
      expect(redemptions[0]?.body?.data).toBe(redemptions[1]?.body?.data);
      expect(redemptions[0]?.body?.data).toBe(
        encodeJson({
          redeem_request_id: "519d5243-011a-5b7b-91f3-44d85f095705",
          credit_id: "credit-b",
        }),
      );
      expect(
        test.requests
          .filter((request) => request.path.endsWith("/reset-quota"))
          .map((request) => request.body?.auth_index),
      ).toEqual(["b", "b"]);
    }),
  );

  it.effect.each([
    ["nothing_to_reset", "nothingToReset"],
    ["no_credit", "noCredit"],
    ["already_redeemed", "alreadyRedeemed"],
  ] as const)("reports %s accurately", ([code, outcome]) =>
    Effect.gen(function* () {
      const test = fixture({ upstream: () => ({ status: 200, body: { code } }) });
      const api = yield* test.api;
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({ outcome });
      expect(test.requests.some((request) => request.path.endsWith("/reset-quota"))).toBe(
        code === "already_redeemed",
      );
    }),
  );

  it.effect("reports redemption success even if cooldown clearing fails", () =>
    Effect.gen(function* () {
      const api = yield* fixture({ cooldownStatus: 404 }).api;
      const result = yield* api.consume(config, "first.json", "credit");
      expect(result.outcome).toBe("reset");
      expect(result.warning).toContain("cooldown");
    }),
  );

  it.effect("skips disabled accounts and rejects redemption on them", () =>
    Effect.gen(function* () {
      const test = fixture({ accounts: [{ ...accounts[0]!, disabled: true }] });
      const api = yield* test.api;
      expect(yield* api.readAccounts(config)).toEqual([]);
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(test.requests.every((request) => request.path.endsWith("/auth-files"))).toBe(true);
    }),
  );

  it.effect("keeps the same redemption id after an uncertain upstream failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const test = fixture({
        upstream: () =>
          ++attempts === 1
            ? { status: 503, body: {} }
            : { status: 200, body: { code: "already_redeemed" } },
      });
      const api = yield* test.api;
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({
        outcome: "alreadyRedeemed",
      });
      const data = test.requests
        .filter((request) => request.body?.url?.endsWith("/consume"))
        .map((request) => request.body?.data);
      expect(data[0]).toBe(data[1]);
      expect(test.requests.filter((request) => request.path.endsWith("/reset-quota"))).toHaveLength(
        1,
      );
    }),
  );

  it.effect("rejects unknown accounts without forwarding a redemption", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      const result = yield* api.consume(config, "missing.json", "credit").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.requests).toHaveLength(1);
    }),
  );
});

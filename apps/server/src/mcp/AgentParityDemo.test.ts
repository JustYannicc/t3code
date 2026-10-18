import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcSchema from "effect/rpc/RpcSchema";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { callWsRpc, RPC_REACH_DECISIONS, searchWsRpcReach } from "./AgentParityDemo.ts";

const testedMethods = [
  WS_METHODS.serverProbe,
  WS_METHODS.serverRetryResourceTelemetry,
] as const;
const rpcTestGroup = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      method,
    ): method is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof testedMethods)[number]> =>
      !(testedMethods as ReadonlyArray<string>).includes(method),
  ),
);

describe("agent parity RPC reach demo", () => {
  it("decides every real RPC from its schema and leaves streams as explicit gaps", () => {
    const requestMethods = new Set(WsRpcGroup.requests.keys());
    const decisions = Object.values(RPC_REACH_DECISIONS);
    const decisionMethods = new Set(decisions.map(({ method }) => method));
    const streamMethods = [...WsRpcGroup.requests]
      .filter(([, rpc]) => RpcSchema.isStreamSchema(rpc.successSchema))
      .map(([method]) => method)
      .sort();
    const gapMethods = decisions
      .filter((decision) => decision.kind === "gap")
      .map(({ method }) => method)
      .sort();

    expect(decisionMethods).toEqual(requestMethods);
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(requestMethods);
    expect(gapMethods).toEqual(streamMethods);
    expect(
      decisions.filter((decision) => decision.kind === "call").length + gapMethods.length,
    ).toBe(requestMethods.size);
  });

  it("searches the generated reach map", () => {
    expect(searchWsRpcReach("server.probe")).toMatchObject([
      {
        method: WS_METHODS.serverProbe,
        kind: "call",
        requiredScope: AuthOrchestrationReadScope,
        payloadSchema: { schema: { type: "object" } },
      },
    ]);
    expect(searchWsRpcReach("streaming").every((decision) => decision.kind === "gap")).toBe(
      true,
    );
    expect(searchWsRpcReach(" ")).toEqual([]);
    expect(searchWsRpcReach("server", 1)).toHaveLength(1);
  });

  it.effect(
    "calls a unary method through the generated client and existing RPC server middleware",
    () =>
      Effect.gen(function* () {
        let handled = 0;
        const grants = [AuthOrchestrationReadScope];
        const client = yield* RpcTest.makeClient(rpcTestGroup).pipe(
          Effect.provide(
            Layer.mergeAll(
              rpcTestGroup.toLayerHandler(WS_METHODS.serverProbe, () =>
                Effect.sync(() => {
                  handled += 1;
                  return {};
                }),
              ),
              RpcAuthorization.layer(grants),
            ),
          ),
        );

        const invalidPayload = yield* callWsRpc(client, {
          method: WS_METHODS.serverProbe,
          payload: null,
          grantedScopes: grants,
        }).pipe(Effect.flip);
        expect(invalidPayload).toMatchObject({ code: "rpc_payload_invalid" });
        expect(handled).toBe(0);

        const result = yield* callWsRpc(client, {
          method: WS_METHODS.serverProbe,
          payload: {},
          grantedScopes: grants,
        });

        expect(result).toEqual({});
        expect(handled).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "checks input-dependent permissions before dispatch and keeps server authorization",
    () =>
      Effect.gen(function* () {
        let handled = 0;
        const grants = [AuthOrchestrationReadScope];
        const client = yield* RpcTest.makeClient(rpcTestGroup).pipe(
          Effect.provide(
            Layer.mergeAll(
              rpcTestGroup.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
                Effect.sync(() => {
                  handled += 1;
                  return {};
                }),
              ),
              RpcAuthorization.layer(grants),
            ),
          ),
        );

        const guarded = yield* callWsRpc(client, {
          method: WS_METHODS.serverRetryResourceTelemetry,
          payload: {},
          grantedScopes: grants,
        }).pipe(Effect.flip);
        expect(guarded).toMatchObject({
          requiredPermission: AuthEnvironmentMaintainScope,
        });
        expect(handled).toBe(0);

        const serverDenied = yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(
          Effect.flip,
        );
        expect(serverDenied).toMatchObject({
          requiredPermission: AuthEnvironmentMaintainScope,
        });
        expect(handled).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect("returns a named gap for stream RPCs before dispatch", () =>
    Effect.gen(function* () {
      const streamGap = Object.values(RPC_REACH_DECISIONS).find(
        (decision) => decision.kind === "gap" && decision.reason === "streaming",
      );
      if (streamGap === undefined) throw new Error("WsRpcGroup has no streaming RPC to classify");

      const error = yield* callWsRpc({}, {
        method: streamGap.method,
        payload: {},
        grantedScopes: [],
      }).pipe(Effect.flip);

      expect(error).toMatchObject({ code: "rpc_reach_gap" });
      expect(error.message).toContain("subscription-shaped interface");
    }),
  );
});

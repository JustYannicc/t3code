import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  OrchestrationV2Command,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { callWsRpc, RPC_REACH_DECISIONS, searchWsRpcReach } from "./AgentParityDemo.ts";
import { AgentParityToolkit, agentParityHandlers } from "./AgentParityTools.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { COMMAND_AGENT_REACH, RPC_AGENT_REACH } from "./AgentRpcReach.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread:parity-demo");
const callerScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:parity-demo"),
  thread: { threadId, providerSessionId: "demo-session", providerInstanceId: ProviderInstanceId.make("codex") },
  client: undefined,
  requestNamespace: "parity-demo",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const caller = (active = true) => Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: () => Effect.succeed(liveThreadShell(threadId, active ? {} : { activeRunId: null })),
});
const withCaller = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.provideService(McpInvocationContext.McpInvocationContext, callerScope),
  Effect.provide(caller()),
);
const testedMethods = [WS_METHODS.serverProbe, WS_METHODS.assetsCreateUrl] as const;
const rpcTestGroup = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (method): method is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof testedMethods)[number]> =>
      !(testedMethods as ReadonlyArray<string>).includes(method),
  ),
);

describe("agent parity RPC reach demo", () => {
  it("requires an explicit decision for every RPC and client command", () => {
    const methods = new Set(WsRpcGroup.requests.keys());
    expect(new Set(Object.keys(RPC_AGENT_REACH))).toEqual(methods);
    expect(new Set(Object.keys(RPC_REACH_DECISIONS))).toEqual(methods);
    expect(new Set(Object.keys(COMMAND_AGENT_REACH))).toEqual(
      new Set(OrchestrationV2Command.members.map((command) => command.fields.type.literal)),
    );
    for (const decision of Object.values(RPC_REACH_DECISIONS)) {
      if (decision.kind !== "call") expect(decision.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("can express every callable RPC payload as tool input", () => {
    for (const decision of Object.values(RPC_REACH_DECISIONS)) {
      if (decision.kind !== "call") continue;
      const rpc = WsRpcGroup.requests.get(decision.method)!;
      expect(() => Schema.toJsonSchemaDocument(rpc.payloadSchema)).not.toThrow();
      expect(RPC_AGENT_REACH[decision.method]).toMatchObject({ kind: "derived", access: "read" });
    }
  });

  it("searches the generated catalog without adding one tool per RPC", () => {
    expect(searchWsRpcReach("server.probe")).toMatchObject([
      { method: WS_METHODS.serverProbe, kind: "call", requiredScope: AuthOrchestrationReadScope,
        payloadSchema: { schema: { type: "object" } } },
    ]);
    expect(searchWsRpcReach(" ")).toEqual([]);
    expect(searchWsRpcReach("server", 1)).toHaveLength(1);
  });

  it.effect("dispatches a validated read through the generated RPC client and authorization layer", () =>
    Effect.gen(function* () {
      let handled = 0;
      const grants = [AuthOrchestrationReadScope];
      const client = yield* RpcTest.makeClient(rpcTestGroup).pipe(Effect.provide(Layer.mergeAll(
        rpcTestGroup.toLayerHandler(WS_METHODS.assetsCreateUrl, () => Effect.die("unexpected asset call")),
        rpcTestGroup.toLayerHandler(WS_METHODS.serverProbe, () => Effect.sync(() => {
          handled += 1;
          return {};
        })),
        RpcAuthorization.layer(grants),
      )));
      const invalid = yield* callWsRpc(client, { method: WS_METHODS.serverProbe, payload: null, grantedScopes: grants }).pipe(Effect.flip);
      expect(invalid).toMatchObject({ code: "rpc_payload_invalid" });
      expect(handled).toBe(0);
      expect(yield* callWsRpc(client, { method: WS_METHODS.serverProbe, payload: {}, grantedScopes: grants })).toEqual({});
      expect(handled).toBe(1);
    }).pipe(withCaller, Effect.scoped),
  );

  it.effect("checks payload-dependent scopes before dispatch and keeps server enforcement", () =>
    Effect.gen(function* () {
      let handled = 0;
      const grants = [AuthOrchestrationReadScope];
      const client = yield* RpcTest.makeClient(rpcTestGroup).pipe(Effect.provide(Layer.mergeAll(
        rpcTestGroup.toLayerHandler(WS_METHODS.serverProbe, () => Effect.die("unexpected probe")),
        rpcTestGroup.toLayerHandler(WS_METHODS.assetsCreateUrl, () => Effect.sync(() => {
          handled += 1;
          return { relativeUrl: "/demo-file", expiresAt: 1 };
        })),
        RpcAuthorization.layer(grants),
      )));
      const payload = { resource: { _tag: "workspace-file", threadId, path: "README.md" } } as const;
      const denied = yield* callWsRpc(client, { method: WS_METHODS.assetsCreateUrl, payload, grantedScopes: grants }).pipe(Effect.flip);
      expect(denied).toMatchObject({ requiredPermission: AuthFilesystemReadScope });
      const serverDenied = yield* client[WS_METHODS.assetsCreateUrl](payload).pipe(Effect.flip);
      expect(serverDenied).toMatchObject({ requiredPermission: AuthFilesystemReadScope });
      expect(handled).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect.each([WS_METHODS.secretsAnswerRequest, WS_METHODS.providerAuthComplete,
    WS_METHODS.scheduledTasksDelete, WS_METHODS.serverRetryResourceTelemetry])(
    "refuses non-derived method %s before invoking the client", (method) =>
      Effect.gen(function* () {
        const error = yield* callWsRpc({}, { method, payload: {}, grantedScopes: [] }).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "rpc_reach_gap" });
      }),
  );

  it.effect("refuses an expired caller before dispatch", () => Effect.gen(function* () {
    let handled = false;
    const error = yield* callWsRpc({ [WS_METHODS.serverProbe]: () => Effect.sync(() => { handled = true; }) },
      { method: WS_METHODS.serverProbe, payload: {}, grantedScopes: [AuthOrchestrationReadScope] }).pipe(Effect.flip);
    expect(error).toMatchObject({ code: "parent_not_active" });
    expect(handled).toBe(false);
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, callerScope),
    Effect.provide(caller(false))),
  );
  it.effect("exposes search and call through the checked MCP handler layer", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(rpcTestGroup).pipe(Effect.provide(Layer.mergeAll(
        rpcTestGroup.toLayerHandler(WS_METHODS.assetsCreateUrl, () => Effect.die("unexpected asset call")),
        rpcTestGroup.toLayerHandler(WS_METHODS.serverProbe, () => Effect.sync(() => {
          handled += 1;
          return {};
        })),
        RpcAuthorization.layer([AuthOrchestrationReadScope]),
      )));
      const handlers = yield* AgentParityToolkit.pipe(Effect.provide(
        McpToolAccess.HandlersLayer.layer(agentParityHandlers(client, [AuthOrchestrationReadScope])),
      ));
      expect(Object.keys(handlers.tools)).toEqual(["app_search", "app_call"]);
      const search = yield* handlers.handle("app_search", { query: "server.probe" }).pipe(Effect.flatMap(Stream.runCollect));
      expect(search.at(-1)?.result).toMatchObject([{ method: WS_METHODS.serverProbe, kind: "call" }]);
      const call = yield* handlers.handle("app_call", { method: WS_METHODS.serverProbe, input: {} }).pipe(Effect.flatMap(Stream.runCollect));
      expect(call.at(-1)).toMatchObject({ isFailure: false, result: {} });
      expect(handled).toBe(1);
      const refused = yield* handlers.handle("app_call", { method: WS_METHODS.secretsAnswerRequest, input: {} }).pipe(Effect.flatMap(Stream.runCollect));
      expect(refused.at(-1)).toMatchObject({ isFailure: true, result: { code: "rpc_reach_gap" } });
      expect(handled).toBe(1);
    }).pipe(withCaller, Effect.scoped),
  );

});

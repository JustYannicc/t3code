import { OrchestratorMcpFailure, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { AgentRpcFailure, callWsRpc, searchWsRpcReach } from "./AgentParityDemo.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, AgentRpcFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};

const isCallFailure = Schema.is(Schema.Union([OrchestratorMcpFailure, AgentRpcFailure]));

/** Demo-only toolkit. Production registration is intentionally a later change. */
export const AgentParityToolkit = Toolkit.make(
  Tool.make("app_search", {
    ...shared,
    description:
      "Find an app RPC, its input schema, or the reason agent access remains unavailable.",
    parameters: Schema.Struct({ query: Schema.String, limit: Schema.optionalKey(Schema.Number) }),
    success: Schema.Array(Schema.Unknown),
  }).annotate(Tool.Readonly, true),
  Tool.make("app_call", {
    ...shared,
    description:
      "Call a discovered read RPC using this caller's authenticated connection and grant.",
    parameters: Schema.Struct({ method: Schema.String, input: Schema.Unknown }),
    success: Schema.Unknown,
  }).annotate(Tool.Readonly, true),
);

/** Bind the authenticated RPC client and grant here, never in the agent's tool arguments. */
export const agentParityHandlers = <Client extends object>(
  client: Client,
  grantedScopes: ReadonlyArray<AuthEnvironmentScope>,
) =>
  McpToolAccess.toLayer(AgentParityToolkit, {
    app_search: McpToolAccess.reads(({ query, limit }) =>
      Effect.try({
        try: () => searchWsRpcReach(query, limit),
        catch: () =>
          new AgentRpcFailure({
            code: "rpc_schema_unavailable",
            message: "One matching RPC schema cannot yet be represented as a tool input.",
          }),
      }),
    ),
    app_call: McpToolAccess.reads(({ method, input }) =>
      callWsRpc(client, { method, payload: input, grantedScopes }).pipe(
        Effect.mapError((error) =>
          isCallFailure(error)
            ? error
            : new AgentRpcFailure({
                code: "rpc_call_failed",
                message: "The RPC call failed or this connection lacks its required scope.",
              }),
        ),
      ),
    ),
  });

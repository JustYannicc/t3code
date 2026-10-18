import {
  OrchestratorMcpFailure,
  type AuthEnvironmentScope,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopesForRpcCall,
  rpcAuthorizationError,
} from "../auth/RpcAuthorization.ts";

import { RPC_AGENT_REACH, type AgentReach } from "./AgentRpcReach.ts";
import { assertLiveCaller, readCaller } from "./threadAccess.ts";

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

export type RpcReachDecision =
  | {
      readonly method: WsRpcMethod;
      readonly kind: "call";
      readonly requiredScope: AuthEnvironmentScope;
    }
  | {
      readonly method: WsRpcMethod;
      readonly kind: "gap" | "exempt";
      readonly reason: string;
      readonly requiredScope?: AuthEnvironmentScope;
    };

const buildReachDecisions = (): Readonly<Record<WsRpcMethod, RpcReachDecision>> => {
  const decisions = Object.fromEntries(
    [...WsRpcGroup.requests].map(([method, rpc]) => {
      const requiredScope = RPC_REQUIRED_SCOPES[method as WsRpcMethod];
      const reach: AgentReach = RPC_AGENT_REACH[method as WsRpcMethod];
      const decision: RpcReachDecision =
        reach.kind !== "derived"
          ? { method: method as WsRpcMethod, kind: reach.kind, reason: reach.reason, requiredScope }
          : requiredScope === undefined
          ? { method: method as WsRpcMethod, kind: "gap", reason: "authorization-scope-missing" }
          : RpcSchema.isStreamSchema(rpc.successSchema)
            ? { method: method as WsRpcMethod, kind: "gap", reason: "streaming", requiredScope }
            : { method: method as WsRpcMethod, kind: "call", requiredScope };
      return [method, Object.freeze(decision)];
    }),
  ) as Record<WsRpcMethod, RpcReachDecision>;

  return Object.freeze(decisions);
};

/**
 * Every entry comes from the real server RPC group. Unary calls use its
 * generated client and existing authorization middleware; stream RPCs need a
 * subscription-shaped tool and remain explicit gaps here.
 */
export const RPC_REACH_DECISIONS = buildReachDecisions();

export type RpcReachSearchResult = RpcReachDecision & {
  readonly payloadSchema?: ReturnType<typeof Schema.toJsonSchemaDocument>;
};

export const searchWsRpcReach = (
  query: string,
  limit = 20,
): ReadonlyArray<RpcReachSearchResult> => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 0), 50) : 20;
  return Object.values(RPC_REACH_DECISIONS)
    .filter((decision) => {
      if (decision.method.toLowerCase().includes(needle)) return true;
      if (decision.kind === "call") return decision.requiredScope.toLowerCase().includes(needle);
      return (
        decision.reason.toLowerCase().includes(needle) ||
        (decision.requiredScope?.toLowerCase().includes(needle) ?? false)
      );
    })
    .slice(0, boundedLimit)
    .map((decision) => {
      if (decision.kind !== "call") return decision;
      const rpc = WsRpcGroup.requests.get(decision.method);
      if (rpc === undefined) throw new Error(`RPC method ${decision.method} is not registered.`);
      return {
        ...decision,
        payloadSchema: Schema.toJsonSchemaDocument(rpc.payloadSchema),
      };
    });
};

const callFailure = (code: string, message: string) =>
  new OrchestratorMcpFailure({ code, message });

export interface WsRpcCallInput {
  readonly method: string;
  readonly payload: unknown;
  /** Scopes from the authenticated WebSocket session used by the RPC client. */
  readonly grantedScopes: ReadonlyArray<AuthEnvironmentScope>;
}

type UnaryRpcMethod = (
  payload: never,
) => Effect.Effect<unknown, unknown, Scope.Scope>;

/**
 * Validates and authorizes a discovered RPC before invoking the existing
 * generated WebSocket client. RpcAuthorization runs the same check again on
 * the server, so this preflight cannot grant access the connection lacks.
 */
export const callWsRpc = Effect.fn("agentParity.callWsRpc")(function* <Client extends object>(
  client: Client,
  input: WsRpcCallInput,
) {
    if (!Object.hasOwn(RPC_REACH_DECISIONS, input.method)) {
      return yield* Effect.fail(
        callFailure("rpc_method_unavailable", `RPC method ${input.method} is not registered.`),
      );
    }

    const decision = RPC_REACH_DECISIONS[input.method as WsRpcMethod];
    if (decision.kind !== "call") {
      const detail =
        decision.reason === "streaming"
          ? "streaming RPCs need a subscription-shaped interface"
          : decision.reason;
      return yield* Effect.fail(
        callFailure("rpc_reach_gap", `RPC method ${decision.method} is a gap: ${detail}.`),
      );
    }

    const rpc = WsRpcGroup.requests.get(decision.method);
    if (rpc === undefined) {
      return yield* Effect.fail(
        callFailure("rpc_method_unavailable", `RPC method ${decision.method} is not registered.`),
      );
    }

    const payload = yield* Schema.decodeUnknownEffect(rpc.payloadSchema)(input.payload).pipe(
      Effect.mapError(() =>
        callFailure("rpc_payload_invalid", `Payload does not match ${decision.method}.`),
      ),
    );
    const missingScope = requiredScopesForRpcCall(decision.method, payload).find(
      (scope) => !input.grantedScopes.includes(scope),
    );
    if (missingScope !== undefined) return yield* Effect.fail(rpcAuthorizationError(missingScope));

    yield* readCaller().pipe(Effect.tap(assertLiveCaller));
    const candidate = (client as Record<string, unknown>)[decision.method];
    if (typeof candidate !== "function") {
      return yield* Effect.fail(
        callFailure(
          "rpc_method_unavailable",
          `The connected RPC client does not expose ${decision.method}.`,
        ),
      );
    }
    const invoke = candidate as UnaryRpcMethod;
    return yield* invoke(payload as never);
});

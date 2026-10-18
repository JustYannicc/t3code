import { type AuthEnvironmentScope, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Rpc from "effect/rpc/Rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
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
      readonly description: string;
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
              : {
                  method: method as WsRpcMethod,
                  kind: "call",
                  requiredScope,
                  description: reach.description,
                };
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

const rpcCodecs = new Map(
  [...WsRpcGroup.requests].map(
    ([method, rpc]) =>
      [
        method,
        {
          decodePayload: Schema.decodeUnknownEffect(rpc.payloadSchema),
          encodeSuccess: Schema.encodeUnknownEffect(rpc.successSchema),
          encodeError: Schema.encodeUnknownEffect(rpc.errorSchema),
        },
      ] as const,
  ),
);

export type RpcReachSearchResult = RpcReachDecision & {
  readonly payloadSchema?: ReturnType<typeof Schema.toJsonSchemaDocument>;
  readonly successSchema?: ReturnType<typeof Schema.toJsonSchemaDocument>;
  readonly errorSchema?: ReturnType<typeof Schema.toJsonSchemaDocument>;
};

export const searchWsRpcReach = (
  query: string,
  limit = 20,
): ReadonlyArray<RpcReachSearchResult> => {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];

  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 0), 50) : 20;
  return Object.values(RPC_REACH_DECISIONS)
    .filter((decision) => {
      const text = [
        decision.method,
        decision.requiredScope,
        decision.kind === "call" ? decision.description : decision.reason,
      ]
        .join(" ")
        .toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .slice(0, boundedLimit)
    .map((decision) => {
      if (decision.kind !== "call") return decision;
      const rpc = WsRpcGroup.requests.get(decision.method);
      if (rpc === undefined) throw new Error(`RPC method ${decision.method} is not registered.`);
      return {
        ...decision,
        payloadSchema: Schema.toJsonSchemaDocument(rpc.payloadSchema),
        successSchema: Schema.toJsonSchemaDocument(rpc.successSchema),
        errorSchema: Schema.toJsonSchemaDocument(rpc.errorSchema),
      };
    });
};

export class AgentRpcFailure extends Schema.TaggedError<AgentRpcFailure>()("AgentRpcFailure", {
  code: Schema.String,
  message: Schema.String,
  detail: Schema.optionalKey(Schema.Unknown),
}) {}

const callFailure = (code: string, message: string) => new AgentRpcFailure({ code, message });

export interface WsRpcCallInput {
  readonly method: string;
  readonly payload: unknown;
  /** Scopes from the authenticated WebSocket session used by the RPC client. */
  readonly grantedScopes: ReadonlyArray<AuthEnvironmentScope>;
}

type UnaryRpcMethod = (
  payload: never,
) => Effect.Effect<unknown, Rpc.Error<RpcGroup.Rpcs<typeof WsRpcGroup>> | RpcClientError>;

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
    return yield* callFailure(
      "rpc_method_unavailable",
      `RPC method ${input.method} is not registered.`,
    );
  }

  const decision = RPC_REACH_DECISIONS[input.method as WsRpcMethod];
  if (decision.kind !== "call") {
    const detail =
      decision.reason === "streaming"
        ? "streaming RPCs need a subscription-shaped interface"
        : decision.reason;
    return yield* callFailure(
      "rpc_reach_gap",
      `RPC method ${decision.method} is a gap: ${detail}.`,
    );
  }

  const codecs = rpcCodecs.get(decision.method);
  if (codecs === undefined) {
    return yield* callFailure(
      "rpc_method_unavailable",
      `RPC method ${decision.method} is not registered.`,
    );
  }

  const payload = yield* codecs
    .decodePayload(input.payload)
    .pipe(
      Effect.mapError(() =>
        callFailure("rpc_payload_invalid", `Payload does not match ${decision.method}.`),
      ),
    );
  const missingScope = requiredScopesForRpcCall(decision.method, payload).find(
    (scope) => !input.grantedScopes.includes(scope),
  );
  if (missingScope !== undefined) return yield* rpcAuthorizationError(missingScope);

  yield* readCaller().pipe(Effect.tap(assertLiveCaller));
  const candidate = (client as Record<string, unknown>)[decision.method];
  if (typeof candidate !== "function") {
    return yield* callFailure(
      "rpc_method_unavailable",
      `The connected RPC client does not expose ${decision.method}.`,
    );
  }
  const invoke = candidate as UnaryRpcMethod;
  const result = yield* invoke(payload as never).pipe(
    Effect.catch((error) =>
      codecs.encodeError(error).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.fail(callFailure("rpc_call_failed", `RPC method ${decision.method} failed.`)),
          onSuccess: (detail) =>
            Effect.fail(
              new AgentRpcFailure({
                code: "rpc_call_failed",
                message: `RPC method ${decision.method} failed.`,
                detail,
              }),
            ),
        }),
      ),
    ),
  );
  return yield* codecs
    .encodeSuccess(result)
    .pipe(
      Effect.mapError(() =>
        callFailure("rpc_result_invalid", `Result does not match ${decision.method}.`),
      ),
    );
});

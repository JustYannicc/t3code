import type {
  OrchestrationV2ProviderTurnStatus,
  OrchestrationV2RunStatus,
  OrchestrationV2RuntimeRequestStatus,
} from "./orchestrationV2.ts";

type TransitionMap<Status extends string> = Readonly<Record<Status, ReadonlyArray<Status>>>;

export interface OrchestrationV2Lifecycle<
  Status extends string,
  Terminal extends ReadonlyArray<Status>,
> {
  readonly transitions: TransitionMap<Status>;
  readonly terminal: Terminal;
  canTransition(from: Status, to: Status): boolean;
  isTerminal(status: Status): status is Terminal[number];
}

function defineLifecycle<Status extends string>() {
  return <const Terminal extends ReadonlyArray<Status>>(input: {
    readonly transitions: TransitionMap<Status>;
    readonly terminal: Terminal;
  }): OrchestrationV2Lifecycle<Status, Terminal> => ({
    ...input,
    canTransition: (from, to) => input.transitions[from].includes(to),
    isTerminal: (status): status is Terminal[number] =>
      input.terminal.some((terminal) => terminal === status),
  });
}

const runTransitions = {
  preparing: ["queued", "starting", "failed", "cancelled"],
  queued: ["starting", "failed", "cancelled"],
  starting: ["running", "waiting", "completed", "interrupted", "failed", "cancelled"],
  running: ["waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back"],
  waiting: ["running", "completed", "interrupted", "failed", "cancelled", "rolled_back"],
  // A rollback may mark a run after its work has already ended.
  completed: ["rolled_back"],
  interrupted: [],
  failed: [],
  cancelled: [],
  rolled_back: [],
} as const satisfies TransitionMap<OrchestrationV2RunStatus>;

const providerTurnTransitions = {
  pending: ["running", "completed", "interrupted", "failed", "cancelled"],
  running: ["completed", "interrupted", "failed", "cancelled"],
  completed: [],
  interrupted: [],
  failed: [],
  cancelled: [],
} as const satisfies TransitionMap<OrchestrationV2ProviderTurnStatus>;

const runtimeRequestTransitions = {
  pending: ["resolved", "expired", "cancelled"],
  resolved: [],
  expired: [],
  cancelled: [],
} as const satisfies TransitionMap<OrchestrationV2RuntimeRequestStatus>;

// Transition edges are test oracles; command handlers remain authoritative.
export const OrchestrationV2RunLifecycle = defineLifecycle<OrchestrationV2RunStatus>()({
  transitions: runTransitions,
  terminal: ["completed", "interrupted", "failed", "cancelled", "rolled_back"],
});
export type OrchestrationV2RunTerminalStatus =
  (typeof OrchestrationV2RunLifecycle.terminal)[number];
export const isOrchestrationV2RunTerminalStatus = OrchestrationV2RunLifecycle.isTerminal;

export const OrchestrationV2ProviderTurnLifecycle =
  defineLifecycle<OrchestrationV2ProviderTurnStatus>()({
    transitions: providerTurnTransitions,
    terminal: ["completed", "interrupted", "failed", "cancelled"],
  });
export type OrchestrationV2ProviderTurnTerminalStatus =
  (typeof OrchestrationV2ProviderTurnLifecycle.terminal)[number];
export const isOrchestrationV2ProviderTurnTerminalStatus =
  OrchestrationV2ProviderTurnLifecycle.isTerminal;

export const OrchestrationV2RuntimeRequestLifecycle =
  defineLifecycle<OrchestrationV2RuntimeRequestStatus>()({
    transitions: runtimeRequestTransitions,
    terminal: ["resolved", "expired", "cancelled"],
  });
export type OrchestrationV2RuntimeRequestTerminalStatus =
  (typeof OrchestrationV2RuntimeRequestLifecycle.terminal)[number];
export const isOrchestrationV2RuntimeRequestTerminalStatus =
  OrchestrationV2RuntimeRequestLifecycle.isTerminal;

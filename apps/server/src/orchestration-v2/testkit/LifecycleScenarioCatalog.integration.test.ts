import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  isOrchestrationV2ProviderTurnTerminalStatus,
  isOrchestrationV2RunTerminalStatus,
  isOrchestrationV2RuntimeRequestTerminalStatus,
  OrchestrationV2ProviderTurnLifecycle,
  OrchestrationV2RunLifecycle,
  OrchestrationV2RuntimeRequestLifecycle,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { assertToolCallReadOnlyOnRequestOutput } from "./fixtures/tool_call_read_only_on_request/output.ts";
import { materializeFixtureInput } from "./fixtures/shared.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATION_LIFECYCLE_SCENARIO_CATALOG } from "./LifecycleScenarioCatalog.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";

function assertAllowedHistory<Status extends string>(
  name: string,
  history: ReadonlyArray<Status>,
  canTransition: (from: Status, to: Status) => boolean,
): ReadonlyArray<Status> {
  const transitions = history.filter(
    (status, index) => index === 0 || status !== history[index - 1],
  );
  assert.isAtLeast(transitions.length, 2, `${name} must record a state change`);
  for (const [index, status] of transitions.entries()) {
    if (index === 0) continue;
    const previous = transitions[index - 1];
    assert.isDefined(previous);
    assert.isTrue(
      canTransition(previous, status),
      `${name} cannot move from ${previous} to ${status}`,
    );
  }
  return transitions;
}

it.effect("replays a catalog scenario through the orchestrator event log", () =>
  Effect.gen(function* () {
    const scenario = ORCHESTRATION_LIFECYCLE_SCENARIO_CATALOG[0];
    const recordedTranscript = yield* readProviderReplayTranscript(scenario.transcriptFile);
    const transcript = materializeReplayTranscriptRuntimeInstructions(recordedTranscript, {
      driver: scenario.driver,
      model: scenario.modelSelection.model,
    });
    const fixtureInput = scenario.buildInput();
    const workspace = yield* checkpointWorkspace(scenario.name, fixtureInput.workspaceFiles);
    const materialized = yield* materializeFixtureInput({
      scenario: scenario.name,
      fixtureInput,
      driver: scenario.driver,
      modelSelection: scenario.modelSelection,
    }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
    const decodedTranscript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
      materializeReplayTranscriptWorkspace(transcript, workspace),
    );
    const result = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: scenario.name,
        transcript: decodedTranscript,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...scenario.runtimePolicyOverride, cwd: workspace },
      },
      CodexOrchestratorReplayHarness,
    ).pipe(provideDeterministicTestRuntime);

    assertToolCallReadOnlyOnRequestOutput(result, recordedTranscript);
    assert.isNotEmpty(result.storedEvents);

    const runHistory = result.domainEvents.flatMap((event) =>
      event.type === "run.created" || event.type === "run.updated" ? [event.payload.status] : [],
    );
    const providerTurnHistory = result.domainEvents.flatMap((event) =>
      event.type === "provider-turn.updated" ? [event.payload.status] : [],
    );
    const runtimeRequestHistory = result.domainEvents.flatMap((event) =>
      event.type === "runtime-request.updated" ? [event.payload.status] : [],
    );
    const runTransitions = assertAllowedHistory(
      "run",
      runHistory,
      OrchestrationV2RunLifecycle.canTransition,
    );
    const providerTurnTransitions = assertAllowedHistory(
      "provider turn",
      providerTurnHistory,
      OrchestrationV2ProviderTurnLifecycle.canTransition,
    );
    const runtimeRequestTransitions = assertAllowedHistory(
      "runtime request",
      runtimeRequestHistory,
      OrchestrationV2RuntimeRequestLifecycle.canTransition,
    );

    assert.equal(runTransitions.at(-1), scenario.expected.run);
    assert.equal(providerTurnTransitions.at(-1), scenario.expected.providerTurn);
    assert.equal(runtimeRequestTransitions.at(-1), scenario.expected.runtimeRequest);
    for (const status of scenario.states.run) assert.include(runTransitions, status);
    for (const status of scenario.states.providerTurn) {
      assert.include(providerTurnTransitions, status);
    }
    for (const status of scenario.states.runtimeRequest) {
      assert.include(runtimeRequestTransitions, status);
    }
    assert.isTrue(isOrchestrationV2RunTerminalStatus(scenario.expected.run));
    assert.isTrue(isOrchestrationV2ProviderTurnTerminalStatus(scenario.expected.providerTurn));
    assert.isTrue(isOrchestrationV2RuntimeRequestTerminalStatus(scenario.expected.runtimeRequest));
    assert.deepEqual(runtimeRequestTransitions, ["pending", "resolved"]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

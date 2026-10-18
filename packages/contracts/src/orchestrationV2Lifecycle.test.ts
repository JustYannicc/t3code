import { assert, it } from "@effect/vitest";

import {
  isOrchestrationV2ProviderTurnTerminalStatus,
  isOrchestrationV2RunTerminalStatus,
  isOrchestrationV2RuntimeRequestTerminalStatus,
  OrchestrationV2ProviderTurnLifecycle,
  OrchestrationV2RunLifecycle,
  OrchestrationV2RuntimeRequestLifecycle,
} from "./orchestrationV2Lifecycle.ts";

it("rejects terminal runs returning to active states", () => {
  const activeStatuses = ["preparing", "queued", "starting", "running", "waiting"] as const;

  for (const terminalStatus of OrchestrationV2RunLifecycle.terminal) {
    assert.isTrue(isOrchestrationV2RunTerminalStatus(terminalStatus));
    for (const activeStatus of activeStatuses) {
      assert.isFalse(
        OrchestrationV2RunLifecycle.canTransition(terminalStatus, activeStatus),
        `${terminalStatus} must not return to ${activeStatus}`,
      );
    }
  }

  assert.isTrue(OrchestrationV2RunLifecycle.canTransition("completed", "rolled_back"));
  assert.isFalse(OrchestrationV2RunLifecycle.canTransition("failed", "running"));
});

it("marks provider turns and runtime requests terminal at their resolved states", () => {
  for (const terminalStatus of OrchestrationV2ProviderTurnLifecycle.terminal) {
    assert.isTrue(isOrchestrationV2ProviderTurnTerminalStatus(terminalStatus));
    assert.isFalse(OrchestrationV2ProviderTurnLifecycle.canTransition(terminalStatus, "running"));
  }
  assert.isTrue(OrchestrationV2ProviderTurnLifecycle.canTransition("pending", "running"));

  for (const terminalStatus of OrchestrationV2RuntimeRequestLifecycle.terminal) {
    assert.isTrue(isOrchestrationV2RuntimeRequestTerminalStatus(terminalStatus));
    assert.isFalse(OrchestrationV2RuntimeRequestLifecycle.canTransition(terminalStatus, "pending"));
  }
  assert.isTrue(OrchestrationV2RuntimeRequestLifecycle.canTransition("pending", "resolved"));
});

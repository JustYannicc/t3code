import { ProviderDriverKind } from "@t3tools/contracts";

import { CODEX_MODEL_SELECTION, READ_ONLY_ON_REQUEST_POLICY } from "./fixtures/shared.ts";
import { toolCallReadOnlyOnRequestInput } from "./fixtures/tool_call_read_only_on_request/input.ts";

export const ORCHESTRATION_LIFECYCLE_SCENARIO_CATALOG = [
  {
    name: "approved-local-file-write",
    driver: ProviderDriverKind.make("codex"),
    transcriptFile: new URL(
      "./fixtures/tool_call_read_only_on_request/codex_transcript.ndjson",
      import.meta.url,
    ),
    buildInput: toolCallReadOnlyOnRequestInput,
    modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-6-sol" },
    runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
    expected: {
      run: "completed",
      providerTurn: "completed",
      runtimeRequest: "resolved",
    },
    states: {
      run: ["starting", "running", "waiting", "completed"],
      providerTurn: ["running", "completed"],
      runtimeRequest: ["pending", "resolved"],
    },
  },
] as const;

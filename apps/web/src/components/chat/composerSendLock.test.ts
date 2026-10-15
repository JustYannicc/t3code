import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { composerSubmissionIntentForKey } from "../../composer-logic";
import { composerTargetKey, DraftId } from "../../composerDraftStore";
import { holdLockedComposerSend, useComposerSendLockStore } from "./composerSendLock";

const draft = DraftId.make("draft-1");
const otherDraft = DraftId.make("draft-2");
const lock = (target: DraftId) =>
  useComposerSendLockStore.getState().toggleSendLocked(composerTargetKey(target));

beforeEach(() => useComposerSendLockStore.setState({ lockedTargetKeys: {} }));

describe("composer send lock store", () => {
  it("forgets a draft once it is unlocked", () => {
    lock(draft);
    lock(draft);

    expect(useComposerSendLockStore.getState().lockedTargetKeys).toEqual({});
  });
});

describe("composerSubmissionIntentForKey while send-locked", () => {
  const enter = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  it.each([
    ["enter", false, false],
    ["enter", true, false],
    ["enter", true, true],
    ["mod-enter", true, false],
    ["mod-enter-multiline", true, false],
  ] as const)(
    "adds a line instead of sending (%s, mod=%s, running=%s)",
    (sendShortcut, ctrlKey, isRunning) => {
      const input = {
        event: { ...enter, ctrlKey },
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        platform: "Linux",
        isMobileViewport: false,
        isDraftThread: true,
        isRunning,
        sendShortcut,
        prompt: "two\nlines",
      };
      expect(composerSubmissionIntentForKey(input)).not.toBeNull();
      expect(composerSubmissionIntentForKey({ ...input, sendLocked: true })).toBeNull();
    },
  );
});

describe("holdLockedComposerSend", () => {
  const prompt = { annotation: false, answeringPlan: false };
  const annotation = { annotation: true, answeringPlan: false };

  it("lets every send through while the draft is unlocked", () => {
    expect(holdLockedComposerSend(draft, prompt)).toBe(false);
    expect(holdLockedComposerSend(draft, annotation)).toBe(false);
  });

  it("holds prompts and preview annotations only for the locked draft", () => {
    lock(draft);

    expect(holdLockedComposerSend(draft, prompt)).toBe(true);
    expect(holdLockedComposerSend(draft, annotation)).toBe(true);
    expect(holdLockedComposerSend(otherDraft, prompt)).toBe(false);
  });

  it("never holds answering a proposed plan, but still holds an annotation sent meanwhile", () => {
    lock(draft);

    expect(holdLockedComposerSend(draft, { ...prompt, answeringPlan: true })).toBe(false);
    expect(holdLockedComposerSend(draft, { ...annotation, answeringPlan: true })).toBe(true);
  });
});

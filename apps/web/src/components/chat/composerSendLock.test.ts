import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { composerSubmissionIntentForKey } from "../../composer-logic";
import { composerTargetKey, DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import {
  holdLockedComposerSend,
  sendLockSlashCommandItem,
  useComposerSendLockStore,
} from "./composerSendLock";

const draft = DraftId.make("draft-1");
const otherDraft = DraftId.make("draft-2");
const lock = (target: DraftId) =>
  useComposerSendLockStore.getState().toggleSendLocked(composerTargetKey(target));

beforeEach(() => {
  useComposerSendLockStore.setState({ lockedTargetKeys: {} });
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
});

describe("composer send lock store", () => {
  it("forgets a draft once it is unlocked", () => {
    lock(draft);
    lock(draft);

    expect(useComposerSendLockStore.getState().lockedTargetKeys).toEqual({});
  });
  it("sets the lock idempotently for slash commands", () => {
    const store = useComposerSendLockStore.getState();
    store.setSendLocked(composerTargetKey(draft), true);
    store.setSendLocked(composerTargetKey(draft), true);
    expect(useComposerSendLockStore.getState().lockedTargetKeys[composerTargetKey(draft)]).toBe(
      true,
    );
    store.setSendLocked(composerTargetKey(draft), false);
    store.setSendLocked(composerTargetKey(draft), false);
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
  const prompt = { annotation: undefined, answeringPlan: false };
  const picked = {
    id: "picked-element",
    pageUrl: "https://example.com/",
    pageTitle: "Example",
    comment: "Fix this spacing",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: "2026-10-18T00:00:00.000Z",
  };
  const annotation = { annotation: { annotation: picked, image: null }, answeringPlan: false };

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

  it("retains a held annotation in the active queued-edit draft without duplicating it", () => {
    const edit = DraftId.make("queued-edit:thread-1:run-1");
    useComposerDraftStore.getState().addPreviewAnnotation(draft, picked);
    lock(edit);

    expect(holdLockedComposerSend(edit, annotation)).toBe(true);
    expect(holdLockedComposerSend(edit, annotation)).toBe(true);

    const store = useComposerDraftStore.getState();
    expect(store.getComposerDraft(edit)?.previewAnnotations).toEqual([picked]);
    expect(store.getComposerDraft(edit)?.prompt).toContain("picked-element");
    expect(store.getComposerDraft(draft)?.previewAnnotations).toEqual([picked]);
  });

  it("keeps a held crop on the edit draft and removes the crop claim when it cannot attach", () => {
    const file = new File(["crop"], "crop.png", { type: "image/png" });
    const image = {
      id: picked.id,
      type: "image" as const,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: "data:image/png;base64,Y3JvcA==",
      file,
    };
    const crop = {
      dataUrl: image.previewUrl,
      width: 10,
      height: 10,
      cropRect: { x: 0, y: 0, width: 10, height: 10 },
    };
    const input = {
      annotation: { annotation: { ...picked, screenshot: crop }, image },
      answeringPlan: false,
    };
    lock(draft);
    expect(holdLockedComposerSend(draft, input)).toBe(true);
    const store = useComposerDraftStore.getState();
    expect(store.getComposerDraft(draft)?.images.map((entry) => entry.id)).toEqual([picked.id]);
    expect(store.getComposerDraft(draft)?.previewAnnotations[0]?.screenshot?.dataUrl).toBe("");

    store.addImages(
      otherDraft,
      Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => ({
        ...image,
        id: `existing-${index}`,
      })),
      { allowDuplicates: true },
    );
    lock(otherDraft);
    expect(holdLockedComposerSend(otherDraft, input)).toBe(true);
    expect(store.getComposerDraft(otherDraft)?.images).toHaveLength(
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    );
    expect(store.getComposerDraft(otherDraft)?.previewAnnotations[0]?.screenshot).toBeNull();
  });

  it("never holds answering a proposed plan, but still holds an annotation sent meanwhile", () => {
    lock(draft);

    expect(holdLockedComposerSend(draft, { ...prompt, answeringPlan: true })).toBe(false);
    expect(holdLockedComposerSend(draft, { ...annotation, answeringPlan: true })).toBe(true);
  });
});

describe("sendLockSlashCommandItem", () => {
  it("offers /lock or /unlock in the normal slash search", () => {
    expect(searchSlashCommandItems([sendLockSlashCommandItem(false)], "lock")).toMatchObject([
      { command: "lock", label: "/lock" },
    ]);
    expect(searchSlashCommandItems([sendLockSlashCommandItem(true)], "unl")).toMatchObject([
      { command: "unlock", label: "/unlock" },
    ]);
  });
});

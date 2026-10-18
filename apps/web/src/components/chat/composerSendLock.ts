/**
 * The composer send lock. While a draft is locked nothing sends from it and Enter adds a
 * line, so a long prompt can't go out half-written. Answering the agent is never locked:
 * a pending question or a proposed plan's follow-up. Approvals answer through their own
 * buttons.
 *
 * Locks are keyed by `composerTargetKey` and live outside the draft store, so clearing a
 * draft never unlocks it. Only locked keys are kept, and they survive a reload.
 */
import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { resolveStorage } from "../../lib/storage";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

export const SEND_LOCKED_REASON = "Sending is locked for this draft";

interface ComposerSendLockState {
  lockedTargetKeys: Record<string, true>;
  toggleSendLocked: (targetKey: string) => void;
  setSendLocked: (targetKey: string, locked: boolean) => void;
}

export const useComposerSendLockStore = create<ComposerSendLockState>()(
  persist(
    (set, get) => ({
      lockedTargetKeys: {},
      toggleSendLocked: (targetKey) =>
        get().setSendLocked(targetKey, !get().lockedTargetKeys[targetKey]),
      setSendLocked: (targetKey, locked) =>
        set((state) => {
          if (locked === (state.lockedTargetKeys[targetKey] === true)) return state;
          if (locked) {
            return { lockedTargetKeys: { ...state.lockedTargetKeys, [targetKey]: true } };
          }
          const { [targetKey]: _removed, ...lockedTargetKeys } = state.lockedTargetKeys;
          return { lockedTargetKeys };
        }),
    }),
    {
      name: "t3code:composer-send-lock:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ lockedTargetKeys: state.lockedTargetKeys }),
    },
  ),
);

function isComposerSendLocked(target: ComposerThreadTarget): boolean {
  return useComposerSendLockStore.getState().lockedTargetKeys[composerTargetKey(target)] === true;
}

export interface ComposerSendLock {
  /** The lock's own state, which picks `/lock` or `/unlock`. */
  on: boolean;
  /** The lock holds right now: free-text sends are refused and Enter adds a line. */
  locked: boolean;
  /** Why sending is disabled, while the lock holds. */
  disabledReason: string | null;
  setLocked: (locked: boolean) => void;
}

/** ChatComposer's lock for the open draft. `answeringAgent` lifts the hold, not the lock. */
export function useComposerSendLock(targetKey: string, answeringAgent: boolean): ComposerSendLock {
  const on = useComposerSendLockStore((state) => state.lockedTargetKeys[targetKey] === true);
  const locked = on && !answeringAgent;
  const setLocked = (next: boolean) =>
    useComposerSendLockStore.getState().setSendLocked(targetKey, next);
  return { on, locked, disabledReason: locked ? SEND_LOCKED_REASON : null, setLocked };
}

/** Built-in slash item for the current draft's lock state. */
export function sendLockSlashCommandItem(
  on: boolean,
): Extract<ComposerCommandItem, { type: "slash-command" }> {
  return on
    ? {
        id: "slash:unlock",
        type: "slash-command",
        command: "unlock",
        label: "/unlock",
        description: "Let this draft send again",
      }
    : {
        id: "slash:lock",
        type: "slash-command",
        command: "lock",
        label: "/lock",
        description: "Lock sending for this draft: Enter adds a line",
      };
}

/** ChatView's `composer.toggleSendLock` shortcut. */
export function toggleComposerSendLockFromShortcut(
  event: KeyboardEvent,
  target: ComposerThreadTarget,
): void {
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  useComposerSendLockStore.getState().toggleSendLocked(composerTargetKey(target));
}

/**
 * ChatView's last word on a send. It also catches sends that skip the composer's
 * disabled button and Enter handling, like sending a preview annotation. Check annotations
 * before other send guards so queued edits retain them. Check text after pending questions
 * are handled. Returns true when the send was held.
 */
export function holdLockedComposerSend(
  target: ComposerThreadTarget,
  input: {
    annotation:
      | { annotation: PreviewAnnotationPayload; image: ComposerImageAttachment | null }
      | undefined;
    answeringPlan: boolean;
  },
): boolean {
  if (input.answeringPlan && !input.annotation) return false;
  if (!isComposerSendLocked(target)) return false;
  if (input.annotation) {
    // PreviewView writes to the thread draft. A queued-message edit has its own
    // target, so retain the annotation there too before holding the send.
    const { annotation, image } = input.annotation;
    const drafts = useComposerDraftStore.getState();
    if (image) drafts.addImages(target, [image]);
    const imageAttached = drafts
      .getComposerDraft(target)
      ?.images.some((entry) => entry.id === image?.id);
    drafts.addPreviewAnnotation(target, {
      ...annotation,
      screenshot: imageAttached ? annotation.screenshot : null,
    });
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Annotation attached to draft",
        description: "Sending is locked for this draft. Unlock it to send.",
      }),
    );
  }
  return true;
}

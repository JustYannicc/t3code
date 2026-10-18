/**
 * The composer send lock. While a draft is locked nothing sends from it and Enter adds a
 * line, so a long prompt can't go out half-written. Answering the agent is never locked:
 * a pending question or a proposed plan's follow-up. Approvals answer through their own
 * buttons.
 *
 * Locks are keyed by `composerTargetKey` and live outside the draft store, so clearing a
 * draft never unlocks it. Only locked keys are kept, and they survive a reload.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { composerTargetKey, type ComposerThreadTarget } from "../../composerDraftStore";
import { resolveStorage } from "../../lib/storage";
import { stackedThreadToast, toastManager } from "../ui/toast";

const SEND_LOCKED_REASON = "Sending locked. Click the lock to unlock";

interface ComposerSendLockState {
  lockedTargetKeys: Record<string, true>;
  toggleSendLocked: (targetKey: string) => void;
}

export const useComposerSendLockStore = create<ComposerSendLockState>()(
  persist(
    (set) => ({
      lockedTargetKeys: {},
      toggleSendLocked: (targetKey) =>
        set((state) => {
          if (!state.lockedTargetKeys[targetKey]) {
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
  /** The lock's own state, which the shackle shows. */
  on: boolean;
  /** The lock holds right now: free-text sends are refused and Enter adds a line. */
  locked: boolean;
  /** Why sending is disabled, while the lock holds. */
  disabledReason: string | null;
  toggle: () => void;
}

/** ChatComposer's lock for the open draft. `answeringAgent` lifts the hold, not the lock. */
export function useComposerSendLock(targetKey: string, answeringAgent: boolean): ComposerSendLock {
  const on = useComposerSendLockStore((state) => state.lockedTargetKeys[targetKey] === true);
  const locked = on && !answeringAgent;
  const toggle = () => useComposerSendLockStore.getState().toggleSendLocked(targetKey);
  return { on, locked, disabledReason: locked ? SEND_LOCKED_REASON : null, toggle };
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
 * disabled button and Enter handling, like sending a preview annotation. Call it after
 * pending questions are handled. Returns true when the send was held.
 */
export function holdLockedComposerSend(
  target: ComposerThreadTarget,
  input: { annotation: boolean; answeringPlan: boolean },
): boolean {
  if (input.answeringPlan && !input.annotation) return false;
  if (!isComposerSendLocked(target)) return false;
  if (input.annotation) {
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

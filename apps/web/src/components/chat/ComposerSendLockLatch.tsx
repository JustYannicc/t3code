/**
 * The send lock drawn as a padlock: the round send button is the lock body and a shackle
 * sits on top of it. Clicking the shackle latches it down onto the button (sending locked)
 * or lifts it (unlocked). While unlocked the shackle stays faint until the send area is
 * hovered or focused, so it never competes with the send button.
 */
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerSendLock } from "./composerSendLock";

// Left leg, arc, right leg. Open: the right leg stops short of the body.
const CLOSED_SHACKLE = "M4.5 15V7.5a5.5 5.5 0 0 1 11 0V15";
const OPEN_SHACKLE = "M4.5 15V7.5a5.5 5.5 0 0 1 11 0V10";

/** Wraps the send button in the padlock. Without a `lock` it renders the button alone. */
export function ComposerSendLockLatch(props: {
  lock: ComposerSendLock | undefined;
  children: ReactNode;
}) {
  if (!props.lock) return props.children;
  const { on, toggle } = props.lock;
  return (
    <span className="group/send-lock relative inline-flex shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-pressed={on}
              aria-label={on ? "Unlock sending" : "Lock sending"}
              onPointerDown={(event) => event.preventDefault()}
              onClick={toggle}
              className={cn(
                // The pseudo-element grows the hit area to 24px without covering the send button.
                "absolute bottom-full left-1/2 -mb-1.5 flex h-4 w-5 -translate-x-1/2 cursor-pointer items-end justify-center rounded-t-full outline-hidden ring-ring before:absolute before:-inset-x-0.5 before:-top-2 before:bottom-0 focus-visible:ring-2 focus-visible:ring-inset",
                on
                  ? "text-foreground"
                  : "text-muted-foreground opacity-40 group-hover/send-lock:opacity-100 group-focus-within/send-lock:opacity-100 hover:text-foreground",
              )}
            />
          }
        >
          <svg
            width="20"
            height="16"
            viewBox="0 0 20 16"
            fill="none"
            aria-hidden="true"
            className={cn(
              "transition-transform duration-150 motion-reduce:transition-none",
              on ? "translate-y-0" : "-translate-y-1",
            )}
          >
            <path
              d={on ? CLOSED_SHACKLE : OPEN_SHACKLE}
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </TooltipTrigger>
        <TooltipPopup>
          {on ? "Unlock sending" : "Lock sending. Enter adds a line until you unlock"}
        </TooltipPopup>
      </Tooltip>
      {props.children}
    </span>
  );
}

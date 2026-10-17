/**
 * Paces reads of a rate-limited provider endpoint per key, such as one usage
 * read per account. Each key is asked at most once per interval and its last
 * answer stands in between; each failed read in a row doubles the wait, and
 * the last answer keeps standing in for failed reads. `forget` makes the next
 * read ask again, for the moment the answer changed, such as a redeemed reset.
 *
 * @module provider/throttledReader
 */
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

export interface ReadPacing {
  /** How long one answer stands before the next request. */
  readonly intervalMs: number;
  /** The longest wait; each failed request in a row doubles it up to this. */
  readonly maxIntervalMs: number;
  /** How long the last answer may stand in for failed requests. Forever by default. */
  readonly keepLastMs?: number;
}

/**
 * Whether a key is asked again: never asked, or the last request is old
 * enough. Each failed request in a row doubles the wait, up to the maximum.
 */
export function readDue(
  pacing: ReadPacing,
  lastAttemptMs: number | null,
  nowMs: number,
  failedInARow = 0,
): boolean {
  const interval = Math.min(pacing.intervalMs * 2 ** failedInARow, pacing.maxIntervalMs);
  return lastAttemptMs === null || nowMs - lastAttemptMs >= interval;
}

interface Entry<A, E> {
  readonly attemptedAt: number;
  readonly failedInARow: number;
  readonly last: { readonly value: A; readonly at: number } | undefined;
  /** The last failure, returned again while a failed key waits with nothing to show. */
  readonly error: E | undefined;
}

/**
 * `read(key, request)` runs `request` only when `key` is due and otherwise
 * returns its last answer. A failed request returns the last answer while it
 * is younger than `keepLastMs`, and fails otherwise; while the key then waits,
 * reads fail with the same error without asking. Reads of one key run one at
 * a time, so a read waiting behind another gets its answer without asking.
 *
 * `forget(key)` drops everything known about `key`, after any read of it still
 * in flight, so that read's older answer doesn't stand.
 */
export const makeThrottledReader = <A, E>(pacing: ReadPacing) =>
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyMap<string, Entry<A, E>>>(new Map());
    const oneAtATime = yield* KeyedLock.make<string>();
    const keepLastMs = pacing.keepLastMs ?? Number.POSITIVE_INFINITY;
    const keepable = (entry: Entry<A, E> | undefined, now: number) =>
      entry?.last && now - entry.last.at < keepLastMs ? entry.last : undefined;

    const read = <R>(key: string, request: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      oneAtATime.withLock(
        key,
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const entry = (yield* Ref.get(entries)).get(key);
          if (entry && !readDue(pacing, entry.attemptedAt, now, entry.failedInARow)) {
            const standing = keepable(entry, now);
            if (standing) return standing.value;
            if (entry.error !== undefined) return yield* Effect.fail(entry.error);
          }
          const outcome = yield* Effect.result(request);
          // Checked again after the request, which may have outlasted keepLastMs.
          const last = Result.isSuccess(outcome)
            ? undefined
            : keepable(entry, yield* Clock.currentTimeMillis);
          yield* Ref.update(entries, (current) =>
            new Map(current).set(key, {
              attemptedAt: now,
              ...(Result.isSuccess(outcome)
                ? { failedInARow: 0, last: { value: outcome.success, at: now }, error: undefined }
                : {
                    failedInARow: (entry?.failedInARow ?? 0) + 1,
                    last,
                    error: outcome.failure,
                  }),
            }),
          );
          if (Result.isSuccess(outcome)) return outcome.success;
          if (last) return last.value;
          return yield* Effect.fail(outcome.failure);
        }),
      );

    const forget = (key: string) =>
      oneAtATime.withLock(
        key,
        Ref.update(entries, (current) => {
          if (!current.has(key)) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        }),
      );

    return { read, forget };
  });

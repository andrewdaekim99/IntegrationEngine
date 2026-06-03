// Result<T, E> — exhaustive success/failure return type. Use it whenever a
// function can fail in a way the caller should reason about (vs throwing for
// programmer errors). The worker's pipeline uses Result to fan out cleanly to
// the retry/DLQ machinery without try/catch noise at every step.

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

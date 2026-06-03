// Branded id types — zero-cost at runtime, but the compiler will refuse to
// pass an EventId where a SyncRunId is expected (and vice versa). Catches a
// real class of bugs in worker code that juggles several id flavors at once.

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type EventId = Brand<string, 'EventId'>;
export type SyncRunId = Brand<string, 'SyncRunId'>;
export type DeadLetterItemId = Brand<string, 'DeadLetterItemId'>;
export type MappingConfigId = Brand<string, 'MappingConfigId'>;
export type JobId = Brand<string, 'JobId'>;

export const EventId = (s: string): EventId => s as EventId;
export const SyncRunId = (s: string): SyncRunId => s as SyncRunId;
export const DeadLetterItemId = (s: string): DeadLetterItemId => s as DeadLetterItemId;
export const MappingConfigId = (s: string): MappingConfigId => s as MappingConfigId;
export const JobId = (s: string): JobId => s as JobId;

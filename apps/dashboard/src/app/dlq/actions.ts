'use server';

import { revalidatePath } from 'next/cache';
import { apiPost } from '@/lib/api';

export type ReplayResult =
  | { ok: true; jobId: string; eventId: string }
  | { ok: false; error: string };

export async function replayDlqItem(dlqId: string): Promise<ReplayResult> {
  try {
    const res = await apiPost<{ jobId: string; eventId: string }>(
      `/dlq/${dlqId}/replay`,
    );
    revalidatePath('/dlq');
    revalidatePath('/events');
    return { ok: true, jobId: res.jobId, eventId: res.eventId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

'use server';

import { revalidatePath } from 'next/cache';
import { apiPost } from '@/lib/api';
import type { MappingSpecProposal } from '@/lib/api';

export type ProposeResult =
  | { ok: true; proposal: MappingSpecProposal }
  | { ok: false; error: string };

export async function proposeMapping(input: {
  sourceSystem: string;
  destinationSystem: string;
  sourceSampleText: string;
  destinationSampleText: string;
}): Promise<ProposeResult> {
  let sourceSample: unknown;
  let destinationSample: unknown;
  try {
    sourceSample = JSON.parse(input.sourceSampleText);
  } catch (e) {
    return {
      ok: false,
      error: `Source sample is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  try {
    destinationSample = JSON.parse(input.destinationSampleText);
  } catch (e) {
    return {
      ok: false,
      error: `Destination sample is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  try {
    const res = await apiPost<{ proposal: MappingSpecProposal }>(
      '/mappings/proposals',
      {
        sourceSystem: input.sourceSystem,
        destinationSystem: input.destinationSystem,
        sourceSample,
        destinationSample,
      },
    );
    return { ok: true, proposal: res.proposal };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type SaveResult =
  | { ok: true; mappingId: string; version: number }
  | { ok: false; error: string };

export async function saveMapping(input: {
  sourceSystem: string;
  destinationSystem: string;
  fieldsJson: string;
  approvedBy?: string;
}): Promise<SaveResult> {
  let fields: unknown;
  try {
    fields = JSON.parse(input.fieldsJson);
  } catch (e) {
    return {
      ok: false,
      error: `MappingSpec JSON is invalid: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  try {
    const res = await apiPost<{ mapping: { id: string; version: number } }>(
      '/mappings',
      {
        sourceSystem: input.sourceSystem,
        destinationSystem: input.destinationSystem,
        fields,
        approvedBy: input.approvedBy,
        activate: true,
      },
    );
    revalidatePath('/mappings');
    revalidatePath('/events');
    return { ok: true, mappingId: res.mapping.id, version: res.mapping.version };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function activateMapping(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await apiPost(`/mappings/${id}/activate`);
    revalidatePath('/mappings');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { mappingSpecSchema, type MappingSpec } from '@integr8/core';
import { MAPPING_SYSTEM_PROMPT } from './prompts.js';

export const DEFAULT_MODEL = 'claude-opus-4-7';

/**
 * A MappingProposal is a MappingSpec with an optional top-level `notes` from
 * Claude (caveats, assumptions). The per-field `rationale` and `confidence`
 * already live on `MappingSpec.fields[].*` (they're optional in the worker's
 * applier but the proposer always sets them).
 */
export const proposalSchema = mappingSpecSchema.extend({
  notes: z.string().optional(),
});

export type MappingProposal = z.infer<typeof proposalSchema>;

export interface MappingProposerOptions {
  apiKey: string;
  /** Override the model id (defaults to claude-opus-4-7). */
  model?: string;
  /** DI hook for tests — pass a stub instead of constructing an Anthropic client. */
  client?: Anthropic;
}

export interface ProposeRequest {
  sourceSystem: string;
  destinationSystem: string;
  sourceSample: unknown;
  destinationSample: unknown;
}

export class MappingProposer {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: MappingProposerOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  async propose(req: ProposeRequest): Promise<MappingProposal> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      // System prompt is stable — cache_control marker is here so it caches
      // once the prefix grows past the model's minimum (Opus 4.7: 4096 tokens).
      system: [
        {
          type: 'text',
          text: MAPPING_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      // Thinking is intentionally off — mapping a few-dozen-field payload is a
      // structured-extraction task, not deep reasoning, and the token spend
      // doesn't pay back. Bump @anthropic-ai/sdk to ≥0.45 and switch to
      // `thinking: { type: 'adaptive' }` if proposal quality drops on complex
      // sources (the SDK types lag adaptive support).
      messages: [{ role: 'user', content: buildUserPrompt(req) }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const jsonText = stripCodeFence(text);
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(
        `MappingProposer: model returned non-JSON output. First 200 chars: ${jsonText.slice(0, 200)}`,
        { cause: e },
      );
    }

    const parsed = proposalSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `MappingProposer: response failed schema validation: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }
}

function buildUserPrompt(req: ProposeRequest): string {
  return [
    `SOURCE system: ${req.sourceSystem}`,
    `DESTINATION system: ${req.destinationSystem}`,
    '',
    'SOURCE sample payload:',
    JSON.stringify(req.sourceSample, null, 2),
    '',
    'DESTINATION sample shape:',
    JSON.stringify(req.destinationSample, null, 2),
    '',
    'Propose a MappingSpec that transforms the SOURCE shape into the DESTINATION shape.',
    'Respond with the JSON object only.',
  ].join('\n');
}

function stripCodeFence(text: string): string {
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  return text;
}

export type { MappingSpec };

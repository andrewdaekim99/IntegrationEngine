'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Sparkles, Save } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { Confidence, MappingSpecProposal } from '@/lib/api';
import { proposeMapping, saveMapping } from '../actions';

const confidenceVariant: Record<
  Confidence,
  React.ComponentProps<typeof Badge>['variant']
> = {
  high: 'success',
  medium: 'warning',
  low: 'destructive',
};

interface StudioProps {
  defaultSource: string;
  defaultDestination: string;
  defaultSourceSystem: string;
  defaultDestinationSystem: string;
}

export function Studio({
  defaultSource,
  defaultDestination,
  defaultSourceSystem,
  defaultDestinationSystem,
}: StudioProps) {
  const router = useRouter();
  const [sourceSystem, setSourceSystem] = useState(defaultSourceSystem);
  const [destinationSystem, setDestinationSystem] = useState(defaultDestinationSystem);
  const [sourceSample, setSourceSample] = useState(defaultSource);
  const [destinationSample, setDestinationSample] = useState(defaultDestination);

  const [proposal, setProposal] = useState<MappingSpecProposal | null>(null);
  const [editedJson, setEditedJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [proposing, startProposing] = useTransition();
  const [saving, startSaving] = useTransition();

  function onPropose() {
    setError(null);
    setSuccess(null);
    startProposing(async () => {
      const r = await proposeMapping({
        sourceSystem,
        destinationSystem,
        sourceSampleText: sourceSample,
        destinationSampleText: destinationSample,
      });
      if (r.ok) {
        setProposal(r.proposal);
        setEditedJson(JSON.stringify(r.proposal, null, 2));
      } else {
        setError(r.error);
      }
    });
  }

  function onSave() {
    setError(null);
    setSuccess(null);
    startSaving(async () => {
      const r = await saveMapping({
        sourceSystem,
        destinationSystem,
        fieldsJson: editedJson,
        approvedBy: 'dashboard',
      });
      if (r.ok) {
        setSuccess(`Saved as version ${r.version}. Redirecting…`);
        setTimeout(() => router.push('/mappings'), 700);
      } else {
        setError(r.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Step 1 — sample payloads</CardTitle>
          <CardDescription>
            Paste a source-side webhook body and the destination shape you want
            to produce.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Source system
              </label>
              <Input
                value={sourceSystem}
                onChange={(e) => setSourceSystem(e.target.value)}
                placeholder="shopify"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Destination system
              </label>
              <Input
                value={destinationSystem}
                onChange={(e) => setDestinationSystem(e.target.value)}
                placeholder="mock-erp"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <JsonTextarea
              label="Source sample (JSON)"
              value={sourceSample}
              onChange={setSourceSample}
            />
            <JsonTextarea
              label="Destination shape (JSON)"
              value={destinationSample}
              onChange={setDestinationSample}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={onPropose} disabled={proposing}>
              <Sparkles className="mr-1.5 h-4 w-4" />
              {proposing ? 'Asking Claude…' : 'Propose with Claude'}
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </CardContent>
      </Card>

      {proposal && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 2 — review proposal</CardTitle>
            <CardDescription>
              {proposal.notes ?? `${proposal.fields.length} fields proposed.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {proposal.fields.map((f, i) => (
                <div key={i} className="rounded-md border bg-card p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-xs font-semibold">{f.to}</code>
                    {f.confidence && (
                      <Badge variant={confidenceVariant[f.confidence]}>
                        {f.confidence}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {f.from && <>← <code className="font-mono">{f.from}</code></>}
                    {f.template && (
                      <>template <code className="font-mono">{f.template}</code></>
                    )}
                    {f.constant !== undefined && (
                      <>constant <code className="font-mono">{JSON.stringify(f.constant)}</code></>
                    )}
                    {f.fallbackFrom && f.fallbackFrom.length > 0 && (
                      <> · fallback <code className="font-mono">{f.fallbackFrom.join(', ')}</code></>
                    )}
                  </div>
                  {f.rationale && (
                    <p className="mt-2 text-xs italic text-muted-foreground">{f.rationale}</p>
                  )}
                </div>
              ))}
            </div>

            {proposal.arrays && proposal.arrays.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Array mappings</h3>
                {proposal.arrays.map((a, i) => (
                  <div key={i} className="rounded-md border bg-card p-3 text-sm">
                    <code className="font-mono text-xs font-semibold">
                      {a.to} ← {a.from}
                    </code>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Element fields:{' '}
                      <code className="font-mono">
                        {a.fields.map((af) => af.to).join(', ')}
                      </code>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {proposal && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 3 — edit + approve</CardTitle>
            <CardDescription>
              Edit the JSON below if you want to tweak any field, then approve
              to make this the active mapping the worker uses.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <textarea
              value={editedJson}
              onChange={(e) => setEditedJson(e.target.value)}
              className="h-80 w-full rounded-md border bg-muted/40 p-3 font-mono text-xs"
              spellCheck={false}
            />
            <div className="flex items-center gap-3">
              <Button onClick={onSave} disabled={saving}>
                <Save className="mr-1.5 h-4 w-4" />
                {saving ? 'Saving…' : 'Save & activate'}
              </Button>
              {success && <p className="text-sm text-emerald-600">{success}</p>}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function JsonTextarea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-72 w-full rounded-md border bg-muted/40 p-3 font-mono text-xs"
        spellCheck={false}
      />
    </div>
  );
}

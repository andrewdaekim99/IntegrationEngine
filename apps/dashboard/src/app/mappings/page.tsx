import Link from 'next/link';
import { Plus, Wand2 } from 'lucide-react';
import { apiGet, type MappingsListResponse } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ActivateButton } from './activate-button';

export const dynamic = 'force-dynamic';

export default async function MappingsPage() {
  let data: MappingsListResponse | null = null;
  let error: string | null = null;
  try {
    data = await apiGet<MappingsListResponse>('/mappings?limit=100');
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mapping studio</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Field mappings Claude proposes and you approve, then the worker uses
            on every inbound event.
          </p>
        </div>
        <Button asChild>
          <Link href="/mappings/new">
            <Plus className="mr-1.5 h-4 w-4" />
            New mapping
          </Link>
        </Button>
      </header>

      {error ? (
        <Card>
          <CardContent className="space-y-2 py-8 text-center text-destructive">
            <p className="font-medium">Couldn’t reach the API.</p>
            <p className="font-mono text-xs">{error}</p>
          </CardContent>
        </Card>
      ) : !data || data.mappings.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
            <Wand2 className="h-8 w-8" />
            <p className="font-medium">No mappings yet.</p>
            <p className="text-sm">
              Until you approve one, the worker uses the hardcoded Shopify → Mock ERP mapper.
            </p>
            <Button asChild className="mt-2">
              <Link href="/mappings/new">Propose your first mapping</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source → Destination</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Fields</TableHead>
                <TableHead>Approved by</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.mappings.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono text-xs">
                    {m.sourceSystem} → {m.destinationSystem}
                  </TableCell>
                  <TableCell>v{m.version}</TableCell>
                  <TableCell>
                    {m.fields.fields.length}
                    {m.fields.arrays && m.fields.arrays.length > 0
                      ? ` + ${m.fields.arrays.length} array${m.fields.arrays.length === 1 ? '' : 's'}`
                      : ''}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {m.approvedBy ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatRelative(m.createdAt)}
                  </TableCell>
                  <TableCell>
                    {m.isActive ? (
                      <Badge variant="success">active</Badge>
                    ) : (
                      <Badge variant="outline">inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {!m.isActive && <ActivateButton mappingId={m.id} />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

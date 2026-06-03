// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EventStatusBadge, SyncRunOutcomeBadge } from '@/components/status-badge';

describe('EventStatusBadge', () => {
  it('renders all status labels in lowercase with spaces', () => {
    const cases = [
      'RECEIVED',
      'PROCESSING',
      'SUCCEEDED',
      'DEDUPED',
      'RETRYING',
      'DEAD_LETTERED',
    ] as const;
    for (const status of cases) {
      const { unmount } = render(<EventStatusBadge status={status} />);
      const expected = status.toLowerCase().replace('_', ' ');
      expect(screen.getByText(expected)).toBeInTheDocument();
      unmount();
    }
  });
});

describe('SyncRunOutcomeBadge', () => {
  it('renders the outcome label', () => {
    render(<SyncRunOutcomeBadge outcome="RETRYABLE_FAILURE" />);
    expect(screen.getByText('retryable failure')).toBeInTheDocument();
  });
});

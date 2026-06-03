// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReplayButton } from '@/app/dlq/replay-button';

// Mock the Server Action module.
vi.mock('@/app/dlq/actions', () => ({
  replayDlqItem: vi.fn(),
}));

// Mock the Next.js router so router.refresh() doesn't crash.
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

import { replayDlqItem } from '@/app/dlq/actions';
const mockedAction = vi.mocked(replayDlqItem);

describe('ReplayButton', () => {
  beforeEach(() => {
    mockedAction.mockReset();
    refresh.mockReset();
  });

  afterEach(() => cleanup());

  it('calls replayDlqItem with the dlqId on click', async () => {
    mockedAction.mockResolvedValue({ ok: true, jobId: 'job-1', eventId: 'evt-1' });
    const user = userEvent.setup();
    render(<ReplayButton dlqId="dlq-42" />);

    await user.click(screen.getByRole('button', { name: /replay/i }));

    await waitFor(() => {
      expect(mockedAction).toHaveBeenCalledWith('dlq-42');
    });
  });

  it('shows an error inline if the action fails', async () => {
    mockedAction.mockResolvedValue({ ok: false, error: 'API down' });
    const user = userEvent.setup();
    render(<ReplayButton dlqId="dlq-42" />);

    await user.click(screen.getByRole('button', { name: /replay/i }));

    await waitFor(() => {
      expect(screen.getByText('API down')).toBeInTheDocument();
    });
  });
});

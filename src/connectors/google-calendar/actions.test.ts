import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildGoogleCalendarActions } from './actions.js';
import { OAuthHelper } from '../oauth.js';
import { CredentialVault } from '../../secrets/vault.js';

describe('Google Calendar actions', () => {
  let vault: CredentialVault;
  let helper: OAuthHelper;
  let actions: ReturnType<typeof buildGoogleCalendarActions>;
  const ctx = { tenant_id: 't1', user_id: 'u1' };

  beforeEach(() => {
    vault = new CredentialVault(':memory:', 'test');
    helper = new OAuthHelper(
      {
        client_id: 'c',
        client_secret: 's',
        auth_endpoint: 'https://auth.example.com',
        token_endpoint: 'https://token.example.com',
        scopes: ['calendar'],
        redirect_uri: 'https://example.com/callback',
      },
      vault,
      'google-calendar'
    );
    actions = buildGoogleCalendarActions(helper);

    // Pre-seed an access token
    vault.set('tenants/t1/users/u1/connectors/google-calendar/access_token', 'test-at');
  });

  afterEach(() => {
    vault.close();
    vi.unstubAllGlobals();
  });

  describe('list_events', () => {
    it('calls Google Calendar API and returns parsed events', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: 'evt-1',
              summary: 'Team standup',
              start: { dateTime: '2026-04-14T09:00:00Z' },
              end: { dateTime: '2026-04-14T09:30:00Z' },
              location: 'Room A',
            },
            {
              id: 'evt-2',
              summary: 'Lunch',
              start: { date: '2026-04-14' },
              end: { date: '2026-04-14' },
            },
          ],
        }),
      }));

      const result = await actions['list_events']!.execute(
        { max_results: 5 },
        ctx
      ) as Array<Record<string, unknown>>;

      expect(result).toHaveLength(2);
      expect(result[0]!['summary']).toBe('Team standup');
      expect(result[0]!['start']).toBe('2026-04-14T09:00:00Z');
      expect(result[1]!['start']).toBe('2026-04-14'); // date-only event
    });

    it('throws when not connected', async () => {
      vault.delete('tenants/t1/users/u1/connectors/google-calendar/access_token');
      await expect(
        actions['list_events']!.execute({}, ctx)
      ).rejects.toThrow('Not connected');
    });
  });

  describe('create_event', () => {
    it('sends a POST and returns the created event ID', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'new-evt',
          htmlLink: 'https://calendar.google.com/event/new-evt',
        }),
      }));

      const result = await actions['create_event']!.execute(
        {
          summary: 'New meeting',
          start: '2026-05-01T10:00:00Z',
          end: '2026-05-01T11:00:00Z',
        },
        ctx
      ) as Record<string, unknown>;

      expect(result['id']).toBe('new-evt');
      expect(result['htmlLink']).toBeTruthy();

      // Verify the API was called with correct method
      const fetchFn = vi.mocked(globalThis.fetch);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchFn.mock.calls[0]!;
      expect(String(url)).toContain('/calendars/primary/events');
      expect(opts?.method).toBe('POST');
    });
  });

  describe('delete_event', () => {
    it('sends a DELETE request', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => ({}),
      }));

      const result = await actions['delete_event']!.execute(
        { event_id: 'evt-to-delete' },
        ctx
      ) as Record<string, unknown>;

      expect(result['deleted']).toBe(true);
    });
  });
});

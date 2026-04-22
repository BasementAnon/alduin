import { z } from 'zod';
import type { ConnectorAction } from '../framework.js';
import type { OAuthHelper } from '../oauth.js';

const GCAL_API = 'https://www.googleapis.com/calendar/v3';

// ── Schemas ───────────────────────────────────────────────────────────────────

export const listEventsInputSchema = z.object({
  calendar_id: z.string().default('primary'),
  time_min: z.string().optional(),
  time_max: z.string().optional(),
  max_results: z.number().int().min(1).max(100).default(10),
});

export const listEventsOutputSchema = z.array(
  z.object({
    id: z.string(),
    summary: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    location: z.string().optional(),
  })
);

export const createEventInputSchema = z.object({
  calendar_id: z.string().default('primary'),
  summary: z.string(),
  start: z.string(),
  end: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
});

export const createEventOutputSchema = z.object({
  id: z.string(),
  htmlLink: z.string().optional(),
});

export const updateEventInputSchema = z.object({
  calendar_id: z.string().default('primary'),
  event_id: z.string(),
  summary: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
});

export const deleteEventInputSchema = z.object({
  calendar_id: z.string().default('primary'),
  event_id: z.string(),
});

// ── Action builders ───────────────────────────────────────────────────────────

async function apiCall(
  method: string,
  url: string,
  accessToken: string,
  body?: unknown
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google Calendar API ${res.status}: ${text}`);
  }

  if (res.status === 204) return {};
  return res.json();
}

/**
 * Build the four Google Calendar actions.
 * Each action reads the access token from the OAuthHelper at call time —
 * they never hold raw tokens as properties.
 */
export function buildGoogleCalendarActions(
  oauthHelper: OAuthHelper
): Record<string, ConnectorAction> {
  return {
    list_events: {
      name: 'list_events',
      description: 'List upcoming calendar events',
      inputSchema: listEventsInputSchema,
      outputSchema: listEventsOutputSchema,
      async execute(input, ctx) {
        const parsed = listEventsInputSchema.parse(input);
        const token = oauthHelper.getAccessToken(ctx.tenant_id, ctx.user_id);
        if (!token) throw new Error('Not connected to Google Calendar');

        const params = new URLSearchParams({
          maxResults: String(parsed.max_results),
          singleEvents: 'true',
          orderBy: 'startTime',
        });
        if (parsed.time_min) params.set('timeMin', parsed.time_min);
        if (parsed.time_max) params.set('timeMax', parsed.time_max);

        const data = (await apiCall(
          'GET',
          `${GCAL_API}/calendars/${encodeURIComponent(parsed.calendar_id)}/events?${params}`,
          token
        )) as { items?: Array<Record<string, unknown>> };

        return (data.items ?? []).map((e) => ({
          id: String(e['id'] ?? ''),
          summary: e['summary'] as string | undefined,
          start: (e['start'] as Record<string, string>)?.['dateTime'] ??
                 (e['start'] as Record<string, string>)?.['date'],
          end: (e['end'] as Record<string, string>)?.['dateTime'] ??
               (e['end'] as Record<string, string>)?.['date'],
          location: e['location'] as string | undefined,
        }));
      },
    },

    create_event: {
      name: 'create_event',
      description: 'Create a new calendar event',
      inputSchema: createEventInputSchema,
      outputSchema: createEventOutputSchema,
      async execute(input, ctx) {
        const parsed = createEventInputSchema.parse(input);
        const token = oauthHelper.getAccessToken(ctx.tenant_id, ctx.user_id);
        if (!token) throw new Error('Not connected to Google Calendar');

        const body = {
          summary: parsed.summary,
          start: { dateTime: parsed.start },
          end: { dateTime: parsed.end },
          description: parsed.description,
          location: parsed.location,
        };

        const data = (await apiCall(
          'POST',
          `${GCAL_API}/calendars/${encodeURIComponent(parsed.calendar_id)}/events`,
          token,
          body
        )) as { id: string; htmlLink?: string };

        return { id: data.id, htmlLink: data.htmlLink };
      },
    },

    update_event: {
      name: 'update_event',
      description: 'Update an existing calendar event',
      inputSchema: updateEventInputSchema,
      outputSchema: z.object({ id: z.string() }),
      async execute(input, ctx) {
        const parsed = updateEventInputSchema.parse(input);
        const token = oauthHelper.getAccessToken(ctx.tenant_id, ctx.user_id);
        if (!token) throw new Error('Not connected to Google Calendar');

        const body: Record<string, unknown> = {};
        if (parsed.summary) body['summary'] = parsed.summary;
        if (parsed.start) body['start'] = { dateTime: parsed.start };
        if (parsed.end) body['end'] = { dateTime: parsed.end };
        if (parsed.description) body['description'] = parsed.description;
        if (parsed.location) body['location'] = parsed.location;

        const data = (await apiCall(
          'PATCH',
          `${GCAL_API}/calendars/${encodeURIComponent(parsed.calendar_id)}/events/${parsed.event_id}`,
          token,
          body
        )) as { id: string };

        return { id: data.id };
      },
    },

    delete_event: {
      name: 'delete_event',
      description: 'Delete a calendar event',
      inputSchema: deleteEventInputSchema,
      outputSchema: z.object({ deleted: z.boolean() }),
      async execute(input, ctx) {
        const parsed = deleteEventInputSchema.parse(input);
        const token = oauthHelper.getAccessToken(ctx.tenant_id, ctx.user_id);
        if (!token) throw new Error('Not connected to Google Calendar');

        await apiCall(
          'DELETE',
          `${GCAL_API}/calendars/${encodeURIComponent(parsed.calendar_id)}/events/${parsed.event_id}`,
          token
        );

        return { deleted: true };
      },
    },
  };
}

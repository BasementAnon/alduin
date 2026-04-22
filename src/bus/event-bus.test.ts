import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlduinEventBus } from './event-bus.js';
import type { ExecutorEvent } from './event-bus.js';

function makeEvent(overrides: Partial<ExecutorEvent> = {}): ExecutorEvent {
  return {
    task_id: 'task-1',
    session_id: 'session-A',
    step_index: 0,
    kind: 'progress',
    data: { label: 'Working…' },
    emitted_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('AlduinEventBus', () => {
  let bus: AlduinEventBus;

  beforeEach(() => {
    bus = new AlduinEventBus(':memory:');
  });

  afterEach(() => {
    bus.close();
  });

  it('delivers events to session-scoped subscribers', () => {
    const received: ExecutorEvent[] = [];
    bus.subscribe('session-A', (e) => received.push(e));

    bus.publish(makeEvent());

    expect(received).toHaveLength(1);
    expect(received[0]!.task_id).toBe('task-1');
    expect(received[0]!.kind).toBe('progress');
  });

  it('does not deliver events from other sessions', () => {
    const received: ExecutorEvent[] = [];
    bus.subscribe('session-B', (e) => received.push(e));

    bus.publish(makeEvent({ session_id: 'session-A' }));

    expect(received).toHaveLength(0);
  });

  it('subscribeAll receives events from any session', () => {
    const received: ExecutorEvent[] = [];
    bus.subscribeAll((e) => received.push(e));

    bus.publish(makeEvent({ session_id: 'session-A' }));
    bus.publish(makeEvent({ session_id: 'session-B' }));

    expect(received).toHaveLength(2);
  });

  it('unsubscribe stops further event delivery', () => {
    const received: ExecutorEvent[] = [];
    const unsub = bus.subscribe('session-A', (e) => received.push(e));

    bus.publish(makeEvent());
    unsub();
    bus.publish(makeEvent());

    expect(received).toHaveLength(1);
  });

  it('persists events and replays them by session', () => {
    bus.publish(makeEvent({ session_id: 'session-A', kind: 'progress' }));
    bus.publish(makeEvent({ session_id: 'session-A', kind: 'partial' }));
    bus.publish(makeEvent({ session_id: 'session-B', kind: 'artifact' }));

    const replayed = bus.replay('session-A');
    expect(replayed).toHaveLength(2);
    expect(replayed[0]!.kind).toBe('progress');
    expect(replayed[1]!.kind).toBe('partial');
  });

  it('replay for empty session returns empty array', () => {
    expect(bus.replay('nonexistent')).toHaveLength(0);
  });

  it('eventCount returns correct count per session', () => {
    bus.publish(makeEvent({ session_id: 'session-A' }));
    bus.publish(makeEvent({ session_id: 'session-A' }));
    bus.publish(makeEvent({ session_id: 'session-B' }));

    expect(bus.eventCount('session-A')).toBe(2);
    expect(bus.eventCount('session-B')).toBe(1);
    expect(bus.eventCount('session-C')).toBe(0);
  });
});

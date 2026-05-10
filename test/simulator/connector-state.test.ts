import { describe, expect, it, vi } from 'vitest';
import {
  CONNECTOR_TRANSITIONS,
  ConnectorStateMachine,
  InvalidTransitionError,
  nextStatus,
  type ConnectorEvent,
  type ConnectorStatus,
} from '../../src/index.js';

const STATES: ConnectorStatus[] = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Faulted',
  'Unavailable',
];

describe('connector state machine', () => {
  it.each<[ConnectorStatus, ConnectorEvent, ConnectorStatus]>([
    ['Available', 'plugIn', 'Preparing'],
    ['Available', 'authorize', 'Preparing'],
    ['Preparing', 'timeout', 'Available'],
    ['Preparing', 'unplug', 'Available'],
    ['Preparing', 'energyFlowing', 'Charging'],
    ['Preparing', 'suspendByEV', 'SuspendedEV'],
    ['Preparing', 'suspendByEVSE', 'SuspendedEVSE'],
    ['Preparing', 'transactionStopped', 'Finishing'],
    ['Charging', 'suspendByEV', 'SuspendedEV'],
    ['Charging', 'suspendByEVSE', 'SuspendedEVSE'],
    ['Charging', 'transactionStopped', 'Finishing'],
    ['Charging', 'unplug', 'Available'],
    ['SuspendedEV', 'energyFlowing', 'Charging'],
    ['SuspendedEV', 'suspendByEVSE', 'SuspendedEVSE'],
    ['SuspendedEVSE', 'energyFlowing', 'Charging'],
    ['SuspendedEVSE', 'suspendByEV', 'SuspendedEV'],
    ['SuspendedEVSE', 'transactionStopped', 'Finishing'],
    ['Finishing', 'unplug', 'Available'],
    ['Finishing', 'makeUnavailable', 'Unavailable'],
    ['Available', 'makeUnavailable', 'Unavailable'],
    ['Unavailable', 'makeAvailable', 'Available'],
    ['Charging', 'fault', 'Faulted'],
    ['Unavailable', 'fault', 'Faulted'],
    ['Faulted', 'faultCleared', 'Available'],
    ['Faulted', 'makeUnavailable', 'Unavailable'],
  ])('%s --%s--> %s', (from, event, to) => {
    expect(nextStatus(from, event)).toBe(to);
    const fsm = new ConnectorStateMachine(from);
    expect(fsm.apply(event)).toBe(to);
    expect(fsm.status).toBe(to);
  });

  it.each<[ConnectorStatus, ConnectorEvent]>([
    ['Available', 'energyFlowing'],
    ['Available', 'transactionStopped'],
    ['Available', 'unplug'],
    ['Charging', 'plugIn'],
    ['Charging', 'makeUnavailable'],
    ['Finishing', 'energyFlowing'],
    ['Faulted', 'plugIn'],
    ['Faulted', 'fault'],
    ['Unavailable', 'plugIn'],
    ['Unavailable', 'authorize'],
  ])('rejects %s --%s-->', (from, event) => {
    const fsm = new ConnectorStateMachine(from);
    expect(fsm.can(event)).toBe(false);
    expect(fsm.tryApply(event)).toBe(false);
    expect(() => fsm.apply(event)).toThrow(InvalidTransitionError);
    expect(fsm.status).toBe(from);
  });

  it('only ever produces known states', () => {
    for (const table of Object.values(CONNECTOR_TRANSITIONS)) {
      for (const [from, to] of Object.entries(table)) {
        expect(STATES).toContain(from);
        expect(STATES).toContain(to);
      }
    }
  });

  it('can fault from every operational state', () => {
    for (const state of STATES.filter((s) => s !== 'Faulted')) {
      expect(nextStatus(state, 'fault')).toBe('Faulted');
    }
  });

  it('notifies listeners with the new and previous status', () => {
    const fsm = new ConnectorStateMachine();
    const listener = vi.fn();
    fsm.onChange(listener);
    fsm.apply('plugIn');
    fsm.apply('energyFlowing');
    fsm.apply('transactionStopped');
    fsm.apply('unplug');
    expect(listener.mock.calls).toEqual([
      ['Preparing', 'Available', 'plugIn'],
      ['Charging', 'Preparing', 'energyFlowing'],
      ['Finishing', 'Charging', 'transactionStopped'],
      ['Available', 'Finishing', 'unplug'],
    ]);
  });
});

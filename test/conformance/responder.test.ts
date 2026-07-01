import { describe, expect, it } from 'vitest';
import {
  CentralSystemToChargePoint,
  collectIssues,
  decliningChargePoint,
} from '../../src/index.js';

describe('the declining charge point responder', () => {
  it('answers every Central System action with a valid, negative answer', () => {
    for (const [action, schema] of Object.entries(CentralSystemToChargePoint)) {
      const answer = decliningChargePoint({ type: 2, messageId: '1', action, payload: {} });
      expect(answer, action).toHaveProperty('payload');
      const payload = (answer as { payload: unknown }).payload;
      expect(collectIssues(schema.response, payload), action).toEqual([]);
    }
  });

  it('reports its configuration and unknown keys', () => {
    const answer = (key?: unknown) =>
      decliningChargePoint({
        type: 2,
        messageId: '1',
        action: 'GetConfiguration',
        payload: key === undefined ? {} : { key },
      });
    expect(answer()).toEqual({
      payload: {
        configurationKey: [
          { key: 'NumberOfConnectors', value: '2', readonly: true },
          {
            key: 'SupportedFeatureProfiles',
            value:
              'Core,FirmwareManagement,LocalAuthListManagement,Reservation,SmartCharging,RemoteTrigger',
            readonly: true,
          },
        ],
      },
    });
    expect(answer(['numberofconnectors', 'Nope'])).toEqual({
      payload: {
        configurationKey: [{ key: 'NumberOfConnectors', value: '2', readonly: true }],
        unknownKey: ['Nope'],
      },
    });
    expect(answer(['Nope'])).toEqual({ payload: { unknownKey: ['Nope'] } });
  });

  it('answers unknown actions with NotImplemented', () => {
    expect(
      decliningChargePoint({ type: 2, messageId: '1', action: 'toString', payload: {} }),
    ).toEqual({ error: 'NotImplemented', description: 'Unknown action toString' });
  });
});

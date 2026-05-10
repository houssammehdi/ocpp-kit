import { describe, expect, it, vi } from 'vitest';
import { ConfigurationStore, defaultConfiguration } from '../../src/index.js';

const store = () => new ConfigurationStore(defaultConfiguration({ connectors: 2 }), 3);

describe('ConfigurationStore', () => {
  it('exposes the standard keys with their read-only flags', () => {
    const config = store();
    const all = config.getConfiguration().configurationKey ?? [];
    const byKey = new Map(all.map((kv) => [kv.key, kv]));
    expect(byKey.get('NumberOfConnectors')).toEqual({
      key: 'NumberOfConnectors',
      readonly: true,
      value: '2',
    });
    expect(byKey.get('HeartbeatInterval')?.readonly).toBe(false);
    expect(byKey.get('SupportedFeatureProfiles')?.value).toBe('Core,SmartCharging,RemoteTrigger');
  });

  it('accepts valid changes and notifies listeners', () => {
    const config = store();
    const listener = vi.fn();
    config.onChange(listener);
    expect(config.change('HeartbeatInterval', '60')).toBe('Accepted');
    expect(config.getInteger('HeartbeatInterval', 0)).toBe(60);
    expect(listener).toHaveBeenCalledWith('HeartbeatInterval', '60');
  });

  it('rejects read-only keys and invalid values, and reports unknown keys as NotSupported', () => {
    const config = store();
    expect(config.change('NumberOfConnectors', '4')).toBe('Rejected');
    expect(config.change('HeartbeatInterval', 'soon')).toBe('Rejected');
    expect(config.change('HeartbeatInterval', '-1')).toBe('Rejected');
    expect(config.change('ConnectionTimeOut', '0')).toBe('Rejected');
    expect(config.change('LocalAuthorizeOffline', 'yes')).toBe('Rejected');
    expect(config.change('MeterValuesSampledData', 'Energy.Active.Import.Register,Banana')).toBe(
      'Rejected',
    );
    expect(config.change('TotallyMadeUp', '1')).toBe('NotSupported');
    expect(config.getInteger('HeartbeatInterval', 0)).toBe(300);
  });

  it('accepts measurand lists and signals keys that need a reboot', () => {
    const config = store();
    expect(config.change('MeterValuesSampledData', 'Power.Active.Import, SoC')).toBe('Accepted');
    expect(config.getList('MeterValuesSampledData')).toEqual(['Power.Active.Import', 'SoC']);
    expect(config.change('WebSocketPingInterval', '30')).toBe('RebootRequired');
  });

  it('matches keys case-insensitively and splits known from unknown keys', () => {
    const config = store();
    expect(config.getConfiguration(['heartbeatinterval', 'Nope'])).toEqual({
      configurationKey: [{ key: 'HeartbeatInterval', readonly: false, value: '300' }],
      unknownKey: ['Nope'],
    });
    expect(config.getConfiguration(['Nope'])).toEqual({ unknownKey: ['Nope'] });
  });

  it('limits the number of requested keys to GetConfigurationMaxKeys', () => {
    const config = store();
    const response = config.getConfiguration(['A', 'B', 'C', 'D', 'E']);
    expect(response.unknownKey).toEqual(['A', 'B', 'C']);
  });

  it('allows firmware-side updates of read-only keys and falls back for bad values', () => {
    const config = store();
    config.set('NumberOfConnectors', '3');
    expect(config.get('NumberOfConnectors')).toBe('3');
    expect(() => config.set('Nope', '1')).toThrow(RangeError);
    expect(config.getInteger('SupportedFeatureProfiles', 7)).toBe(7);
    expect(config.getBoolean('Missing', true)).toBe(true);
    expect(config.getList('Missing')).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  AuthorizationCache,
  authorizeIdTag,
  effectiveInfo,
  LocalAuthorizationList,
  sameGroup,
  type AuthorizationContext,
  type AuthorizationPolicy,
  type CentralSystemVerdict,
  type IdTagInfo,
} from '../../src/index.js';

const NOW = new Date('2026-05-01T12:00:00Z');
const past = '2026-04-01T00:00:00Z';
const future = '2026-06-01T00:00:00Z';

const policy: AuthorizationPolicy = {
  localAuthListEnabled: true,
  authorizationCacheEnabled: true,
  localPreAuthorize: false,
  localAuthorizeOffline: true,
  allowOfflineTxForUnknownId: false,
};

function context(
  overrides: Partial<AuthorizationContext> & {
    verdict?: CentralSystemVerdict;
    rules?: Partial<AuthorizationPolicy>;
  } = {},
) {
  const { verdict = { kind: 'answered', idTagInfo: { status: 'Accepted' } }, rules } = overrides;
  const askCentralSystem = vi.fn(() => Promise.resolve(verdict));
  const ctx: AuthorizationContext = {
    online: true,
    policy: { ...policy, ...rules },
    localList: new LocalAuthorizationList(),
    cache: new AuthorizationCache(),
    askCentralSystem,
    now: NOW,
    ...overrides,
  };
  return { ctx, askCentralSystem };
}

function list(entries: [string, IdTagInfo][], listVersion = 1): LocalAuthorizationList {
  const localList = new LocalAuthorizationList();
  localList.apply({
    listVersion,
    updateType: 'Full',
    localAuthorizationList: entries.map(([idTag, idTagInfo]) => ({ idTag, idTagInfo })),
  });
  return localList;
}

describe('effectiveInfo', () => {
  it('turns an Accepted entry past its expiry date into Expired', () => {
    expect(effectiveInfo({ status: 'Accepted', expiryDate: past }, NOW).status).toBe('Expired');
    expect(effectiveInfo({ status: 'Accepted', expiryDate: future }, NOW).status).toBe('Accepted');
    expect(effectiveInfo({ status: 'Blocked', expiryDate: past }, NOW).status).toBe('Blocked');
  });
});

describe('AuthorizationCache', () => {
  it('stores the latest info per idTag, case-insensitively', () => {
    const cache = new AuthorizationCache();
    cache.update('CARD-1', { status: 'Accepted' });
    cache.update('card-1', { status: 'Blocked' });
    expect(cache.size).toBe(1);
    expect(cache.get('Card-1', NOW)).toEqual({ status: 'Blocked' });
    cache.clear();
    expect(cache.get('CARD-1', NOW)).toBeUndefined();
  });

  it('marks expired entries as Expired', () => {
    const cache = new AuthorizationCache();
    cache.update('A', { status: 'Accepted', expiryDate: past });
    expect(cache.get('A', NOW)?.status).toBe('Expired');
    expect(cache.entries()[0]?.idTagInfo.status).toBe('Expired');
  });

  it('evicts entries that are not Accepted first, then the least recently used', () => {
    const cache = new AuthorizationCache({ capacity: 3 });
    cache.update('A', { status: 'Accepted' });
    cache.update('B', { status: 'Blocked' });
    cache.update('C', { status: 'Accepted' });
    cache.update('D', { status: 'Accepted' }); // evicts B, the only non-Accepted entry
    expect(cache.entries().map((e) => e.idTag)).toEqual(['A', 'C', 'D']);
    cache.get('A', NOW); // A becomes the most recently used
    cache.update('E', { status: 'Accepted' }); // evicts C
    expect(cache.entries().map((e) => e.idTag)).toEqual(['D', 'A', 'E']);
  });
});

describe('LocalAuthorizationList', () => {
  it('replaces the list on a Full update and reports its version', () => {
    const localList = list([['A', { status: 'Accepted' }]], 3);
    expect(localList.version).toBe(3);
    expect(
      localList.apply({
        listVersion: 5,
        updateType: 'Full',
        localAuthorizationList: [{ idTag: 'B', idTagInfo: { status: 'Blocked' } }],
      }),
    ).toBe('Accepted');
    expect(localList.entries().map((e) => e.idTag)).toEqual(['B']);
    expect(localList.version).toBe(5);
  });

  it('reads version 0 when the list is empty', () => {
    const localList = new LocalAuthorizationList();
    expect(localList.version).toBe(0);
    expect(localList.apply({ listVersion: 9, updateType: 'Full' })).toBe('Accepted');
    expect(localList.version).toBe(0);
  });

  it('applies Differential updates: add, replace and remove', () => {
    const localList = list(
      [
        ['A', { status: 'Accepted' }],
        ['B', { status: 'Accepted' }],
      ],
      1,
    );
    expect(
      localList.apply({
        listVersion: 2,
        updateType: 'Differential',
        localAuthorizationList: [
          { idTag: 'a', idTagInfo: { status: 'Blocked' } },
          { idTag: 'B' },
          { idTag: 'C', idTagInfo: { status: 'Accepted', parentIdTag: 'FLEET' } },
        ],
      }),
    ).toBe('Accepted');
    expect(localList.get('A')).toEqual({ status: 'Blocked' });
    expect(localList.has('B')).toBe(false);
    expect(localList.get('c')?.parentIdTag).toBe('FLEET');
    expect(localList.version).toBe(2);
  });

  it('answers VersionMismatch to a Differential update that is not newer', () => {
    const localList = list([['A', { status: 'Accepted' }]], 4);
    for (const listVersion of [3, 4]) {
      expect(
        localList.apply({
          listVersion,
          updateType: 'Differential',
          localAuthorizationList: [{ idTag: 'A' }],
        }),
      ).toBe('VersionMismatch');
    }
    expect(localList.has('A')).toBe(true);
  });

  it('fails atomically on invalid or oversized updates', () => {
    const small = new LocalAuthorizationList({ maxLength: 2, maxUpdateLength: 2 });
    const accepted = { status: 'Accepted' } as const;
    expect(
      small.apply({
        listVersion: 1,
        updateType: 'Full',
        localAuthorizationList: [{ idTag: 'A', idTagInfo: accepted }, { idTag: 'B' }],
      }),
    ).toBe('Failed'); // Full needs idTagInfo on every entry
    expect(
      small.apply({
        listVersion: 1,
        updateType: 'Full',
        localAuthorizationList: [
          { idTag: 'A', idTagInfo: accepted },
          { idTag: 'B', idTagInfo: accepted },
          { idTag: 'C', idTagInfo: accepted },
        ],
      }),
    ).toBe('Failed'); // more than SendLocalListMaxLength
    expect(
      small.apply({
        listVersion: 1,
        updateType: 'Full',
        localAuthorizationList: [
          { idTag: 'A', idTagInfo: accepted },
          { idTag: 'a', idTagInfo: accepted },
        ],
      }),
    ).toBe('Failed'); // the same (case-insensitive) idTag twice
    expect(
      small.apply({
        listVersion: 1,
        updateType: 'Full',
        localAuthorizationList: [
          { idTag: 'A', idTagInfo: accepted },
          { idTag: 'B', idTagInfo: accepted },
        ],
      }),
    ).toBe('Accepted');
    expect(
      small.apply({
        listVersion: 2,
        updateType: 'Differential',
        localAuthorizationList: [{ idTag: 'C', idTagInfo: accepted }],
      }),
    ).toBe('Failed'); // beyond LocalAuthListMaxLength
    expect(small.entries().map((e) => e.idTag)).toEqual(['A', 'B']);
    expect(small.version).toBe(1);
  });
});

describe('authorizeIdTag', () => {
  it('online, asks the Central System and caches the answer', async () => {
    const { ctx, askCentralSystem } = context({
      verdict: { kind: 'answered', idTagInfo: { status: 'Accepted', parentIdTag: 'P' } },
    });
    await expect(authorizeIdTag('CARD', ctx)).resolves.toEqual({
      accepted: true,
      idTagInfo: { status: 'Accepted', parentIdTag: 'P' },
      source: 'CentralSystem',
    });
    expect(askCentralSystem).toHaveBeenCalledWith('CARD');
    expect(ctx.cache.get('card', NOW)?.parentIdTag).toBe('P');
  });

  it('never caches idTags that are on the Local Authorization List, and reports conflicts', async () => {
    const { ctx } = context({
      localList: list([['CARD', { status: 'Accepted' }]]),
      verdict: { kind: 'answered', idTagInfo: { status: 'Blocked' } },
    });
    await expect(authorizeIdTag('CARD', ctx)).resolves.toMatchObject({
      accepted: false,
      localListConflict: true,
    });
    expect(ctx.cache.size).toBe(0);
  });

  it('with LocalPreAuthorize starts locally Accepted idTags without asking', async () => {
    const { ctx, askCentralSystem } = context({
      localList: list([
        ['FAST', { status: 'Accepted' }],
        ['SLOW', { status: 'Blocked' }],
      ]),
      rules: { localPreAuthorize: true },
    });
    await expect(authorizeIdTag('fast', ctx)).resolves.toMatchObject({
      accepted: true,
      source: 'LocalList',
    });
    expect(askCentralSystem).not.toHaveBeenCalled();
    // A locally refused idTag is still checked with the Central System.
    await authorizeIdTag('SLOW', ctx);
    expect(askCentralSystem).toHaveBeenCalledOnce();
  });

  it('refuses when the Central System answers with a CALLERROR', async () => {
    const { ctx } = context({
      verdict: { kind: 'error' },
      rules: { allowOfflineTxForUnknownId: true },
    });
    await expect(authorizeIdTag('CARD', ctx)).resolves.toEqual({
      accepted: false,
      source: 'CentralSystemError',
    });
  });

  it('falls back to the offline rules when the Central System is unreachable', async () => {
    const { ctx } = context({
      verdict: { kind: 'unreachable' },
      cache: (() => {
        const cache = new AuthorizationCache();
        cache.update('KNOWN', { status: 'Accepted' });
        return cache;
      })(),
    });
    await expect(authorizeIdTag('KNOWN', ctx)).resolves.toMatchObject({
      accepted: true,
      source: 'Cache',
    });
    await expect(authorizeIdTag('STRANGER', ctx)).resolves.toEqual({
      accepted: false,
      source: 'OfflineUnknown',
    });
  });

  it('offline, applies LocalAuthorizeOffline to local entries and never accepts refused ones', async () => {
    const localList = list([
      ['GOOD', { status: 'Accepted' }],
      ['BLOCKED', { status: 'Blocked' }],
      ['OLD', { status: 'Accepted', expiryDate: past }],
    ]);
    const offline = { online: false, localList, rules: { allowOfflineTxForUnknownId: true } };
    const { ctx, askCentralSystem } = context(offline);
    await expect(authorizeIdTag('GOOD', ctx)).resolves.toMatchObject({ accepted: true });
    await expect(authorizeIdTag('BLOCKED', ctx)).resolves.toMatchObject({ accepted: false });
    await expect(authorizeIdTag('OLD', ctx)).resolves.toMatchObject({
      accepted: false,
      idTagInfo: { status: 'Expired' },
    });
    await expect(authorizeIdTag('NEW', ctx)).resolves.toMatchObject({
      accepted: true,
      source: 'OfflineUnknown',
    });
    expect(askCentralSystem).not.toHaveBeenCalled();

    const strict = context({ ...offline, rules: { localAuthorizeOffline: false } }).ctx;
    await expect(authorizeIdTag('GOOD', strict)).resolves.toMatchObject({ accepted: false });
  });

  it('gives the Local Authorization List priority over the cache', async () => {
    const cache = new AuthorizationCache();
    cache.update('CARD', { status: 'Accepted' });
    const { ctx } = context({
      online: false,
      localList: list([['CARD', { status: 'Blocked' }]]),
      cache,
    });
    await expect(authorizeIdTag('CARD', ctx)).resolves.toMatchObject({
      accepted: false,
      source: 'LocalList',
    });
    const withoutList = context({
      online: false,
      localList: list([['CARD', { status: 'Blocked' }]]),
      cache,
      rules: { localAuthListEnabled: false },
    }).ctx;
    await expect(authorizeIdTag('CARD', withoutList)).resolves.toMatchObject({
      accepted: true,
      source: 'Cache',
    });
  });

  it('ignores a disabled cache', async () => {
    const cache = new AuthorizationCache();
    cache.update('CARD', { status: 'Accepted' });
    const { ctx } = context({ online: false, cache, rules: { authorizationCacheEnabled: false } });
    await expect(authorizeIdTag('CARD', ctx)).resolves.toMatchObject({ source: 'OfflineUnknown' });
  });
});

describe('sameGroup', () => {
  it('matches equal idTags or equal parents, case-insensitively', () => {
    expect(sameGroup({ idTag: 'a' }, { idTag: 'A' })).toBe(true);
    expect(
      sameGroup({ idTag: 'A', parentIdTag: 'fleet' }, { idTag: 'B', parentIdTag: 'FLEET' }),
    ).toBe(true);
    expect(sameGroup({ idTag: 'A', parentIdTag: 'X' }, { idTag: 'B', parentIdTag: 'Y' })).toBe(
      false,
    );
    expect(sameGroup({ idTag: 'A' }, { idTag: 'B' })).toBe(false);
  });
});

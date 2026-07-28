/**
 * OCPP 2.0.1 authorization of a simulated station: the Authorization Cache (C10), the Local
 * Authorization List (D01, D02) and the decision of whether an idToken may charge (C01, C12 and
 * the AuthCtrlr variables). Compared with 1.6, an idToken is identified by its value together
 * with its type, and group membership uses `groupIdToken`.
 */
import type { v201 } from '../../messages/index.js';

/** Map key of an idToken: its type and its value, case-insensitively. */
export function idTokenKey(token: Pick<v201.IdToken, 'idToken' | 'type'>): string {
  return `${token.type}:${token.idToken.toLowerCase()}`;
}

/** Whether two idTokens are the same (type and case-insensitive value). */
export function sameIdToken(
  a: Pick<v201.IdToken, 'idToken' | 'type'>,
  b: Pick<v201.IdToken, 'idToken' | 'type'>,
): boolean {
  return idTokenKey(a) === idTokenKey(b);
}

/**
 * Whether two idTokens may stand in for each other, e.g. to stop a transaction another card
 * started: the same token, or both with the same `groupIdToken`.
 */
export function sameIdTokenGroup(
  a: { readonly token: v201.IdToken; readonly group?: v201.IdToken | undefined },
  b: { readonly token: v201.IdToken; readonly group?: v201.IdToken | undefined },
): boolean {
  if (sameIdToken(a.token, b.token)) return true;
  return a.group !== undefined && b.group !== undefined && sameIdToken(a.group, b.group);
}

interface CacheEntry {
  readonly token: v201.IdToken;
  readonly info: v201.IdTokenInfo;
  /** After this instant the entry is no longer used. */
  readonly expiresAt: number;
}

/**
 * The Authorization Cache: the latest IdTokenInfo the CSMS sent for each idToken. An entry is
 * dropped after its `cacheExpiryDateTime` or, without one, after `AuthCacheCtrlr.LifeTime`
 * seconds. Entries are kept in least-recently-used order; a full cache evicts a non-Accepted
 * entry first, then the least recently used one.
 */
export class IdTokenCache {
  readonly #capacity: number;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(capacity = 1_000) {
    this.#capacity = capacity;
  }

  /** Number of cached idTokens (including expired ones not looked up since). */
  get size(): number {
    return this.#entries.size;
  }

  /** The cached info, or `undefined` when unknown or expired. */
  get(token: v201.IdToken, now = new Date()): v201.IdTokenInfo | undefined {
    const key = idTokenKey(token);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (entry.expiresAt <= now.getTime()) return undefined;
    this.#entries.set(key, entry);
    return entry.info;
  }

  /** Store what the CSMS said; `lifetimeS` applies when the info has no cacheExpiryDateTime. */
  update(token: v201.IdToken, info: v201.IdTokenInfo, lifetimeS: number, now = new Date()): void {
    const key = idTokenKey(token);
    this.#entries.delete(key);
    if (this.#entries.size >= this.#capacity) this.#evict();
    const expiresAt =
      info.cacheExpiryDateTime === undefined
        ? now.getTime() + lifetimeS * 1_000
        : new Date(info.cacheExpiryDateTime).getTime();
    this.#entries.set(key, { token, info, expiresAt });
  }

  /** Empty the cache (ClearCache). */
  clear(): void {
    this.#entries.clear();
  }

  #evict(): void {
    let victim: string | undefined;
    for (const [key, entry] of this.#entries) {
      victim ??= key;
      if (entry.info.status !== 'Accepted') {
        victim = key;
        break;
      }
    }
    if (victim !== undefined) this.#entries.delete(victim);
  }
}

/**
 * The Local Authorization List, maintained by the CSMS with SendLocalList:
 *
 * - `Full` replaces the list; every entry must carry idTokenInfo.
 * - `Differential` adds or replaces entries with idTokenInfo and removes entries without it; its
 *   `versionNumber` must be newer than the installed one (`VersionMismatch` otherwise).
 * - An update that lists an idToken twice, carries more than `ItemsPerMessage` entries or would
 *   exceed the capacity fails as a whole (`Failed`).
 * - GetLocalListVersion reads 0 while the list is empty.
 */
export class IdTokenLocalList {
  readonly #capacity: number;
  readonly #itemsPerMessage: () => number;
  #entries = new Map<string, v201.AuthorizationData>();
  #version = 0;

  constructor(
    options: { readonly capacity?: number; readonly itemsPerMessage?: () => number } = {},
  ) {
    this.#capacity = options.capacity ?? 1_000;
    this.#itemsPerMessage = options.itemsPerMessage ?? (() => 250);
  }

  /** The versionNumber of GetLocalListVersionResponse. */
  get version(): number {
    return this.#entries.size === 0 ? 0 : this.#version;
  }

  /** Number of entries. */
  get size(): number {
    return this.#entries.size;
  }

  /** The info of a listed idToken. */
  get(token: v201.IdToken): v201.IdTokenInfo | undefined {
    return this.#entries.get(idTokenKey(token))?.idTokenInfo;
  }

  /** Whether an idToken is listed. */
  has(token: v201.IdToken): boolean {
    return this.#entries.has(idTokenKey(token));
  }

  /** Apply SendLocalListRequest atomically. */
  apply(request: v201.SendLocalListRequest): v201.SendLocalListStatus {
    const updates = request.localAuthorizationList ?? [];
    if (updates.length > this.#itemsPerMessage()) return 'Failed';
    const keys = updates.map((entry) => idTokenKey(entry.idToken));
    if (new Set(keys).size !== keys.length) return 'Failed';
    let next: Map<string, v201.AuthorizationData>;
    if (request.updateType === 'Full') {
      if (updates.some((entry) => entry.idTokenInfo === undefined)) return 'Failed';
      next = new Map();
    } else {
      if (request.versionNumber <= this.#version) return 'VersionMismatch';
      next = new Map(this.#entries);
    }
    for (const entry of updates) {
      const key = idTokenKey(entry.idToken);
      if (entry.idTokenInfo) next.set(key, entry);
      else next.delete(key);
    }
    if (next.size > this.#capacity) return 'Failed';
    this.#entries = next;
    this.#version = request.versionNumber;
    return 'Accepted';
  }
}

/** The AuthCtrlr, AuthCacheCtrlr and LocalAuthListCtrlr settings that decide. */
export interface IdTokenPolicy {
  readonly authorizationEnabled: boolean;
  readonly localListEnabled: boolean;
  readonly cacheEnabled: boolean;
  readonly localPreAuthorize: boolean;
  readonly localAuthorizeOffline: boolean;
  readonly offlineTxForUnknownId: boolean;
  /** AuthCacheCtrlr.LifeTime, for cache entries without cacheExpiryDateTime. */
  readonly cacheLifetimeS: number;
}

/** Where a decision came from. */
export type IdTokenSource =
  'LocalList' | 'Cache' | 'Csms' | 'CsmsError' | 'OfflineUnknown' | 'Disabled';

/** Outcome of {@link authorizeIdToken}. */
export interface IdTokenDecision {
  readonly accepted: boolean;
  readonly idTokenInfo?: v201.IdTokenInfo;
  readonly source: IdTokenSource;
}

/** What the CSMS answered to an AuthorizeRequest, as seen by the station. */
export type CsmsVerdict =
  | { readonly kind: 'answered'; readonly idTokenInfo: v201.IdTokenInfo }
  | { readonly kind: 'error' }
  | { readonly kind: 'unreachable' };

/**
 * Decide whether an idToken may charge:
 *
 * 1. With `AuthCtrlr.Enabled` false, or a `NoAuthorization` token, everything is accepted.
 * 2. Local knowledge: the Local Authorization List (when enabled) before the cache (when enabled).
 * 3. Online, a locally Accepted token starts at once with `LocalPreAuthorize`; otherwise the
 *    CSMS is asked, its answer decides and is cached (tokens on the local list are not cached),
 *    and a CALLERROR refuses.
 * 4. Offline: a locally known token is accepted only when Accepted and `LocalAuthorizeOffline`
 *    is set; an unknown one only with `OfflineTxForUnknownIdEnabled`.
 */
export async function authorizeIdToken(
  token: v201.IdToken,
  context: {
    readonly online: boolean;
    readonly policy: IdTokenPolicy;
    readonly localList: IdTokenLocalList;
    readonly cache: IdTokenCache;
    readonly askCsms: (token: v201.IdToken) => Promise<CsmsVerdict>;
    readonly now?: Date;
  },
): Promise<IdTokenDecision> {
  const { policy, localList, cache } = context;
  const now = context.now ?? new Date();
  if (!policy.authorizationEnabled || token.type === 'NoAuthorization') {
    return { accepted: true, source: 'Disabled' };
  }
  const listed = policy.localListEnabled ? localList.get(token) : undefined;
  const cached = listed === undefined && policy.cacheEnabled ? cache.get(token, now) : undefined;
  const local = listed
    ? { info: listed, source: 'LocalList' as const }
    : cached
      ? { info: cached, source: 'Cache' as const }
      : undefined;
  if (context.online) {
    if (policy.localPreAuthorize && local?.info.status === 'Accepted') {
      return { accepted: true, idTokenInfo: local.info, source: local.source };
    }
    const verdict = await context.askCsms(token);
    if (verdict.kind === 'answered') {
      if (!localList.has(token) && policy.cacheEnabled) {
        cache.update(token, verdict.idTokenInfo, policy.cacheLifetimeS, now);
      }
      return {
        accepted: verdict.idTokenInfo.status === 'Accepted',
        idTokenInfo: verdict.idTokenInfo,
        source: 'Csms',
      };
    }
    if (verdict.kind === 'error') return { accepted: false, source: 'CsmsError' };
  }
  if (local) {
    return {
      accepted: local.info.status === 'Accepted' && policy.localAuthorizeOffline,
      idTokenInfo: local.info,
      source: local.source,
    };
  }
  return { accepted: policy.offlineTxForUnknownId, source: 'OfflineUnknown' };
}

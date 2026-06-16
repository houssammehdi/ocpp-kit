import {
  ciEquals,
  ciKey,
  type AuthorizationData,
  type IdTagInfo,
  type SendLocalListRequest,
  type UpdateStatus,
} from '../messages/index.js';

/** An idTag with its authorization info. */
export interface AuthorizationEntry {
  readonly idTag: string;
  readonly idTagInfo: IdTagInfo;
}

/**
 * `idTagInfo` as it applies at `now`: an entry whose expiryDate has passed counts as Expired
 * ("Identifiers that were valid but are apparently expired due to passage of time MUST also be
 * rejected", OCPP 1.6, Unknown Offline Authorization).
 */
export function effectiveInfo(info: IdTagInfo, now: Date): IdTagInfo {
  if (info.status === 'Accepted' && info.expiryDate && new Date(info.expiryDate) <= now) {
    return { ...info, status: 'Expired' };
  }
  return info;
}

/** Options of {@link AuthorizationCache}. */
export interface AuthorizationCacheOptions {
  /** Maximum number of entries. Default: 1 000. */
  readonly capacity?: number;
}

/**
 * The Authorization Cache of OCPP 1.6 (Local Authorization & Offline Behavior): the latest
 * IdTagInfo received for each idTag from Authorize.conf, StartTransaction.conf and
 * StopTransaction.conf.
 *
 * Entries are kept in least-recently-used order. When the cache is full, an entry that is not
 * Accepted goes first (it only serves to refuse a card offline), then the least recently used
 * Accepted one. Keys are CiStrings, so lookups ignore case.
 */
export class AuthorizationCache {
  readonly #capacity: number;
  readonly #entries = new Map<string, AuthorizationEntry>();

  constructor(options: AuthorizationCacheOptions = {}) {
    this.#capacity = options.capacity ?? 1_000;
  }

  /** Number of cached idTags. */
  get size(): number {
    return this.#entries.size;
  }

  /** The cached info for `idTag`, with expired entries changed to Expired. */
  get(idTag: string, now = new Date()): IdTagInfo | undefined {
    const key = ciKey(idTag);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    const info = effectiveInfo(entry.idTagInfo, now);
    // Move to the most recently used position; store the Expired status if it changed.
    this.#entries.delete(key);
    this.#entries.set(
      key,
      info === entry.idTagInfo ? entry : { idTag: entry.idTag, idTagInfo: info },
    );
    return info;
  }

  /** Store the latest info received for `idTag`. */
  update(idTag: string, idTagInfo: IdTagInfo): void {
    const key = ciKey(idTag);
    this.#entries.delete(key);
    if (this.#entries.size >= this.#capacity) this.#evict();
    this.#entries.set(key, { idTag, idTagInfo });
  }

  /** Empty the cache (ClearCache). */
  clear(): void {
    this.#entries.clear();
  }

  /** Snapshot of the entries, least recently used first. */
  entries(): AuthorizationEntry[] {
    return [...this.#entries.values()];
  }

  #evict(): void {
    let victim: string | undefined;
    for (const [key, entry] of this.#entries) {
      victim ??= key;
      if (entry.idTagInfo.status !== 'Accepted') {
        victim = key;
        break;
      }
    }
    if (victim !== undefined) this.#entries.delete(victim);
  }
}

/** Options of {@link LocalAuthorizationList}. */
export interface LocalAuthorizationListOptions {
  /** `LocalAuthListMaxLength`: entries the list can hold. Default: 1 000. */
  readonly maxLength?: number;
  /** `SendLocalListMaxLength`: entries one SendLocalList may carry. Default: 250. */
  readonly maxUpdateLength?: number;
}

/**
 * The Local Authorization List of OCPP 1.6 (Local Authorization & Offline Behavior, and section
 * 5.15 Send Local List), maintained by the Central System with SendLocalList.
 *
 * - A Full update replaces the list; every entry must carry idTagInfo.
 * - A Differential update adds or replaces entries with idTagInfo and removes entries without
 *   it. Its `listVersion` must be newer than the installed one, otherwise the answer is
 *   `VersionMismatch` and nothing changes.
 * - An update that exceeds `SendLocalListMaxLength` or would exceed `LocalAuthListMaxLength`, or
 *   lists the same idTag twice (idTags are case-insensitive), fails as a whole: `Failed`.
 * - The version of an empty list reads 0, as GetLocalListVersion requires.
 */
export class LocalAuthorizationList {
  readonly #maxLength: number;
  readonly #maxUpdateLength: number;
  #entries = new Map<string, AuthorizationEntry>();
  #version = 0;

  constructor(options: LocalAuthorizationListOptions = {}) {
    this.#maxLength = options.maxLength ?? 1_000;
    this.#maxUpdateLength = options.maxUpdateLength ?? 250;
  }

  /** Version for GetLocalListVersion: 0 when the list is empty. */
  get version(): number {
    return this.#entries.size === 0 ? 0 : this.#version;
  }

  /** Number of entries. */
  get size(): number {
    return this.#entries.size;
  }

  /** Whether `idTag` has an entry. */
  has(idTag: string): boolean {
    return this.#entries.has(ciKey(idTag));
  }

  /** The info for `idTag`, if listed. */
  get(idTag: string): IdTagInfo | undefined {
    return this.#entries.get(ciKey(idTag))?.idTagInfo;
  }

  /** Snapshot of all entries. */
  entries(): AuthorizationEntry[] {
    return [...this.#entries.values()];
  }

  /** Apply a SendLocalList request atomically. */
  apply(request: SendLocalListRequest): UpdateStatus {
    const updates: readonly AuthorizationData[] = request.localAuthorizationList ?? [];
    if (updates.length > this.#maxUpdateLength) return 'Failed';
    const seen = new Set<string>();
    for (const { idTag } of updates) {
      const key = ciKey(idTag);
      if (seen.has(key)) return 'Failed';
      seen.add(key);
    }
    let next: Map<string, AuthorizationEntry>;
    if (request.updateType === 'Full') {
      if (updates.some((entry) => entry.idTagInfo === undefined)) return 'Failed';
      next = new Map();
    } else {
      if (request.listVersion <= this.#version) return 'VersionMismatch';
      next = new Map(this.#entries);
    }
    for (const { idTag, idTagInfo } of updates) {
      if (idTagInfo) next.set(ciKey(idTag), { idTag, idTagInfo });
      else next.delete(ciKey(idTag));
    }
    if (next.size > this.#maxLength) return 'Failed';
    this.#entries = next;
    this.#version = request.listVersion;
    return 'Accepted';
  }
}

/** The authorization-related configuration keys. */
export interface AuthorizationPolicy {
  /** `LocalAuthListEnabled`. */
  readonly localAuthListEnabled: boolean;
  /** `AuthorizationCacheEnabled`. */
  readonly authorizationCacheEnabled: boolean;
  /** `LocalPreAuthorize`: online, start at once for locally Accepted idTags. */
  readonly localPreAuthorize: boolean;
  /** `LocalAuthorizeOffline`: offline, start for locally Accepted idTags. */
  readonly localAuthorizeOffline: boolean;
  /** `AllowOfflineTxForUnknownId`: offline, start for idTags that are not known locally. */
  readonly allowOfflineTxForUnknownId: boolean;
}

/** What the Central System said about an idTag, as seen by the charge point. */
export type CentralSystemVerdict =
  | { readonly kind: 'answered'; readonly idTagInfo: IdTagInfo }
  /** A CALLERROR: the Central System was reached but did not authorize. */
  | { readonly kind: 'error' }
  /** No answer (offline, timeout, lost connection). */
  | { readonly kind: 'unreachable' };

/** Where an authorization decision came from. */
export type AuthorizationSource =
  'LocalList' | 'Cache' | 'CentralSystem' | 'OfflineUnknown' | 'CentralSystemError';

/** Outcome of {@link authorizeIdTag}. */
export interface AuthorizationDecision {
  readonly accepted: boolean;
  /** The info the decision was based on, when there was one. */
  readonly idTagInfo?: IdTagInfo;
  readonly source: AuthorizationSource;
  /**
   * Set when the Central System answered differently from the Local Authorization List entry,
   * which the charge point reports as a `LocalListConflict`.
   */
  readonly localListConflict?: boolean;
}

/** Everything {@link authorizeIdTag} needs. */
export interface AuthorizationContext {
  /** Whether the charge point may send Authorize (connected and registered). */
  readonly online: boolean;
  readonly policy: AuthorizationPolicy;
  readonly localList: LocalAuthorizationList;
  readonly cache: AuthorizationCache;
  /** Send Authorize.req. Only called when `online`. */
  readonly askCentralSystem: (idTag: string) => Promise<CentralSystemVerdict>;
  readonly now?: Date;
}

/**
 * Decide whether an idTag may charge, following OCPP 1.6 Local Authorization & Offline Behavior
 * and section 4.1 Authorize:
 *
 * 1. Local knowledge: the Local Authorization List (when enabled) has priority over the
 *    Authorization Cache (when enabled); expired entries count as Expired.
 * 2. Online, a locally Accepted idTag starts at once when `LocalPreAuthorize` is set. Otherwise
 *    Authorize.req is sent; its answer decides and updates the cache (but idTags on the Local
 *    Authorization List are never cached). A CALLERROR answer refuses the idTag.
 * 3. Offline, or when Authorize gets no answer: a locally known idTag is accepted only if it is
 *    Accepted and `LocalAuthorizeOffline` is set (a locally known Invalid, Blocked or Expired
 *    idTag is always refused); an unknown idTag only if `AllowOfflineTxForUnknownId` is set.
 */
export async function authorizeIdTag(
  idTag: string,
  context: AuthorizationContext,
): Promise<AuthorizationDecision> {
  const { policy, localList, cache } = context;
  const now = context.now ?? new Date();
  const listed = policy.localAuthListEnabled ? localList.get(idTag) : undefined;
  const cached =
    listed === undefined && policy.authorizationCacheEnabled ? cache.get(idTag, now) : undefined;
  const local: { info: IdTagInfo; source: AuthorizationSource } | undefined = listed
    ? { info: effectiveInfo(listed, now), source: 'LocalList' }
    : cached
      ? { info: cached, source: 'Cache' }
      : undefined;

  if (context.online) {
    if (policy.localPreAuthorize && local?.info.status === 'Accepted') {
      return { accepted: true, idTagInfo: local.info, source: local.source };
    }
    const verdict = await context.askCentralSystem(idTag);
    if (verdict.kind === 'answered') {
      const { idTagInfo } = verdict;
      const onList = localList.has(idTag);
      if (!onList && policy.authorizationCacheEnabled) cache.update(idTag, idTagInfo);
      const conflict =
        onList && listed !== undefined && effectiveInfo(listed, now).status !== idTagInfo.status;
      return {
        accepted: idTagInfo.status === 'Accepted',
        idTagInfo,
        source: 'CentralSystem',
        ...(conflict ? { localListConflict: true } : {}),
      };
    }
    if (verdict.kind === 'error') return { accepted: false, source: 'CentralSystemError' };
  }

  if (local) {
    return {
      accepted: local.info.status === 'Accepted' && policy.localAuthorizeOffline,
      idTagInfo: local.info,
      source: local.source,
    };
  }
  return { accepted: policy.allowOfflineTxForUnknownId, source: 'OfflineUnknown' };
}

/**
 * Whether two idTags belong to the same group: equal (case-insensitively), or both with the same
 * parentIdTag.
 */
export function sameGroup(
  a: { readonly idTag: string; readonly parentIdTag?: string | undefined },
  b: { readonly idTag: string; readonly parentIdTag?: string | undefined },
): boolean {
  if (ciEquals(a.idTag, b.idTag)) return true;
  return (
    a.parentIdTag !== undefined &&
    b.parentIdTag !== undefined &&
    ciEquals(a.parentIdTag, b.parentIdTag)
  );
}

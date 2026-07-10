import { OcppKitError } from '../rpc/errors.js';

/** Connector statuses modelled by the simulator: every OCPP 1.6 ChargePointStatus. */
export type ConnectorStatus =
  | 'Available'
  | 'Preparing'
  | 'Charging'
  | 'SuspendedEV'
  | 'SuspendedEVSE'
  | 'Finishing'
  | 'Reserved'
  | 'Faulted'
  | 'Unavailable';

/** Physical or logical events that drive a connector's status. */
export type ConnectorEvent =
  /** Cable plugged into an EV. */
  | 'plugIn'
  /** Cable removed. */
  | 'unplug'
  /**
   * User authorized (local swipe or remote start) before plugging in, or the reserved idTag was
   * presented at a reserved connector.
   */
  | 'authorize'
  /** Preparing for longer than ConnectionTimeOut without a transaction. */
  | 'timeout'
  /** Energy transfer (re)starts. */
  | 'energyFlowing'
  /** The EV stops accepting energy (e.g. battery full). */
  | 'suspendByEV'
  /** The EVSE offers no energy (e.g. charging profile limit of 0). */
  | 'suspendByEVSE'
  /**
   * The cable was pulled out of the EV but the transaction continues
   * (`StopTransactionOnEVSideDisconnect` is false).
   */
  | 'evDisconnected'
  /** The transaction ended while the cable is still plugged in. */
  | 'transactionStopped'
  /** ReserveNow was accepted for this connector. */
  | 'reserve'
  /** The reservation expired or was cancelled. */
  | 'reservationEnded'
  | 'fault'
  | 'faultCleared'
  | 'makeUnavailable'
  | 'makeAvailable';

/** For every event, the status each status moves to; statuses not listed refuse the event. */
export type TransitionTable = Readonly<
  Record<ConnectorEvent, Readonly<Partial<Record<ConnectorStatus, ConnectorStatus>>>>
>;

const ACTIVE = ['Charging', 'SuspendedEV', 'SuspendedEVSE'] as const;
const OPERATIONAL: readonly ConnectorStatus[] = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
  'Unavailable',
];

function from(states: readonly ConnectorStatus[], to: ConnectorStatus) {
  return Object.fromEntries(states.map((state) => [state, to])) as Partial<
    Record<ConnectorStatus, ConnectorStatus>
  >;
}

/**
 * Allowed transitions, following the status transition table of the OCPP 1.6 specification
 * (section 4.9). Anything not listed is rejected with {@link InvalidTransitionError}.
 */
export const CONNECTOR_TRANSITIONS: TransitionTable = {
  plugIn: { Available: 'Preparing' },
  authorize: { Available: 'Preparing', Reserved: 'Preparing' },
  timeout: { Preparing: 'Available' },
  unplug: from(['Preparing', 'Finishing', ...ACTIVE], 'Available'),
  energyFlowing: from(['Preparing', 'SuspendedEV', 'SuspendedEVSE'], 'Charging'),
  suspendByEV: from(['Preparing', 'Charging', 'SuspendedEVSE'], 'SuspendedEV'),
  suspendByEVSE: from(['Preparing', 'Charging', 'SuspendedEV'], 'SuspendedEVSE'),
  evDisconnected: from(ACTIVE, 'SuspendedEV'),
  transactionStopped: from(['Preparing', ...ACTIVE], 'Finishing'),
  reserve: { Available: 'Reserved' },
  reservationEnded: { Reserved: 'Available' },
  fault: from(OPERATIONAL, 'Faulted'),
  faultCleared: { Faulted: 'Available' },
  makeUnavailable: from(
    ['Available', 'Preparing', 'Finishing', 'Reserved', 'Faulted'],
    'Unavailable',
  ),
  makeAvailable: { Unavailable: 'Available' },
};

/** Status reached from `state` on `event`, or `undefined` when the transition is not allowed. */
export function nextStatus(
  state: ConnectorStatus,
  event: ConnectorEvent,
): ConnectorStatus | undefined {
  return CONNECTOR_TRANSITIONS[event][state];
}

/** A transition that the state machine does not allow. */
export class InvalidTransitionError extends OcppKitError {
  constructor(
    readonly state: ConnectorStatus,
    readonly event: ConnectorEvent,
  ) {
    super(`Event "${event}" is not allowed in state ${state}`);
  }
}

/** Listener invoked after every status change. */
export type TransitionListener = (
  to: ConnectorStatus,
  from: ConnectorStatus,
  event: ConnectorEvent,
) => void;

/** Finite state machine of a single connector. */
export class ConnectorStateMachine {
  #status: ConnectorStatus;
  readonly #listeners: TransitionListener[] = [];

  constructor(initial: ConnectorStatus = 'Available') {
    this.#status = initial;
  }

  /** Current status. */
  get status(): ConnectorStatus {
    return this.#status;
  }

  /** Whether `event` is allowed in the current status. */
  can(event: ConnectorEvent): boolean {
    return nextStatus(this.#status, event) !== undefined;
  }

  /** Apply `event`; throws {@link InvalidTransitionError} if it is not allowed. */
  apply(event: ConnectorEvent): ConnectorStatus {
    const to = nextStatus(this.#status, event);
    if (to === undefined) throw new InvalidTransitionError(this.#status, event);
    const previous = this.#status;
    this.#status = to;
    if (to !== previous) for (const listener of this.#listeners) listener(to, previous, event);
    return to;
  }

  /** Apply `event` if allowed; returns whether it was applied. */
  tryApply(event: ConnectorEvent): boolean {
    if (!this.can(event)) return false;
    this.apply(event);
    return true;
  }

  /** Subscribe to status changes. */
  onChange(listener: TransitionListener): void {
    this.#listeners.push(listener);
  }
}

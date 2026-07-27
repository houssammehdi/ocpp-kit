import {
  ChargePointToCentralSystem,
  CentralSystemToChargePoint,
  ChargingStationToCsms,
  CsmsToChargingStation,
} from '../messages/index.js';
import {
  CallAbortedError,
  CallTimeoutError,
  ConnectionClosedError,
  RpcError,
} from '../rpc/errors.js';
import type { CentralSystem, CentralSystemEvents } from '../server/central-system.js';
import type { AnyConnection } from '../server/connection.js';
import type { OcppSubprotocol } from '../transport/websocket.js';
import { DEFAULT_LATENCY_BUCKETS, MetricsRegistry } from './metrics.js';

/** Options of {@link instrumentCentralSystem}. */
export interface CentralSystemMetricsOptions {
  /** Registry to add the metrics to. Default: a new one. */
  readonly registry?: MetricsRegistry;
  /** Prefix of every metric name. Default: `ocpp_`. */
  readonly prefix?: string;
  /** Latency histogram bucket bounds in seconds. Default: 1 ms to 30 s. */
  readonly buckets?: readonly number[];
}

/** The metrics a {@link CentralSystem} is instrumented with. */
export interface CentralSystemMetrics {
  readonly registry: MetricsRegistry;
  /** Prometheus text exposition of the registry. */
  render(): string;
  /** Stop updating the metrics (they keep their values). */
  dispose(): void;
}

/** Events of a Central System accepting either version. */
type Events = CentralSystemEvents<AnyConnection>;

/** Action label: names outside the catalogue collapse into one value, bounding cardinality. */
function actionLabel(action: string, catalogue: object): string {
  return Object.hasOwn(catalogue, action) ? action : 'unknown';
}

/** Result label of a CALL the Central System sent. */
function outboundResult(error: Error | undefined): string {
  if (error === undefined) return 'ok';
  if (error instanceof CallTimeoutError) return 'timeout';
  if (error instanceof ConnectionClosedError) return 'closed';
  if (error instanceof CallAbortedError) return 'aborted';
  if (error instanceof RpcError) return error.remote ? error.code : 'invalid_response';
  return 'error';
}

/**
 * Keep Prometheus-style metrics of a Central System:
 *
 * - `ocpp_connected_charge_points` (gauge) and `ocpp_connections_total`,
 *   `ocpp_disconnections_total`, `ocpp_rejected_connections_total{reason}` (counters);
 * - `ocpp_inbound_calls_total{action,result}` and the handler time histogram
 *   `ocpp_inbound_call_duration_seconds{action}` for CALLs from charge points, where `result` is
 *   `ok` or the CALLERROR code;
 * - `ocpp_outbound_calls_total{action,result}` and the round-trip histogram
 *   `ocpp_outbound_call_duration_seconds{action}` for CALLs to charge points, where `result` is
 *   `ok`, `timeout`, `closed`, `aborted`, `invalid_response` or the CALLERROR code;
 * - `ocpp_bad_messages_total{code}` for frames that were not valid OCPP-J.
 *
 * Action names outside the catalogue of the connection's OCPP version are counted as `unknown`,
 * so a misbehaving client cannot create unbounded label values.
 *
 * ```ts
 * const metrics = instrumentCentralSystem(cs);
 * http.createServer((req, res) => res.end(metrics.render())).listen(9464);
 * ```
 */
export function instrumentCentralSystem<P extends OcppSubprotocol>(
  server: CentralSystem<P>,
  options: CentralSystemMetricsOptions = {},
): CentralSystemMetrics {
  // Listeners are written for connections of either version.
  const cs = server as unknown as CentralSystem<OcppSubprotocol>;
  const registry = options.registry ?? new MetricsRegistry();
  const prefix = options.prefix ?? 'ocpp_';
  const buckets = options.buckets ?? DEFAULT_LATENCY_BUCKETS;
  const connected = registry.gauge(
    `${prefix}connected_charge_points`,
    'Charge points currently connected',
  );
  const connections = registry.counter(
    `${prefix}connections_total`,
    'WebSocket connections accepted',
  );
  const disconnections = registry.counter(
    `${prefix}disconnections_total`,
    'WebSocket connections closed',
  );
  const rejected = registry.counter(
    `${prefix}rejected_connections_total`,
    'Connection attempts refused, by reason',
    ['reason'],
  );
  const inboundCalls = registry.counter(
    `${prefix}inbound_calls_total`,
    'CALLs from charge points answered, by action and result',
    ['action', 'result'],
  );
  const inboundDuration = registry.histogram(
    `${prefix}inbound_call_duration_seconds`,
    'Time to answer CALLs from charge points',
    ['action'],
    buckets,
  );
  const outboundCalls = registry.counter(
    `${prefix}outbound_calls_total`,
    'CALLs to charge points settled, by action and result',
    ['action', 'result'],
  );
  const outboundDuration = registry.histogram(
    `${prefix}outbound_call_duration_seconds`,
    'Round-trip time of CALLs to charge points',
    ['action'],
    buckets,
  );
  const badMessages = registry.counter(
    `${prefix}bad_messages_total`,
    'Frames from charge points that were not valid OCPP-J, by error code',
    ['code'],
  );
  connected.set(cs.connections.size);

  const onConnect = (): void => {
    connections.inc();
    connected.set(cs.connections.size);
  };
  const onDisconnect = (): void => {
    disconnections.inc();
    connected.set(cs.connections.size);
  };
  const onRejected: Events['rejected'] = ({ reason }) => {
    rejected.inc({ reason });
  };
  const onCall: Events['call'] = (event) => {
    const action = actionLabel(
      event.action,
      event.connection.version === '2.0.1' ? ChargingStationToCsms : ChargePointToCentralSystem,
    );
    inboundCalls.inc({ action, result: event.error ? event.error.code : 'ok' });
    inboundDuration.observe({ action }, event.durationMs / 1_000);
  };
  const onCallCompleted: Events['callCompleted'] = (event) => {
    const action = actionLabel(
      event.action,
      event.connection.version === '2.0.1' ? CsmsToChargingStation : CentralSystemToChargePoint,
    );
    outboundCalls.inc({ action, result: outboundResult(event.error) });
    outboundDuration.observe({ action }, event.durationMs / 1_000);
  };
  const onBadMessage: Events['badMessage'] = (_connection, _raw, error) => {
    badMessages.inc({ code: error.code });
  };
  cs.on('connect', onConnect);
  cs.on('disconnect', onDisconnect);
  cs.on('rejected', onRejected);
  cs.on('call', onCall);
  cs.on('callCompleted', onCallCompleted);
  cs.on('badMessage', onBadMessage);
  return {
    registry,
    render: () => registry.render(),
    dispose: () => {
      cs.off('connect', onConnect);
      cs.off('disconnect', onDisconnect);
      cs.off('rejected', onRejected);
      cs.off('call', onCall);
      cs.off('callCompleted', onCallCompleted);
      cs.off('badMessage', onBadMessage);
    },
  };
}

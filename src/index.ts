/**
 * ocpp-kit: a type-safe OCPP 1.6-J toolkit.
 *
 * - `rpc`: transport-agnostic framing, validation and the {@link RpcPeer}
 * - `messages`: typed schemas and action maps for OCPP 1.6
 * - `server`: {@link CentralSystem} WebSocket server
 * - `client`: {@link ChargePoint} client with reconnect and an offline queue
 * - `simulator`: virtual chargers and fleets for load testing
 * - `conformance`: checks a Central System against the specification ({@link runConformance})
 * - `observability`: Prometheus metrics ({@link instrumentCentralSystem}) and structured logs
 *
 * @packageDocumentation
 */
export * from './rpc/index.js';
export * from './messages/index.js';
export * from './transport/websocket.js';
export * from './server/index.js';
export * from './client/index.js';
export { TypedEventEmitter, type EventMap } from './util/typed-emitter.js';
export * from './simulator/index.js';
export * from './conformance/index.js';
export * from './observability/index.js';
export { VERSION } from './version.js';

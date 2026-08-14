/**
 * One Central System for OCPP 1.6 and 2.0.1 on the same port, with a simulated charger of each
 * version. The 2.0.1 station is remote-started, charges under a 7.4 kW limit and is stopped.
 * Self-contained; stops after about 15 seconds.
 *
 *   npm run example:multi-version
 */
import {
  CentralSystem,
  SimulatedCharger,
  SimulatedChargingStation,
  type OcppSubprotocol,
} from '../src/index.js';

const now = (): string => new Date().toISOString();
const cs = new CentralSystem<OcppSubprotocol>({ protocols: ['ocpp2.0.1', 'ocpp1.6'] });

cs.on('connect', (connection) => {
  console.log(`${connection.identity} connected with OCPP ${connection.version}`);
});

// OCPP 1.6: cs.handle() (typed with the 1.6 catalogue).
cs.handle('BootNotification', () => ({ status: 'Accepted', currentTime: now(), interval: 60 }));
cs.handle('Heartbeat', () => ({ currentTime: now() }));
cs.handle('StatusNotification', () => ({}));

// OCPP 2.0.1: cs.v201.handle() (typed with the 2.0.1 catalogue).
cs.v201
  .handle('BootNotification', ({ chargingStation, reason }) => {
    console.log(`a ${chargingStation.vendorName} ${chargingStation.model} booted (${reason})`);
    return { status: 'Accepted', currentTime: now(), interval: 60 };
  })
  .handle('Heartbeat', () => ({ currentTime: now() }))
  .handle('StatusNotification', ({ evseId, connectorStatus }, { connection }) => {
    console.log(`${connection.identity} EVSE ${evseId}: ${connectorStatus}`);
    return {};
  })
  .handle('SecurityEventNotification', () => ({}))
  .handle(
    'TransactionEvent',
    ({ eventType, triggerReason, seqNo, transactionInfo, meterValue }) => {
      const energy = meterValue
        ?.at(-1)
        ?.sampledValue.find(
          (value) =>
            (value.measurand ?? 'Energy.Active.Import.Register') ===
            'Energy.Active.Import.Register',
        );
      console.log(
        `  #${seqNo} ${eventType}/${triggerReason} ${transactionInfo.chargingState ?? ''}` +
          (energy ? ` ${energy.value} Wh` : ''),
      );
      return {};
    },
  );

const { port } = await cs.listen(0, '127.0.0.1');
const url = `ws://127.0.0.1:${port}`;
const old = new SimulatedCharger({ identity: 'CP-16', url, connectors: 1 });
const modern = new SimulatedChargingStation({
  identity: 'CS-201',
  url,
  evses: 1,
  txUpdatedIntervalS: 3,
});
await Promise.all([old.start(), modern.start()]);
await new Promise((resolve) => setTimeout(resolve, 500));

modern.plugIn(1, { batteryKWh: 60, initialSoc: 0.3, targetSoc: 1, maxPowerW: 11_000 });
const started = await cs.v201.call('CS-201', 'RequestStartTransaction', {
  idToken: { idToken: 'APP-USER', type: 'Central' },
  remoteStartId: 1,
  evseId: 1,
});
console.log(`RequestStartTransaction: ${started.status}`);
await new Promise((resolve) => setTimeout(resolve, 2_000));

const limit = await cs.v201.call('CS-201', 'SetChargingProfile', {
  evseId: 0,
  chargingProfile: {
    id: 1,
    stackLevel: 0,
    chargingProfilePurpose: 'TxDefaultProfile',
    chargingProfileKind: 'Relative',
    chargingSchedule: [
      { id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: 7_400 }] },
    ],
  },
});
console.log(`SetChargingProfile 7.4 kW: ${limit.status}`);
await new Promise((resolve) => setTimeout(resolve, 8_000));
console.log(`EVSE 1 draws ${modern.evses[0]?.powerW ?? 0} W`);

const transactionId = modern.evses[0]?.transactionId;
if (transactionId) {
  const stopped = await cs.v201.call('CS-201', 'RequestStopTransaction', { transactionId });
  console.log(`RequestStopTransaction: ${stopped.status}`);
}
await new Promise((resolve) => setTimeout(resolve, 1_000));
await Promise.all([old.stop(), modern.stop()]);
await cs.close();

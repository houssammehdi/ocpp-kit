/**
 * Smart charging end to end, in one process: a Central System caps a simulated charger with
 * charging profiles and reads back the composite schedule.
 *
 *   npm run example:smart-charging
 */
import { CentralSystem, SimulatedCharger } from '../src/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let nextTransactionId = 1;

const cs = new CentralSystem();
cs.handle('BootNotification', () => ({
  status: 'Accepted',
  currentTime: new Date().toISOString(),
  interval: 300,
}));
cs.handle('StatusNotification', () => ({}));
cs.handle('Authorize', () => ({ idTagInfo: { status: 'Accepted' } }));
cs.handle('StartTransaction', () => ({
  idTagInfo: { status: 'Accepted' },
  transactionId: nextTransactionId++,
}));
cs.handle('MeterValues', () => ({}));
cs.handle('StopTransaction', () => ({}));
const { port } = await cs.listen(0, '127.0.0.1');

const charger = new SimulatedCharger({
  identity: 'SMART-1',
  url: `ws://127.0.0.1:${port}`,
  connectors: 2,
  maxPowerW: 22_000,
  tickMs: 200,
});
await charger.start();
await sleep(200);

const report = (label: string) => {
  const [one, two] = charger.connectors;
  console.log(
    `${label.padEnd(34)} connector 1: ${String(one?.powerW).padStart(5)} W (${one?.status})` +
      `  connector 2: ${String(two?.powerW).padStart(5)} W (${two?.status})`,
  );
};

// Two EVs arrive and start charging.
charger.plugIn(1, { batteryKWh: 77, initialSoc: 0.3, targetSoc: 1, maxPowerW: 22_000 });
charger.plugIn(2, { batteryKWh: 58, initialSoc: 0.5, targetSoc: 1, maxPowerW: 11_000 });
await charger.swipe(1, 'CARD-1');
await charger.swipe(2, 'CARD-2');
await sleep(500);
report('No profiles:');

// Site limit: the whole charge point may draw at most 16 A per phase (11 kW).
await cs.call('SMART-1', 'SetChargingProfile', {
  connectorId: 0,
  csChargingProfiles: {
    chargingProfileId: 1,
    stackLevel: 0,
    chargingProfilePurpose: 'ChargePointMaxProfile',
    chargingProfileKind: 'Absolute',
    chargingSchedule: {
      startSchedule: new Date().toISOString(),
      chargingRateUnit: 'A',
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }],
    },
  },
});
await sleep(500);
report('ChargePointMaxProfile 16 A:');

// Pause connector 2 for 15 minutes, then allow 6 A (TxDefaultProfile, relative to tx start).
await cs.call('SMART-1', 'SetChargingProfile', {
  connectorId: 2,
  csChargingProfiles: {
    chargingProfileId: 2,
    stackLevel: 1,
    chargingProfilePurpose: 'TxDefaultProfile',
    chargingProfileKind: 'Relative',
    chargingSchedule: {
      chargingRateUnit: 'A',
      chargingSchedulePeriod: [
        { startPeriod: 0, limit: 0 },
        { startPeriod: 900, limit: 6 },
      ],
    },
  },
});
await sleep(500);
report('+ TxDefaultProfile 0 A on #2:');

const composite = await cs.call('SMART-1', 'GetCompositeSchedule', {
  connectorId: 2,
  duration: 3_600,
  chargingRateUnit: 'A',
});
console.log('Composite schedule for connector 2 (next hour):');
for (const period of composite.chargingSchedule?.chargingSchedulePeriod ?? []) {
  console.log(`  +${String(period.startPeriod).padStart(4)} s  ${period.limit} A`);
}

await cs.call('SMART-1', 'ClearChargingProfile', {});
await sleep(500);
report('After ClearChargingProfile:');

await charger.stop();
await cs.close();

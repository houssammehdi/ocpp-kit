/**
 * A hand-written charge point: boots, runs one short session and disconnects. Start the
 * Central System example first (npm run example:csms), then:
 *
 *   npm run example:charge-point
 */
import { ChargePoint } from '../src/index.js';

const cp = new ChargePoint({
  identity: 'CP-001',
  url: process.env.CSMS_URL ?? 'ws://localhost:9220',
  password: 'secret',
  reconnect: { initialDelayMs: 500, maxDelayMs: 10_000 },
});

cp.on('reconnecting', (attempt, delay) => console.log(`reconnect #${attempt} in ${delay} ms`));
cp.on('connectFailed', (error) => console.log(`connect failed: ${error.message}`));

// The Central System may call us at any time; every handler is fully typed.
cp.handle('RemoteStartTransaction', ({ idTag, connectorId }) => {
  console.log(`remote start requested for ${idTag} on connector ${connectorId ?? 'any'}`);
  return { status: 'Accepted' };
});
cp.handle('Reset', () => ({ status: 'Rejected' }));

await cp.connect();
const boot = await cp.call('BootNotification', {
  chargePointVendor: 'ocpp-kit',
  chargePointModel: 'Example',
});
console.log(`boot: ${boot.status}, heartbeat every ${boot.interval}s`);

await cp.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Preparing' });
const { idTagInfo } = await cp.call('Authorize', { idTag: '04A2B3C4' });
if (idTagInfo.status !== 'Accepted') throw new Error(`id tag refused: ${idTagInfo.status}`);

// Transaction messages go through the offline queue: if the connection drops, they are kept
// and replayed in order after reconnecting, and these promises resolve on delivery.
const { transactionId } = await cp.call('StartTransaction', {
  connectorId: 1,
  idTag: '04A2B3C4',
  meterStart: 1_000,
  timestamp: new Date().toISOString(),
});
for (const wh of [1_500, 2_000, 2_600]) {
  await cp.call('MeterValues', {
    connectorId: 1,
    transactionId,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [
          { value: String(wh), measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
        ],
      },
    ],
  });
}
await cp.call('StopTransaction', {
  transactionId,
  meterStop: 3_000,
  timestamp: new Date().toISOString(),
  reason: 'Local',
});
await cp.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available' });

console.log(`session ${transactionId} done`);

// Stay online briefly so Central System initiated calls (like the example's remote start) arrive.
await new Promise((resolve) => setTimeout(resolve, 2_000));
await cp.close();

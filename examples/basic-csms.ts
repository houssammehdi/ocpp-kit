/**
 * A minimal Central System: accepts known charge points, authorizes a whitelist of id tags and
 * remote-starts a session on every charge point that boots.
 *
 *   npm run example:csms
 */
import { CentralSystem } from '../src/index.js';

const passwords = new Map([['CP-001', 'secret']]);
const allowedTags = new Set(['04A2B3C4', 'DEMO']);
let nextTransactionId = 1;

const cs = new CentralSystem({
  // Security Profile 1: HTTP Basic auth, username = charge point identity.
  authenticate: ({ identity, password }) => passwords.get(identity) === password,
  requireAcceptedBoot: true,
});

cs.on('connect', (cp) => console.log(`${cp.identity} connected`));
cs.on('disconnect', (cp, code) => console.log(`${cp.identity} disconnected (${code})`));
cs.on('rejected', ({ identity, reason }) => console.log(`rejected ${identity ?? '?'}: ${reason}`));

cs.handle('BootNotification', ({ chargePointVendor, chargePointModel }, { connection }) => {
  console.log(`${connection.identity} is a ${chargePointVendor} ${chargePointModel}`);
  // Once the response is out, ask the charge point to start a session.
  setTimeout(() => {
    connection
      .call('RemoteStartTransaction', { connectorId: 1, idTag: 'DEMO' })
      .then(({ status }) => console.log(`RemoteStartTransaction: ${status}`))
      .catch((error: unknown) => console.error('RemoteStartTransaction failed', error));
  }, 1_000);
  return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 60 };
});

cs.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
cs.handle('StatusNotification', ({ connectorId, status }, { connection }) => {
  console.log(`${connection.identity}#${connectorId} is ${status}`);
  return {};
});
cs.handle('Authorize', ({ idTag }) => ({
  idTagInfo: { status: allowedTags.has(idTag) ? 'Accepted' : 'Invalid' },
}));
cs.handle('StartTransaction', ({ connectorId, meterStart }, { connection }) => {
  const transactionId = nextTransactionId++;
  console.log(
    `${connection.identity}#${connectorId} started tx ${transactionId} at ${meterStart} Wh`,
  );
  return { idTagInfo: { status: 'Accepted' }, transactionId };
});
cs.handle('MeterValues', ({ transactionId, meterValue }) => {
  const energy = meterValue[0]?.sampledValue.find(
    (sample) => sample.measurand === 'Energy.Active.Import.Register',
  );
  console.log(`tx ${transactionId ?? '-'}: ${energy?.value ?? '?'} Wh`);
  return {};
});
cs.handle('StopTransaction', ({ transactionId, meterStop, reason }) => {
  console.log(`tx ${transactionId} stopped at ${meterStop} Wh (${reason ?? 'Local'})`);
  return {};
});

const { port } = await cs.listen(9220);
console.log(`Central System listening on ws://localhost:${port}/<identity>`);

process.once('SIGINT', () => {
  void cs.close().then(() => process.exit(0));
});

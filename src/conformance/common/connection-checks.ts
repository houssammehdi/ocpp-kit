/**
 * Checks of the WebSocket connection shared by every OCPP version: subprotocol, authentication,
 * pings, duplicate connections. Each factory takes the suite's kit and its specification
 * references.
 */
import { ProbeHandshakeError, type ProbeConnection } from '../probe.js';
import type { Check, CheckContext } from '../types.js';
import {
  fail,
  grace,
  pass,
  registeredWith,
  serviceProblemWith,
  skip,
  sleep,
  type SuiteKit,
} from './exchange.js';

/** A client error status refuses the handshake; anything else means the check cannot tell. */
function isRefusal(error: unknown): error is ProbeHandshakeError {
  return (
    error instanceof ProbeHandshakeError &&
    error.statusCode !== undefined &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  );
}

/** `ws.subprotocol`: the Central System selects the subprotocol the probe offers. */
export function subprotocolCheck(kit: SuiteKit, spec: string): Check {
  const offered = kit.protocol.subprotocol;
  return {
    id: 'ws.subprotocol',
    title: `Selects the ${offered} subprotocol offered by the charge point`,
    level: 'MUST',
    spec,
    async run(context) {
      try {
        // The probe offers only ocpp1.6 and fails a handshake that selects anything else.
        const connection = await context.session();
        return pass(`negotiated "${connection.protocol}"`);
      } catch (error) {
        if (error instanceof ProbeHandshakeError && error.statusCode === 101) {
          return fail(
            error.subprotocol === ''
              ? `completed the handshake without selecting "${offered}"`
              : `answered with subprotocol "${error.subprotocol ?? '?'}": ${error.message}`,
          );
        }
        throw error;
      }
    },
  };
}

const UNSUPPORTED_SUBPROTOCOL = 'ocpp0.0-unsupported';

/** `ws.subprotocol-refusal`: no OCPP session on a subprotocol the server does not support. */
export function subprotocolRefusalCheck(spec: string): Check {
  return {
    id: 'ws.subprotocol-refusal',
    title: 'Does not open an OCPP session on a subprotocol it does not support',
    level: 'SHOULD',
    spec,
    async run(context) {
      const offered = [`offered only "${UNSUPPORTED_SUBPROTOCOL}"`];
      try {
        const connection = await context.connect({ protocols: [UNSUPPORTED_SUBPROTOCOL] });
        const closed = await connection.closesWithin(grace(context));
        return fail(
          `accepted the connection with subprotocol "${connection.protocol}"${
            closed ? ' (and then closed it)' : ''
          }`,
          offered,
        );
      } catch (error) {
        if (error instanceof ProbeHandshakeError && error.statusCode === 101) {
          if (error.subprotocol === '') {
            return pass('completed the handshake without selecting a subprotocol', [
              ...offered,
              'the probe then fails the connection itself (RFC 6455 §4.1)',
            ]);
          }
          return fail(`selected "${error.subprotocol ?? '?'}", which was not offered`, offered);
        }
        if (isRefusal(error)) {
          return pass(`refused the handshake with HTTP ${error.statusCode ?? '?'}`, [
            ...offered,
            'no session starts; completing the handshake without a subprotocol and closing is the other accepted answer',
          ]);
        }
        throw error;
      }
    },
  };
}

/** Connect with changed credentials and report whether the Central System let it in. */
async function admitted(
  context: CheckContext,
  overrides: Parameters<CheckContext['connect']>[0],
): Promise<{ readonly admitted: boolean; readonly how: string }> {
  try {
    const connection = await context.connect(overrides);
    if (await connection.closesWithin(grace(context))) {
      return {
        admitted: false,
        how: `completed the handshake, then closed the connection (code ${connection.closeInfo?.code ?? '?'})`,
      };
    }
    return { admitted: true, how: 'accepted the connection' };
  } catch (error) {
    if (isRefusal(error)) {
      return { admitted: false, how: `refused with HTTP ${error.statusCode ?? '?'}` };
    }
    if (error instanceof ProbeHandshakeError && error.statusCode === undefined) {
      return { admitted: false, how: `refused the connection (${error.message})` };
    }
    throw error;
  }
}

/** `ws.basic-auth`: wrong or missing Basic auth passwords are refused. */
export function basicAuthCheck(spec: string): Check {
  return {
    id: 'ws.basic-auth',
    title: 'Refuses connections with a wrong or missing Basic auth password',
    level: 'MUST',
    spec,
    async run(context) {
      const { password, tls } = context.options;
      if (password === undefined) return skip('no password configured; Basic auth not exercised');
      if (tls?.cert !== undefined) {
        return skip('a client certificate is configured: Security Profile 3 authenticates with it');
      }
      const details: string[] = [];
      for (const [label, value] of [
        ['a wrong password', `${password}-wrong`],
        ['no credentials', null],
      ] as const) {
        const outcome = await admitted(context, { password: value });
        details.push(`${label}: ${outcome.how}`);
        if (outcome.admitted) return fail(`accepted a connection with ${label}`, details);
      }
      return pass('refused both a wrong password and missing credentials', details);
    },
  };
}

/** `tls.client-certificate`: TLS connections without a client certificate are refused. */
export function clientCertificateCheck(spec: string): Check {
  return {
    id: 'tls.client-certificate',
    title: 'Refuses TLS connections that present no client certificate',
    level: 'MUST',
    spec,
    async run(context) {
      const { tls } = context.options;
      if (tls?.cert === undefined) return skip('no client certificate configured');
      const outcome = await admitted(context, {
        tls: { ...tls, cert: undefined, key: undefined },
        password: null,
      });
      return outcome.admitted
        ? fail('accepted a connection without a client certificate or password', [outcome.how])
        : pass(`without a client certificate it ${outcome.how}`);
    },
  };
}

/** `ws.ping`: WebSocket pings are answered with pongs. */
export function pingCheck(spec: string): Check {
  return {
    id: 'ws.ping',
    title: 'Answers WebSocket pings with pongs',
    level: 'MUST',
    spec,
    async run(context) {
      const connection = await context.session();
      const started = performance.now();
      return (await connection.ping(context.options.timeoutMs))
        ? pass(`pong after ${(performance.now() - started).toFixed(1)} ms`)
        : fail(`no pong within ${context.options.timeoutMs} ms`);
    },
  };
}

/** `ws.duplicate-connection`: one usable connection when an identity connects twice. */
export function duplicateConnectionCheck(kit: SuiteKit, spec: string): Check {
  const registered = (context: CheckContext) => registeredWith(kit, context);
  const serviceProblem = (
    connection: ProbeConnection,
    context: CheckContext,
    anyAnswer?: boolean,
  ) => serviceProblemWith(kit, connection, context, anyAnswer);
  return {
    id: 'ws.duplicate-connection',
    title: 'Keeps a single usable connection when the identity connects twice',
    level: 'SHOULD',
    spec,
    async run(context) {
      // Any answer to a Heartbeat counts as serving: the second connection sends no
      // BootNotification, which some Central Systems want first on every connection.
      const first = await registered(context);
      const { observeMs } = context.options;
      try {
        let second: ProbeConnection;
        try {
          second = await context.connect();
        } catch (error) {
          if (!isRefusal(error)) throw error;
          const problem = await serviceProblem(first, context, true);
          return problem
            ? fail(
                `refused the second connection with HTTP ${error.statusCode ?? '?'}, but ${problem.problem}`,
              )
            : pass(
                `refused the second connection with HTTP ${error.statusCode ?? '?'} and kept the first`,
              );
        }
        await Promise.race([first.closed, second.closed, sleep(observeMs)]);
        // A close frame usually follows its cause closely; let a second one arrive.
        await sleep(grace(context));
        const closedLine = (connection: ProbeConnection): string =>
          `code ${connection.closeInfo?.code ?? '?'}`;
        if (!first.isOpen && !second.isOpen) {
          return fail(
            `closed both connections (${closedLine(first)}, ${closedLine(second)}); the charge point is left offline`,
          );
        }
        if (!first.isOpen || !second.isOpen) {
          const [kept, dropped, which] = first.isOpen
            ? [first, second, 'the new connection']
            : [second, first, 'the older connection'];
          const problem = await serviceProblem(kept, context, true);
          return problem
            ? fail(`closed ${which} (${closedLine(dropped)}), but ${problem.problem}`)
            : pass(`closed ${which} (${closedLine(dropped)}) and serves the other`);
        }
        const [a, b] = await Promise.all([
          serviceProblem(first, context, true),
          serviceProblem(second, context, true),
        ]);
        if (a === undefined && b === undefined) {
          return fail(
            `kept both connections open and answering for ${observeMs} ms: CALLs for this identity can go to either`,
          );
        }
        return pass('kept both connections open, but serves only one of them', [
          `older: ${a?.problem ?? 'serving'}`,
          `newer: ${b?.problem ?? 'serving'}`,
        ]);
      } finally {
        await context.endSession();
      }
    },
  };
}

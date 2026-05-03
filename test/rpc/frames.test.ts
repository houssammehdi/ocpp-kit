import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_ID_LENGTH,
  MessageType,
  RpcError,
  callErrorFrame,
  parseFrame,
  serializeFrame,
  type ParseResult,
} from '../../src/rpc/index.js';

function expectFailure(result: ParseResult) {
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.frame)}`);
  return result;
}

describe('parseFrame', () => {
  it('parses a CALL', () => {
    const result = parseFrame('[2,"abc","Heartbeat",{}]');
    expect(result).toEqual({
      ok: true,
      frame: { type: MessageType.Call, messageId: 'abc', action: 'Heartbeat', payload: {} },
    });
  });

  it('parses a CALLRESULT', () => {
    const result = parseFrame('[3,"abc",{"currentTime":"2026-01-01T00:00:00Z"}]');
    expect(result).toEqual({
      ok: true,
      frame: {
        type: MessageType.CallResult,
        messageId: 'abc',
        payload: { currentTime: '2026-01-01T00:00:00Z' },
      },
    });
  });

  it('parses a CALLERROR', () => {
    const result = parseFrame('[4,"abc","NotSupported","nope",{"a":1}]');
    expect(result).toEqual({
      ok: true,
      frame: {
        type: MessageType.CallError,
        messageId: 'abc',
        errorCode: 'NotSupported',
        errorDescription: 'nope',
        errorDetails: { a: 1 },
      },
    });
  });

  it('maps unknown CALLERROR codes to GenericError and keeps the original code', () => {
    const result = parseFrame('[4,"abc","RpcFrameworkError","",{}]');
    expect(result.ok && result.frame).toMatchObject({
      errorCode: 'GenericError',
      errorDetails: { originalErrorCode: 'RpcFrameworkError' },
    });
  });

  it.each([
    ['not json', '{oops', 'FormationViolation'],
    ['an object instead of array', '{"a":1}', 'FormationViolation'],
    ['a primitive', '42', 'FormationViolation'],
    ['an empty array', '[]', 'ProtocolError'],
    ['a lone type id', '[2]', 'ProtocolError'],
    ['a numeric message id', '[2,1,"Heartbeat",{}]', 'FormationViolation'],
  ])('rejects %s without a recoverable id', (_label, raw, code) => {
    const failure = expectFailure(parseFrame(raw));
    expect(failure.error).toBeInstanceOf(RpcError);
    expect(failure.error.code).toBe(code);
    expect(failure.messageId).toBeUndefined();
  });

  it.each([
    ['unknown message type', '[5,"id","x",{}]', 'ProtocolError'],
    ['string message type', '["2","id","Heartbeat",{}]', 'ProtocolError'],
    ['CALL missing payload', '[2,"id","Heartbeat"]', 'ProtocolError'],
    ['CALL with extra element', '[2,"id","Heartbeat",{},{}]', 'FormationViolation'],
    ['CALL with empty action', '[2,"id","",{}]', 'FormationViolation'],
    ['CALL with numeric action', '[2,"id",7,{}]', 'FormationViolation'],
    ['CALL with array payload', '[2,"id","Heartbeat",[]]', 'FormationViolation'],
    ['CALL with null payload', '[2,"id","Heartbeat",null]', 'FormationViolation'],
    ['CALLRESULT missing payload', '[3,"id"]', 'ProtocolError'],
    ['CALLRESULT with string payload', '[3,"id","ok"]', 'FormationViolation'],
    ['CALLERROR missing details', '[4,"id","GenericError","x"]', 'ProtocolError'],
    ['CALLERROR numeric code', '[4,"id",1,"x",{}]', 'FormationViolation'],
    ['CALLERROR numeric description', '[4,"id","GenericError",1,{}]', 'FormationViolation'],
    ['CALLERROR array details', '[4,"id","GenericError","x",[]]', 'FormationViolation'],
    ['empty message id', '[2,"","Heartbeat",{}]', 'FormationViolation'],
  ])('rejects %s and keeps the id', (_label, raw, code) => {
    const failure = expectFailure(parseFrame(raw));
    expect(failure.error.code).toBe(code);
    expect(typeof failure.messageId).toBe('string');
  });

  it('enforces the 36 character message id limit', () => {
    const ok = 'x'.repeat(MAX_MESSAGE_ID_LENGTH);
    expect(parseFrame(`[2,"${ok}","Heartbeat",{}]`).ok).toBe(true);
    const failure = expectFailure(parseFrame(`[2,"${ok}y","Heartbeat",{}]`));
    expect(failure.error.code).toBe('FormationViolation');
    expect(failure.messageType).toBe(MessageType.Call);
  });

  it('reports the message type for failed frames so callers know whether to reply', () => {
    expect(expectFailure(parseFrame('[3,"id","x"]')).messageType).toBe(MessageType.CallResult);
    expect(expectFailure(parseFrame('[2,"id",1,{}]')).messageType).toBe(MessageType.Call);
  });
});

describe('serializeFrame', () => {
  it('round-trips every frame type', () => {
    const frames = [
      { type: MessageType.Call, messageId: '1', action: 'Authorize', payload: { idTag: 'A' } },
      { type: MessageType.CallResult, messageId: '1', payload: {} },
      {
        type: MessageType.CallError,
        messageId: '1',
        errorCode: 'InternalError',
        errorDescription: 'boom',
        errorDetails: {},
      },
    ] as const;
    for (const frame of frames) {
      const parsed = parseFrame(serializeFrame(frame));
      expect(parsed).toEqual({ ok: true, frame });
    }
  });

  it('builds CALLERROR frames from RpcError without echoing the code as description', () => {
    expect(callErrorFrame('9', new RpcError('SecurityError'))).toEqual({
      type: MessageType.CallError,
      messageId: '9',
      errorCode: 'SecurityError',
      errorDescription: '',
      errorDetails: {},
    });
    expect(serializeFrame(callErrorFrame('9', new RpcError('GenericError', 'x', { k: 1 })))).toBe(
      '[4,"9","GenericError","x",{"k":1}]',
    );
  });
});

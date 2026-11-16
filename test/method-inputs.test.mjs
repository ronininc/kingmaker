import test from 'node:test';
import assert from 'node:assert/strict';
import { inputsFromRequest } from '../lib/method-request.mjs';
test('numeric method inputs come only from explicit values in the request; nothing is guessed', () => {
  assert.deepEqual(inputsFromRequest('Kingmaker, run the thermostat test with setpoint 19', { setpoint: 21, prompt: '' }), { setpoint: 19 });
  assert.deepEqual(inputsFromRequest('run it with the setpoint of 18.5', { setpoint: 21 }), { setpoint: 18.5 });
  assert.deepEqual(inputsFromRequest('run it at 24 degrees setpoint', { setpoint: 21 }), { setpoint: 24 });
  assert.deepEqual(inputsFromRequest('run the thermostat test, it is 19 outside', { setpoint: 21 }), {});
  assert.deepEqual(inputsFromRequest('setpoint 19', { prompt: '' }), {}, 'undeclared inputs are never read');
});

// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

// node --test tests/*.test.js (or tests/run.sh)

'use strict';

const test = require('node:test');
const assert = require('assert');
const {reply, exception, errCreate, parsePayload} = require('../service/lib/mojo');

test('an error with no errorCode of its own replies -9999, as mojoservice did', () => {
	const r = exception(new TypeError('x is undefined'));
	assert.strictEqual(r.errorCode, -9999);
	assert.strictEqual(r.errorText, 'MojoService: no errorCode supplied x is undefined');
	assert.strictEqual(r.returnValue, false);
	assert.ok(/^TypeError: x is undefined/.test(r.exception));
});

test('Err.create: errorCode -1 when none, its keys in order, and its text', () => {
	const e = errCreate(undefined, 'boom');
	assert.strictEqual(e.errorCode, -1);
	assert.deepStrictEqual(Object.keys(e), ['errorCode', 'innerError', 'toString']);
	assert.strictEqual(String(e), 'Error: boom');
	assert.strictEqual(String(errCreate(2, 'outer', {message: 'inner'})), 'Error: outer; innerError: inner');
	assert.deepStrictEqual(exception(errCreate(-1, 'no')).errorCode, -1);
});

test('an object result gets returnValue:true, nothing gets {returnValue:true}', () => {
	assert.deepStrictEqual(reply({isAllowed: false}), {isAllowed: false, returnValue: true});
	assert.deepStrictEqual(reply(undefined), {returnValue: true});
});

test('payloads as mojoservice took them', () => {
	assert.deepStrictEqual(parsePayload('null'), {args: {}});
	assert.deepStrictEqual(parsePayload('[]'), {args: []});
	assert.deepStrictEqual(parsePayload('{"a":1}'), {args: {a: 1}});
	assert.deepStrictEqual(parsePayload('{').reply, {returnValue: false, errorCode: -9999,
		errorText: 'MojoService: no errorCode supplied '});
});

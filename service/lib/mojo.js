// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The replies the service gave when it ran on mojoservice, kept as they
	were for its callers. reply(), exception() and timeoutError() are the
	contacts linker's (webOS-ports/app-services,
	com.palm.service.contacts.linker/lib/mojo.js); keep them in step.

	- an object result with returnValue:true added
	- an error as {errorText, errorCode, exception, returnValue:false}: with
	  no errorCode of its own, -9999 and "MojoService: no errorCode
	  supplied " before its text
	- a command still running after its timeout: error 504,
	  "commandTimeout in com.palm.mediapermissions/<method>"
	- a payload that is not JSON: {returnValue:false, errorCode:-9999,
	  errorText:"MojoService: no errorCode supplied "}, the command not run
	- a payload that is JSON but falsy (null, 0, false, ""): run with {}

	Not kept: mojoservice made an activity for every call that brought none
	(activitymanager/create "<method>_<n>", completed when it answered) and
	took on one a call brought ($activity: adopted or monitored); nothing
	calls this service with one, and its own work needs none. Nor its
	__info, __quit and __gc methods (bus.js answers info and quit).
*/

const DEFAULT_TIMEOUT_S = 60;

function reply(result) {
	if (!result) {
		return {returnValue: true};
	}
	if (typeof result === 'object') {
		result.returnValue = true;
	}
	return result;
}

function exception(e) {
	const out = {
		errorText: e && e.message,
		errorCode: e && e.errorCode,
		exception: e && e.stack ? e.stack : String(e),
		returnValue: false
	};
	if (out.errorCode === undefined) {
		out.errorCode = -9999;
		out.errorText = 'MojoService: no errorCode supplied ' + (out.errorText || '');
	}
	return out;
}

function timeoutError(service, command) {
	return errCreate(504, 'commandTimeout in ' + service + '/' + command);
}

/*
	Foundations.Err.create(code, text, inner): an Error with errorCode (-1
	when none), innerError and a toString of its own, in that order: the
	service's printObj() lists them so (permissions.js).
*/
function errToString() {
	/* jshint validthis: true */
	const full = a => (a.message ? 'Error: ' + a.message : 'Error: ' + JSON.stringify(a));
	return full(this) + (this.innerError ? '; inner' + full(this.innerError) : '');
}

function errCreate(code, text, inner) {
	const e = new Error(text);
	e.errorCode = code !== undefined ? code : -1;
	e.innerError = inner;
	e.toString = errToString;
	return e;
}

/*
	The payload as mojoservice took it: JSON.parse, and {} for a falsy
	value. -> {args} or {reply} for a payload that does not parse.
*/
function parsePayload(text) {
	let args;
	try {
		args = JSON.parse(text);
	} catch (e) {
		// mojoservice replied with the SyntaxError itself: only these keys survive JSON.
		return {reply: {returnValue: false, errorCode: -9999, errorText: 'MojoService: no errorCode supplied '}};
	}
	return {args: args || {}};
}

/*
	A bus method ({handler, raw, rawPayload, timeoutMs}) that replies as
	mojoservice did: run(args, message) is the command; it gets timeoutS
	seconds.
*/
function method(service, name, run, {timeoutS = DEFAULT_TIMEOUT_S, log = console} = {}) {
	return {
		raw: true,
		rawPayload: true,
		timeoutMs: (timeoutS + 5) * 1000,
		handler: async (text, ctx = {}) => {
			const parsed = parsePayload(text);
			if (parsed.reply) {
				log.error(service + ': ' + name + ': the payload is not JSON');
				return parsed.reply;
			}
			let timer;
			const late = new Promise((resolve, reject) => {
				timer = setTimeout(() => reject(timeoutError(service, name)), timeoutS * 1000);
			});
			try {
				return reply(await Promise.race([Promise.resolve().then(() => run(parsed.args, ctx.message)), late]));
			} catch (e) {
				log.error(service + ': ' + name + ' failed: ' + ((e && e.message) || e));
				return exception(e);
			} finally {
				clearTimeout(timer);
			}
		}
	};
}

module.exports = {method, reply, exception, timeoutError, errCreate, parsePayload, DEFAULT_TIMEOUT_S};

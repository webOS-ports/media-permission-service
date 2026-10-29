// Copyright (c) 2026 Herman van Hazendonk
// Derived from Foundations' comms/palmcall.js, Copyright (c) 2009-2012
// Hewlett-Packard Development Company, L.P., licensed under the Apache
// License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	A bus call as Foundations' PalmCall.call(uri, method, args) made it, for
	the old service's error texts: uri and method joined with one "/", no
	timeout, and a reply that has returnValue:false, an errorCode or an
	errorText is a failure: Err.create(its errorCode or -1, "<url> <args>:
	<its errorText, or Unknown PalmCall failure>", its exception), with
	the reply as .response. opts.timeoutMs: give up after that long, failing
	as a call the bus could not make; none by default.
*/

const {errCreate} = require('./mojo');

function createPalmCall(bus) {
	return async function palmCall(uri, method, args, {timeoutMs = 0} = {}) {
		let url = uri;
		if (method.length > 0) {
			if (url.charAt(url.length - 1) !== '/') {
				url += '/';
			}
			url += method;
		}
		let payload;
		try {
			payload = await bus.call(url, args, {raw: true, timeoutMs});
		} catch (e) {
			// No reply to read: a bad one, or the call could not be made.
			throw errCreate(-1, url + ' ' + JSON.stringify(args) + ': ' + ((e && e.errorText) || (e && e.message) || e));
		}
		if (payload.returnValue === false || payload.errorCode || payload.errorText) {
			const err = errCreate(payload.errorCode || -1, url + ' ' + JSON.stringify(args) + ': ' +
				(payload.errorText || 'Unknown PalmCall failure'), payload.exception);
			err.response = payload;
			throw err;
		}
		return payload;
	};
}

module.exports = {createPalmCall};

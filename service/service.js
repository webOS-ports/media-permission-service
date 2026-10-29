// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-only

'use strict';

/*
	com.palm.mediapermissions: asks the user before an application may read
	the media kinds, and has the media indexer grant it (lib/permissions.js).

	The launcher (run-js-service -> jsservicelauncher's bootstrap-node.js)
	requires this directory, as it has a package.json, and calls run().
	Nothing starts on require, so a test can start() it on a stand-in bus.
*/

const {createBus} = require('./lib/bus');
const {method} = require('./lib/mojo');
const {createPalmCall} = require('./lib/palmcall');
const {createPermissions} = require('./lib/permissions');

const NAME = 'com.palm.mediapermissions';

// The command timeouts the old services.json gave: request 180 s, the rest
// mojoservice's default of 60 s.
const REQUEST_TIMEOUT_S = 180;
const RESPONSE_TIMEOUT_S = 60;

// The old services.json's activityTimeout: mojoservice quit 30 s after its
// last command was done.
const IDLE_MS = 30000;

/*
	start({palmbus, ...}): the service on that bus.
*/
function start({palmbus, exit, idleMs = IDLE_MS, log = console} = {}) {
	const bus = createBus({palmbus, name: NAME, exit, idleMs, log});
	const permissions = createPermissions({call: createPalmCall(bus), log});
	bus.serve({
		request: method(NAME, 'request', permissions.request, {timeoutS: REQUEST_TIMEOUT_S, log}),
		permissionsResponse: method(NAME, 'permissionsResponse', permissions.permissionsResponse,
			{timeoutS: RESPONSE_TIMEOUT_S, log})
	});
	log.log(NAME + ': up (node ' + process.version + ')');
	return {bus, permissions};
}

let running = null;
function run() {
	if (running) {
		return running;
	}
	process.title = NAME;
	// The old service logged an uncaught exception and went on, so a
	// question open stayed open: so does this.
	process.on('uncaughtException', e => {
		console.error(NAME + ': uncaught: ' + ((e && e.stack) || e));
	});
	process.on('unhandledRejection', e => {
		console.error(NAME + ': unhandled: ' + ((e && e.stack) || e));
	});
	// palmbus is the launcher's: it is there on the device and nowhere else.
	running = start({palmbus: require('palmbus')});
	return running;
}

module.exports = {start, run, NAME};

if (require.main === module) {
	run();
}

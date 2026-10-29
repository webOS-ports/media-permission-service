// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-only

'use strict';

/*
	The service on a stand-in bus (palmbus.js), with db8's
	com.palm.media.permissions:1 in memory and the application manager,
	notification manager and media indexer behind it, recording every call
	it makes. The clock is the test's (t.mock.timers, Date and setTimeout);
	the static db8 grants are files: {path: text}, through fs.readFileSync.
*/

const fs = require('fs');
const path = require('path');
const {createPalmbus} = require('./palmbus');

const NAME = 'com.palm.mediapermissions';
const SHELL = {service: 'com.webos.surfacemanager', exe: '/usr/bin/surface-manager'};
const quiet = {log() {}, warn() {}, error() {}, info() {}};

function plain(v) {
	return JSON.parse(JSON.stringify(v));
}

/*
	options: records (db8's to start with), files, bus {"<service>/<method>":
	args -> reply (a promise, an array, or undefined for none)}, dbWriteFails,
	dbReadFails. Call in a test with t.mock.timers enabled.
*/
function boot(t, options = {}) {
	const world = {calls: [], db: plain(options.records || []), nextId: 1};
	const files = options.files || {};
	const realRead = fs.readFileSync;
	t.mock.method(fs, 'readFileSync', function (file, ...rest) {
		if (typeof file === 'string' && file.indexOf('/etc/palm/db/permissions/') === 0) {
			if (!Object.prototype.hasOwnProperty.call(files, file)) {
				throw new Error('ENOENT ' + file);
			}
			return files[file];
		}
		return realRead.call(this, file, ...rest);
	});

	function onCall(uri, args) {
		const name = uri.replace(/^luna:\/\//, '');
		world.calls.push({name, params: plain(args)});
		const handler = (options.bus || {})[name];
		if (handler) {
			return handler(args, world);
		}
		if (name === 'com.palm.db/find') {
			if (options.dbReadFails) {
				return {returnValue: false, errorCode: -3, errorText: 'db8 down'};
			}
			const val = args.query.where[0].val;
			return {returnValue: true, results: plain(world.db.filter(r => r.senderId === val))};
		}
		if (name === 'com.palm.db/put') {
			if (options.dbWriteFails) {
				return {returnValue: false, errorCode: -3, errorText: 'db8 down'};
			}
			for (const o of args.objects) {
				const copy = plain(o);
				if (!copy._id) {
					copy._id = String(world.nextId++);
				}
				world.db = world.db.filter(r => r._id !== copy._id).concat([copy]);
			}
			return {returnValue: true};
		}
		if (name === 'com.webos.service.applicationmanager/getAppInfo') {
			return {returnValue: true, appInfo: {title: 'Example'}};
		}
		if (name === 'com.webos.notification/createAlert') {
			return {returnValue: true, alertId: 'alert-1'};
		}
		return {returnValue: true};
	}

	const pb = createPalmbus(onCall);
	const {start} = require(path.join(__dirname, '..', 'service', 'service'));
	const service = start({palmbus: pb, idleMs: 0, log: quiet, exit() {}});

	// Every call in flight answered and its answer worked through.
	async function settle() {
		for (let i = 0; i < 30; i++) {
			await new Promise(r => setImmediate(r));
		}
	}

	// -> {value}: the reply once it comes (undefined until then).
	function send(method, payload, caller) {
		const answer = {};
		answer.done = pb.request(NAME, method, payload, caller).then(text => {
			answer.value = JSON.parse(text);
			return answer.value;
		});
		return answer;
	}

	function named(name) {
		return world.calls.filter(c => c.name === name);
	}

	function lastAlert() {
		const alerts = named('com.webos.notification/createAlert');
		return alerts.length ? alerts[alerts.length - 1].params : null;
	}

	return Object.assign(world, {
		service, pb, settle, send, named, lastAlert,
		// A request from appId (or {appId, service}) for kinds; settled.
		async ask(appId, kinds) {
			const caller = typeof appId === 'object' && appId ? appId : {appId: appId || 'org.example.app'};
			const a = send('request', {rights: {read: kinds || ['com.palm.media.video.file:1']}}, caller);
			await settle();
			return a;
		},
		// The shell (or from) answering with params; settled. -> the reply.
		async respond(params, from) {
			const a = send('permissionsResponse', params, from || SHELL);
			await settle();
			return a.value;
		},
		// The user pressing "allow", "deny" or closing ("close") the last question.
		async press(which) {
			const p = lastAlert();
			if (!p) {
				throw new Error('the user was not asked');
			}
			if (which === 'close') {
				return this.respond(p.onclose.params);
			}
			return this.respond(p.buttons[which === 'allow' ? 1 : 0].params);
		},
		stop() {
			service.bus.stop();
		}
	});
}

module.exports = {boot, NAME, SHELL, quiet};

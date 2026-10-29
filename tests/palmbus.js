// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

/*
	A stand-in palmbus for running the service on the host (the contacts
	linker's tests/palmbus.js, with the sender's executable and a raw
	payload): outgoing calls go to onCall(uri, args, sender) -> a reply, an
	array of replies (a promise in it is a reply sent when it resolves), or
	undefined (never replies); request() delivers a call to a registered
	service. caller: {appId, service, exe, raw}; with no exe key the
	message has no senderExePath(), as a palmbus without it.
*/
'use strict';

const {EventEmitter} = require('events');

function createPalmbus(onCall) {
	const handles = [];
	const services = {};
	let token = 0;

	function Handle(name) {
		EventEmitter.call(this);
		this.name = name || '';
		this.methods = [];
		handles.push(this);
		if (name) {
			services[name] = this;
		}
	}
	Object.setPrototypeOf(Handle.prototype, EventEmitter.prototype);
	Handle.prototype.registerMethod = function (category, method) {
		this.methods.push((category || '/') + method);
	};
	Handle.prototype.subscriptionAdd = function () {};
	Handle.prototype.unregister = function () {
		this.unregistered = true;
	};
	Handle.prototype.pushRole = function () {};
	Handle.prototype.call = function (uri, payload) {
		const req = new EventEmitter();
		const args = JSON.parse(payload);
		req.cancel = function () {
			req.cancelled = true;
		};
		const self = this;
		setImmediate(async function () {
			let r;
			try {
				r = await onCall(uri.replace(/^palm:/, 'luna:'), args, self.name);
			} catch (e) {
				r = {returnValue: false, errorCode: -1, errorText: String(e && e.stack || e)};
			}
			if (r === undefined) {
				return;
			}
			for (const next of Array.isArray(r) ? r : [r]) {
				const one = await next;
				if (req.cancelled) {
					return;
				}
				req.emit('response', {payload: () => JSON.stringify(one)});
			}
		});
		return req;
	};
	Handle.prototype.callOneReply = Handle.prototype.call;
	Handle.prototype.watch = Handle.prototype.call;
	Handle.prototype.subscribe = Handle.prototype.call;

	// Deliver a call to the service registered as `name`; resolves with its first reply.
	function request(name, method, payload, caller) {
		caller = caller || {};
		const h = services[name];
		if (!h) {
			return Promise.reject(new Error('no service ' + name));
		}
		const replies = [];
		return new Promise(resolve => {
			token++;
			const t = String(token);
			const msg = {
				method: () => method,
				category: () => '/',
				// caller.raw: the payload text as it is (not JSON, or not an object)
				payload: () => (caller.raw !== undefined ? caller.raw : JSON.stringify(payload || {})),
				uniqueToken: () => t,
				token: () => token,
				applicationID: () => (caller.appId === undefined ? '' : caller.appId),
				senderServiceName: () => (caller.service === undefined ? '' : caller.service),
				sender: () => caller.service || caller.appId || '',
				isSubscription: () => false,
				respond: text => {
					replies.push(text);
					if (replies.length === 1) {
						resolve(text);
					}
					return true;
				}
			};
			// caller.exe: what senderExePath() gives; no exe key: a palmbus without the method
			if (Object.prototype.hasOwnProperty.call(caller, 'exe')) {
				msg.senderExePath = () => caller.exe;
			}
			h.emit('request', msg);
		});
	}

	return {Handle, handles, services, request, setAppId() {}};
}

module.exports = {createPalmbus};

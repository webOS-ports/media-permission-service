// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-only

'use strict';

/*
	request: an application asks to read media kinds (the user's music,
	pictures, videos and documents the media indexer lists). Every
	application may ask; the user's answer is what decides.

	  luna://com.palm.mediapermissions/request
	  {"rights": {"read": ["com.palm.media.video.file:1"]}}
	  -> {"returnValue": true, "isAllowed": true|false}

	Kinds the application may read already, because the user allowed them
	or db8's static grants list it (the built-in apps), are answered at
	once. For the others the user is asked, in the system's alert
	(com.webos.notification/createAlert, drawn by the shell); "Allow" makes
	the media indexer, which owns the kinds and is the only one db8 lets
	change who reads them, grant the application read access. The answers
	are kept in com.palm.media.permissions:1.

	So that an application cannot keep putting the question to the user:
	- it has at most one question open at a time; asking again meanwhile
	  is refused;
	- after "Don't Allow" it is answered "no" without asking for a day;
	- after a question that was closed or not answered, for ten minutes.

	permissionsResponse: the shell's call when a button is pressed. Only
	the shell may make it: the bus admits only holders of
	mediapermissions-service.response, and the sender must have the
	shell's name and run the shell's executable. It also needs the token
	of a question still open.

	This is the mojoservice service's Assistants.js, step for step: the
	same calls, in the same order, with the same arguments, and the same
	replies (README.md lists what it does wrong).
*/

const nodeCrypto = require('crypto');
const fs = require('fs');
const Rules = require('./rules');
const {errCreate} = require('./mojo');

const KIND = 'com.palm.media.permissions:1';
const SELF = 'luna://com.palm.mediapermissions/permissionsResponse';

// How long the question stays open; then it counts as closed. Below the
// request's command timeout (service.js), so the caller hears "no" from
// here rather than a timeout.
const ASK_TIMEOUT_MS = 120000;

// How long the grant and the record of an answer may take: the question
// stays open until they are done (B2), so a call that never returns must
// not keep it open for good. The old service waited without end.
const APPLY_TIMEOUT_MS = 60000;

/*
	The old service's printObj(obj): its own enumerable keys, each as JSON,
	in "{ key: value," form. It never closes the brace (it assigns to a
	character of a string), and a value JSON leaves out shows as
	"undefined". Kept for the log lines, as they were; no reply carries it
	(README: B1).
*/
function printObj(obj, depth) {
	let msg = '{';
	if (!depth) {
		depth = 0;
	}
	if (typeof obj === 'string') {
		return obj;
	}
	if (depth < 5) {
		for (const key in obj) {
			if (Object.prototype.hasOwnProperty.call(obj, key)) {
				try {
					msg += ' ' + key + ': ' + JSON.stringify(obj[key]) + ',';
				} catch (e) {
					msg += ' ' + key + ': ' + printObj(obj[key], depth + 1) + ',';
				}
			}
		}
	} else {
		msg = '...';
	}
	return msg;
}

/*
	call(uri, method, args): PalmCall (palmcall.js). log: console-like.
*/
function createPermissions({call, log = console}) {
	const sessions = {};
	// The applications with a question open, by id.
	const asking = {};

	function logError(...parts) {
		log.error(parts.join(''));
	}

	// The application's title, for the question; its id when there is none.
	async function appTitle(appId) {
		let title = appId;
		try {
			const r = await call('luna://com.webos.service.applicationmanager', 'getAppInfo', {id: appId});
			if (r && r.appInfo && typeof r.appInfo.title === 'string' && r.appInfo.title) {
				title = r.appInfo.title;
			}
		} catch (e) {
			logError('No title for ', appId, ': ', printObj(e));
		}
		return title;
	}

	function closeAlert(alertId) {
		if (alertId) {
			call('luna://com.webos.notification', 'closeAlert', {alertId}).catch(e => {
				logError('Could not close the question: ', printObj(e));
			});
		}
	}

	// answer: "allow", "deny", "dismiss" or "failed"
	function finishSession(sessionId, answer) {
		const session = sessions[sessionId];
		if (!session) {
			return false;
		}
		delete sessions[sessionId];
		clearTimeout(session.timer);
		// The shell closes the alert when a button is pressed; one still up
		// after a timeout would take a press that no longer counts.
		if (answer === 'dismiss') {
			closeAlert(session.alertId);
		}
		session.resolve(answer);
		return true;
	}

	// Asks the user: -> "allow", "deny" or "dismiss", or "failed" when the
	// user could not be asked.
	function askUser(appId, kinds) {
		const sessionId = nodeCrypto.randomBytes(8).toString('hex');
		const token = nodeCrypto.randomBytes(16).toString('hex');
		const titled = appTitle(appId);
		const answered = new Promise(resolve => {
			sessions[sessionId] = {token, resolve, alertId: null};
		});
		sessions[sessionId].timer = setTimeout(() => {
			logError('No answer for ', appId, ' in time; not allowed.');
			finishSession(sessionId, 'dismiss');
		}, ASK_TIMEOUT_MS);

		titled.then(async title => {
			const params = answer => ({sessionId, token, answer});
			let r;
			try {
				r = await call('luna://com.webos.notification', 'createAlert', {
					title: 'Media access',
					message: title + ' wants to read the ' + Rules.describe(kinds) + ' on this device.',
					modal: true,
					// buttonType: the shell draws "cancel" red and "ok" green
					buttons: [
						{label: 'Don\'t Allow', buttonType: 'cancel', focus: true, onclick: SELF, params: params('deny')},
						{label: 'Allow', buttonType: 'ok', onclick: SELF, params: params('allow')}
					],
					onclose: {uri: SELF, params: params('dismiss')}
				});
			} catch (e) {
				logError('Could not ask the user: ', printObj(e));
				finishSession(sessionId, 'failed');
				return;
			}
			if (sessions[sessionId]) {
				sessions[sessionId].alertId = r.alertId;
			} else {
				closeAlert(r.alertId);
			}
		});
		return answered;
	}

	// Of kinds, those db8's static grants already let appId read: the
	// built-in apps are never asked.
	function readableAlready(appId, kinds) {
		return kinds.filter(kind => {
			let entries;
			try {
				entries = JSON.parse(fs.readFileSync(Rules.permissionsFile(kind), 'utf8'));
			} catch (e) {
				return false;
			}
			return Rules.readableBy(entries, appId, kind);
		});
	}

	// -> when the answer is written, or could not be.
	function remember(record) {
		return call('palm://com.palm.db/', 'put', {objects: [record]}, {timeoutMs: APPLY_TIMEOUT_MS}).catch(e => {
			logError('Could not remember the answer: ', printObj(e));
		});
	}

	// The reply {returnValue:false, errorCode:-1, errorText: reason}.
	function fail(reason) {
		logError('Request refused: ', reason);
		return errCreate(-1, reason);
	}

	async function request(args, message) {
		const appId = Rules.callerAppId(message.applicationID && message.applicationID(),
			message.senderServiceName && message.senderServiceName());
		if (!appId) {
			throw fail('Could not tell which application is asking.');
		}
		let wanted = Rules.requestedKinds(args && args.rights);
		if (wanted.error) {
			throw fail(wanted.error);
		}
		wanted = wanted.kinds;

		let record, granted = [];
		try {
			const r = await call('palm://com.palm.db/', 'find',
				{query: {from: KIND, where: [{prop: 'senderId', op: '=', val: appId}]}, watch: false, count: false});
			if (r.returnValue === true && r.results.length > 0) {
				record = r.results[0];
				granted = record.rights && Array.isArray(record.rights.read) ? record.rights.read : [];
			}
		} catch (e) {
			logError('Could not read the answers given before: ', printObj(e));
			// Not taken for none: that would put a question the user said
			// "no" to again, and write a second record (B3).
			throw fail('Could not read the answers given before.');
		}
		if (!record) {
			record = {_kind: KIND, senderId: appId};
		}
		const missing = Rules.missing(granted.concat(readableAlready(appId, wanted)), wanted);
		if (missing.length === 0) {
			return {returnValue: true, isAllowed: true};
		}
		if (Rules.refusedRecently(record.refused, missing, Date.now())) {
			return {returnValue: true, isAllowed: false};
		}
		if (asking[appId]) {
			throw fail('A question for this application is already open.');
		}
		// The question counts as open until its answer is applied, written
		// too: a request in between would read the answers from before it
		// (B2). A "no" is still answered at once, as before.
		asking[appId] = true;
		let release = () => {
			delete asking[appId];
		};
		try {
			const answer = await askUser(appId, missing);
			if (answer !== 'allow') {
				if (answer === 'deny' || answer === 'dismiss') {
					record.refused = Rules.refuse(record.refused, missing, answer, Date.now());
					remember(record).then(release);
					release = null;
				}
				return {returnValue: true, isAllowed: false};
			}
			return await grant(appId, record, granted, missing);
		} finally {
			if (release) {
				release();
			}
		}
	}

	async function grant(appId, record, granted, missing) {
		try {
			await call('luna://org.webosports.service.mediaindexer', 'grantRead', {appId, kinds: missing},
				{timeoutMs: APPLY_TIMEOUT_MS});
		} catch (e) {
			// The reason: PalmCall's "<url> <args>: <the indexer's errorText>" (B1).
			throw fail('The media indexer could not grant access: ' + e.message);
		}
		record.rights = {read: granted.concat(missing)};
		record.refused = Rules.forget(record.refused, missing);
		try {
			await call('palm://com.palm.db/', 'put', {objects: [record]}, {timeoutMs: APPLY_TIMEOUT_MS});
		} catch (e) {
			// Granted all the same; db8 keeps the grant itself.
			logError('Could not remember the answer: ', printObj(e));
		}
		return {returnValue: true, isAllowed: true};
	}

	function permissionsResponse(args, message) {
		args = args || {};
		const sender = message.senderServiceName && message.senderServiceName();
		// Absent from a palmbus without senderExePath(): then nobody passes.
		const exe = message.senderExePath && message.senderExePath();
		if (!Rules.isShell(sender, exe)) {
			logError('permissionsResponse refused from ', sender, ' (', exe, ')');
			throw errCreate(-1, 'Only the system shell may answer.');
		}
		const session = typeof args.sessionId === 'string' ? sessions[args.sessionId] : undefined;
		if (!session || typeof args.token !== 'string' || args.token !== session.token ||
				!Rules.isAnswer(args.answer)) {
			throw errCreate(-1, 'No such question.');
		}
		finishSession(args.sessionId, args.answer);
		return {returnValue: true};
	}

	return {request, permissionsResponse, printObj, ASK_TIMEOUT_MS,
		// tests: the questions open
		get openSessions() {
			return Object.keys(sessions).length;
		}};
}

module.exports = {createPermissions, printObj, ASK_TIMEOUT_MS};

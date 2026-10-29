// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-only

// node --test tests/*.test.js (or tests/run.sh)
//
// The service on a stand-in bus (boot.js), walking each way a request can go.

'use strict';

const test = require('node:test');
const assert = require('assert');
const {boot, SHELL} = require('./boot');

const video = 'com.palm.media.video.file:1', audio = 'com.palm.media.audio.file:1';
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1000000;

// The indexer's static grants for videos: Videos may read them.
const videoGrants = JSON.stringify([
	{type: 'db.kind', object: video, caller: 'org.webosports.app.videoplayer', operations: {read: 'allow'}},
	{type: 'db.kind', object: video, caller: 'org.webosports.app.preview.*', operations: {read: 'allow'}},
	{type: 'db.kind', object: audio, caller: 'org.example.app', operations: {read: 'allow'}},
	{type: 'db.kind', object: video, caller: 'org.example.writer', operations: {create: 'allow'}}
]);
const staticFiles = {'/etc/palm/db/permissions/com.palm.media.video.file': videoGrants};

function failed(text) {
	return {returnValue: false, errorCode: -2, errorText: text};
}

// A world on the test's clock, stopped when the test ends.
function world(t, options) {
	t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: T0});
	const w = boot(t, options);
	t.after(() => w.stop());
	return w;
}

const alerts = w => w.named('com.webos.notification/createAlert').length;
const grants = w => w.named('org.webosports.service.mediaindexer/grantRead');

test('a built-in app with a static grant is allowed without asking', async t => {
	const w = world(t, {files: staticFiles});
	assert.deepStrictEqual((await w.ask('org.webosports.app.videoplayer')).value, {returnValue: true, isAllowed: true});
	assert.strictEqual(alerts(w), 0);
	assert.strictEqual(grants(w).length, 0);
	// a caller ending in "*" covers the ids it starts
	assert.deepStrictEqual((await w.ask('org.webosports.app.preview.one')).value, {returnValue: true, isAllowed: true});
	assert.strictEqual(alerts(w), 0);
});

test('a static grant counts only for its kind, caller and read', async t => {
	const w = world(t, {files: staticFiles});
	// org.example.app may read audio by a line in the video file: not videos
	await w.ask('org.example.app');
	assert.strictEqual(alerts(w), 1);
	await w.press('deny');
	// create is not read
	await w.ask('org.example.writer');
	assert.strictEqual(alerts(w), 2);
	await w.press('deny');
	// Videos is asked for what it was not granted
	await w.ask('org.webosports.app.videoplayer', [video, audio]);
	assert.strictEqual(w.lastAlert().message, 'Example wants to read the music on this device.');
});

test('an unreadable permissions file grants nothing', async t => {
	const w = world(t, {files: {'/etc/palm/db/permissions/com.palm.media.video.file': 'not json'}});
	await w.ask('org.webosports.app.videoplayer');
	assert.strictEqual(alerts(w), 1);
});

test('kinds that cannot be granted are refused without asking, as mojoservice replied', async t => {
	const w = world(t);
	const a = await w.ask('org.example.app', ['com.palm.contact:1']);
	assert.strictEqual(a.value.returnValue, false);
	assert.strictEqual(a.value.errorCode, -1);
	assert.strictEqual(a.value.errorText, 'Can not grant access to com.palm.contact:1');
	assert.strictEqual(a.value.exception.split('\n')[0], 'Error: Can not grant access to com.palm.contact:1');
	assert.deepStrictEqual(Object.keys(a.value), ['errorText', 'errorCode', 'exception', 'returnValue']);
	assert.strictEqual(alerts(w), 0);
});

test('a caller without an id, or with a wildcard, is refused', async t => {
	const w = world(t);
	for (const caller of [{appId: null, service: null}, {appId: '*'}, {appId: '', service: 'org.*'}]) {
		const a = await w.ask(caller);
		assert.strictEqual(a.value.returnValue, false);
		assert.strictEqual(a.value.errorText, 'Could not tell which application is asking.');
	}
	assert.strictEqual(w.calls.length, 0);
});

test('a payload that is not JSON, or not an object, is answered as mojoservice did', async t => {
	const w = world(t);
	let a = w.send('request', null, {appId: 'org.example.app', raw: 'nojson'});
	await w.settle();
	assert.deepStrictEqual(a.value, {returnValue: false, errorCode: -9999, errorText: 'MojoService: no errorCode supplied '});
	for (const raw of ['[]', 'null', '5', '"x"']) {
		a = w.send('request', null, {appId: 'org.example.app', raw});
		await w.settle();
		assert.strictEqual(a.value.errorText, 'rights.read must be a list of media kinds', raw);
	}
	a = w.send('permissionsResponse', null, Object.assign({raw: '[]'}, SHELL));
	await w.settle();
	assert.strictEqual(a.value.errorText, 'No such question.');
});

test('what was allowed before is answered at once', async t => {
	const w = world(t, {records: [{_id: '1', senderId: 'org.example.app', rights: {read: [video]}}]});
	const a = await w.ask('org.example.app 77', [video]);
	assert.deepStrictEqual(a.value, {returnValue: true, isAllowed: true});
	assert.strictEqual(alerts(w), 0);
	assert.strictEqual(grants(w).length, 0);
	assert.deepStrictEqual(w.named('com.palm.db/find')[0].params, {query: {from: 'com.palm.media.permissions:1',
		where: [{prop: 'senderId', op: '=', val: 'org.example.app'}]}, watch: false, count: false});
});

test('Allow grants through the indexer and remembers it', async t => {
	const w = world(t);
	const a = await w.ask();
	const p = w.lastAlert();
	assert.strictEqual(p.title, 'Media access');
	assert.strictEqual(p.message, 'Example wants to read the videos on this device.');
	assert.strictEqual(p.modal, true);
	assert.strictEqual(a.value, undefined, 'no answer before the user\'s');
	const allow = p.buttons[1];
	assert.strictEqual(allow.label, 'Allow');
	assert.strictEqual(allow.buttonType, 'ok', 'drawn green');
	assert.strictEqual(p.buttons[0].label, 'Don\'t Allow');
	assert.strictEqual(p.buttons[0].buttonType, 'cancel', 'drawn red');
	assert.strictEqual(p.buttons[0].focus, true);
	assert.strictEqual(allow.onclick, 'luna://com.palm.mediapermissions/permissionsResponse');
	assert.strictEqual(p.onclose.uri, 'luna://com.palm.mediapermissions/permissionsResponse');
	assert.strictEqual(allow.params.answer, 'allow');
	assert.strictEqual(p.onclose.params.answer, 'dismiss');
	assert.deepStrictEqual(await w.respond(allow.params), {returnValue: true});
	assert.deepStrictEqual(a.value, {returnValue: true, isAllowed: true});
	assert.deepStrictEqual(grants(w)[0].params, {appId: 'org.example.app', kinds: [video]});
	assert.deepStrictEqual(w.db[0].rights, {read: [video]});
	assert.strictEqual(w.db[0].senderId, 'org.example.app');
	assert.strictEqual(w.db[0]._kind, 'com.palm.media.permissions:1');
	// The shell closes the alert itself after a press.
	assert.strictEqual(w.named('com.webos.notification/closeAlert').length, 0);
	assert.strictEqual(w.service.permissions.openSessions, 0);
	// And the next request is answered without asking.
	assert.deepStrictEqual((await w.ask()).value, {returnValue: true, isAllowed: true});
	assert.strictEqual(alerts(w), 1);
});

test('a second kind is added to what was allowed before', async t => {
	const w = world(t, {records: [{_id: '1', senderId: 'org.example.app', rights: {read: [video]}}]});
	const a = await w.ask('org.example.app', [video, audio]);
	assert.strictEqual(w.lastAlert().message, 'Example wants to read the music on this device.');
	await w.press('allow');
	assert.deepStrictEqual(a.value, {returnValue: true, isAllowed: true});
	assert.deepStrictEqual(grants(w)[0].params.kinds, [audio]);
	assert.strictEqual(w.db.length, 1);
	assert.deepStrictEqual(w.db[0].rights.read, [video, audio]);
});

test('Don\'t Allow grants nothing', async t => {
	const w = world(t);
	const a = await w.ask();
	await w.press('deny');
	assert.deepStrictEqual(a.value, {returnValue: true, isAllowed: false});
	assert.strictEqual(grants(w).length, 0);
	assert.strictEqual(w.db[0].rights, undefined);
	assert.deepStrictEqual(w.db[0].refused, [{kind: video, until: T0 + DAY}]);
});

test('after Don\'t Allow the app is not asked again for a day', async t => {
	const w = world(t);
	await w.ask();
	await w.press('deny');
	t.mock.timers.tick(DAY - 1);
	let a = await w.ask();
	assert.deepStrictEqual(a.value, {returnValue: true, isAllowed: false});
	assert.strictEqual(alerts(w), 1);
	// Other kinds may still be asked for.
	await w.ask('org.example.app', [audio]);
	assert.strictEqual(alerts(w), 2);
	await w.press('deny');
	// Another app is asked as usual.
	await w.ask('org.example.other');
	assert.strictEqual(alerts(w), 3);
	await w.press('deny');
	t.mock.timers.tick(1);
	a = await w.ask();
	assert.strictEqual(alerts(w), 4, 'asked again after a day');
	await w.press('allow');
	assert.strictEqual(a.value.isAllowed, true);
	assert.deepStrictEqual(w.db.filter(r => r.senderId === 'org.example.app')[0].refused,
		[{kind: audio, until: T0 + DAY - 1 + DAY}]);
});

test('closing the alert counts as no, quiet for ten minutes', async t => {
	const w = world(t);
	const a = await w.ask();
	await w.press('close');
	assert.deepStrictEqual(a.value, {returnValue: true, isAllowed: false});
	t.mock.timers.tick(10 * 60 * 1000 - 1);
	assert.deepStrictEqual((await w.ask()).value, {returnValue: true, isAllowed: false});
	assert.strictEqual(alerts(w), 1);
	t.mock.timers.tick(1);
	await w.ask();
	assert.strictEqual(alerts(w), 2);
});

test('one question per app at a time', async t => {
	const w = world(t);
	const first = await w.ask();
	const second = await w.ask();
	assert.strictEqual(second.value.returnValue, false);
	assert.strictEqual(second.value.errorText, 'A question for this application is already open.');
	assert.strictEqual(alerts(w), 1);
	const other = await w.ask('org.example.other');
	assert.strictEqual(other.value, undefined, 'another app is asked');
	assert.strictEqual(alerts(w), 2);
	await w.respond(w.named('com.webos.notification/createAlert')[0].params.buttons[1].params);
	assert.strictEqual(first.value.isAllowed, true);
});

test('only the shell\'s program under the shell\'s name may answer', async t => {
	const w = world(t);
	const a = await w.ask();
	const allow = w.lastAlert().buttons[1].params;
	for (const from of [{service: 'org.example.app', exe: SHELL.exe}, {service: null, exe: SHELL.exe},
		// luna-send -m com.webos.surfacemanager-x
		{service: SHELL.service + '-x', exe: '/usr/bin/luna-send'}, {service: SHELL.service, exe: ''},
		// A palmbus that cannot tell the executable
		{service: SHELL.service}]) {
		const r = await w.respond(allow, from);
		assert.strictEqual(r.returnValue, false, JSON.stringify(from));
		assert.strictEqual(r.errorText, 'Only the system shell may answer.');
	}
	assert.strictEqual(a.value, undefined);
	assert.strictEqual(grants(w).length, 0);
	await w.respond(allow);
	assert.strictEqual(a.value.isAllowed, true);
});

test('an answer needs the question\'s token', async t => {
	const w = world(t);
	const a = await w.ask();
	const allow = w.lastAlert().buttons[1].params;
	assert.ok(/^[0-9a-f]{32}$/.test(allow.token));
	assert.ok(/^[0-9a-f]{16}$/.test(allow.sessionId));
	for (const params of [{sessionId: allow.sessionId, token: '0', answer: 'allow'}, {sessionId: allow.sessionId, answer: 'allow'},
		{sessionId: 'nope', token: allow.token, answer: 'allow'}]) {
		const r = await w.respond(params);
		assert.strictEqual(r.returnValue, false);
		assert.strictEqual(r.errorText, 'No such question.');
	}
	assert.strictEqual(a.value, undefined);
	await w.respond(allow);
	assert.strictEqual(a.value.isAllowed, true);
	assert.strictEqual((await w.respond(allow)).returnValue, false, 'answered once only');
});

test('an answer must be one of the three', async t => {
	const w = world(t);
	const a = await w.ask();
	const p = w.lastAlert().buttons[1].params;
	assert.strictEqual((await w.respond({sessionId: p.sessionId, token: p.token, answer: true})).returnValue, false);
	assert.strictEqual((await w.respond({sessionId: p.sessionId, token: p.token, allow: true})).returnValue, false);
	assert.strictEqual(a.value, undefined);
});

test('no answer in time counts as no and closes the alert', async t => {
	const w = world(t);
	const a = await w.ask();
	const p = w.lastAlert().buttons[1].params;
	t.mock.timers.tick(120000 - 1);
	await w.settle();
	assert.strictEqual(a.value, undefined);
	t.mock.timers.tick(1);
	await w.settle();
	assert.deepStrictEqual(a.value, {returnValue: true, isAllowed: false});
	assert.deepStrictEqual(w.named('com.webos.notification/closeAlert')[0].params, {alertId: 'alert-1'});
	assert.strictEqual((await w.respond(p)).returnValue, false, 'too late');
	assert.strictEqual(w.db[0].refused[0].until, T0 + 120000 + 10 * 60 * 1000);
});

test('each question has its own session and token', async t => {
	const w = world(t);
	await w.ask('org.example.one');
	await w.ask('org.example.two');
	const one = w.named('com.webos.notification/createAlert')[0].params.buttons[1].params;
	const two = w.named('com.webos.notification/createAlert')[1].params.buttons[1].params;
	assert.notStrictEqual(one.sessionId, two.sessionId);
	assert.notStrictEqual(one.token, two.token);
	assert.strictEqual((await w.respond({sessionId: one.sessionId, token: two.token, answer: 'allow'})).returnValue, false);
});

test('when the user cannot be asked the answer is no, and may be asked again', async t => {
	const w = world(t, {bus: {'com.webos.notification/createAlert': () => failed('no shell')}});
	const a = await w.ask();
	assert.deepStrictEqual(a.value, {returnValue: true, isAllowed: false});
	assert.strictEqual(grants(w).length, 0);
	assert.strictEqual(w.db.length, 0, 'not remembered as a no');
	await w.ask();
	assert.strictEqual(alerts(w), 2);
});

test('a reply with an errorText is a failure, as PalmCall took it', async t => {
	const w = world(t, {bus: {'com.webos.notification/createAlert': () => ({returnValue: true, errorText: 'odd'})}});
	assert.deepStrictEqual((await w.ask()).value, {returnValue: true, isAllowed: false});
	assert.strictEqual(w.service.permissions.openSessions, 0);
});

test('without a title the app id is shown', async t => {
	const w = world(t, {bus: {'com.webos.service.applicationmanager/getAppInfo': () => failed('unknown')}});
	await w.ask();
	assert.strictEqual(w.lastAlert().message, 'org.example.app wants to read the videos on this device.');
});

test('an empty title, or none, shows the app id too', async t => {
	for (const r of [{returnValue: true, appInfo: {title: ''}}, {returnValue: true, appInfo: {}}, {returnValue: true}]) {
		const w = world(t, {bus: {'com.webos.service.applicationmanager/getAppInfo': () => r}});
		await w.ask();
		assert.strictEqual(w.lastAlert().message, 'org.example.app wants to read the videos on this device.');
		w.stop();
		t.mock.timers.reset();
	}
});

test('a refused grant is not reported as allowed', async t => {
	const w = world(t, {bus: {'org.webosports.service.mediaindexer/grantRead': () => failed('denied')}});
	const a = await w.ask();
	await w.press('allow');
	assert.strictEqual(a.value.returnValue, false);
	assert.strictEqual(a.value.errorCode, -1);
	assert.ok(/^The media indexer could not grant access: /.test(a.value.errorText), a.value.errorText);
	assert.strictEqual(w.db.length, 0);
	await w.ask();
	assert.strictEqual(alerts(w), 2, 'free to ask again');
});

test('a grant that cannot be remembered is still allowed', async t => {
	const w = world(t, {dbWriteFails: true});
	const a = await w.ask();
	await w.press('allow');
	assert.deepStrictEqual(a.value, {returnValue: true, isAllowed: true});
});

test('a request still running after 180 s is answered 504, as mojoservice did', async t => {
	const w = world(t, {bus: {'org.webosports.service.mediaindexer/grantRead': () => undefined}});
	const a = await w.ask();
	await w.press('allow');
	t.mock.timers.tick(180000 - 1);
	await w.settle();
	assert.strictEqual(a.value, undefined);
	t.mock.timers.tick(1);
	await w.settle();
	assert.strictEqual(a.value.returnValue, false);
	assert.strictEqual(a.value.errorCode, 504);
	assert.strictEqual(a.value.errorText, 'commandTimeout in com.palm.mediapermissions/request');
});

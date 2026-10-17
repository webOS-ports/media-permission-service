/*jslint node: true */
// node tests/rules-test.js

var assert = require("assert");
var Rules = require("../service/javascript/rules.js");

var video = "com.palm.media.video.file:1", audio = "com.palm.media.audio.file:1";

// Application ids: what db8 can take as a caller, never a wildcard.
assert.strictEqual(Rules.isValidAppId("org.example.app"), true);
assert.strictEqual(Rules.isValidAppId("org.example-app_2"), true);
assert.strictEqual(Rules.isValidAppId(""), false);
assert.strictEqual(Rules.isValidAppId("*"), false);
assert.strictEqual(Rules.isValidAppId("org.example.*"), false);
assert.strictEqual(Rules.isValidAppId(".org"), false);
assert.strictEqual(Rules.isValidAppId("-org"), false);
assert.strictEqual(Rules.isValidAppId("org example"), false);
assert.strictEqual(Rules.isValidAppId(new Array(129).join("a")), true);
assert.strictEqual(Rules.isValidAppId(new Array(130).join("a")), false);
assert.strictEqual(Rules.isValidAppId(null), false);
assert.strictEqual(Rules.isValidAppId(42), false);

// The caller: the application id's first word, else the service name.
assert.strictEqual(Rules.callerAppId("org.example.app 1234", "x"), "org.example.app");
assert.strictEqual(Rules.callerAppId(null, "org.example.service"), "org.example.service");
assert.strictEqual(Rules.callerAppId(undefined, undefined), null);
assert.strictEqual(Rules.callerAppId("*", "org.example.service"), null);
assert.strictEqual(Rules.callerAppId("", "org.example.service"), "org.example.service");

// What may be asked for.
assert.deepStrictEqual(Rules.requestedKinds({ read: [video] }), { kinds: [video] });
assert.deepStrictEqual(Rules.requestedKinds({ read: [video, audio, video] }), { kinds: [video, audio] });
assert.ok(Rules.requestedKinds(undefined).error);
assert.ok(Rules.requestedKinds({}).error);
assert.ok(Rules.requestedKinds({ read: "com.palm.media.video.file:1" }).error);
assert.ok(Rules.requestedKinds({ read: [] }).error);
assert.ok(Rules.requestedKinds({ read: [video, 1] }).error);
assert.ok(Rules.requestedKinds({ read: ["com.palm.media.permissions:1"] }).error);
assert.ok(Rules.requestedKinds({ read: ["com.palm.media.anything:1"] }).error);
assert.ok(Rules.requestedKinds({ read: ["com.palm.contact:1"] }).error);
assert.ok(Rules.requestedKinds({ read: new Array(Rules.maxKinds + 2).join(video + ",").split(",").slice(0, Rules.maxKinds + 1) }).error);
Rules.grantableKinds.forEach(function (kind) {
    assert.deepStrictEqual(Rules.requestedKinds({ read: [kind] }), { kinds: [kind] });
});

// Static grants.
assert.strictEqual(Rules.permissionsFile(video), "/etc/palm/db/permissions/com.palm.media.video.file");
var entries = [
    { type: "db.kind", object: video, caller: "org.webosports.app.videoplayer", operations: { read: "allow" } },
    { type: "db.kind", object: video, caller: "org.example.*", operations: { read: "allow" } },
    { type: "db.kind", object: video, caller: "org.denied", operations: { read: "deny" } }
];
assert.strictEqual(Rules.readableBy(entries, "org.webosports.app.videoplayer", video), true);
assert.strictEqual(Rules.readableBy(entries, "org.webosports.app.videoplayer", audio), false);
assert.strictEqual(Rules.readableBy(entries, "org.example.one", video), true);
assert.strictEqual(Rules.readableBy(entries, "org.examples", video), false);
assert.strictEqual(Rules.readableBy(entries, "org.denied", video), false);
assert.strictEqual(Rules.readableBy(entries, "org.webosports.app.videoplayer2", video), false);
assert.strictEqual(Rules.readableBy(null, "org.webosports.app.videoplayer", video), false);
assert.strictEqual(Rules.readableBy([null, { type: "db.kind" }], "x", video), false);

// What is still to be asked.
assert.deepStrictEqual(Rules.missing([video], [video, audio]), [audio]);
assert.deepStrictEqual(Rules.missing(undefined, [video]), [video]);
assert.deepStrictEqual(Rules.missing([video, audio], [video]), []);

// Who may answer.
var shellExe = "/usr/bin/surface-manager";
assert.strictEqual(Rules.isShell("com.webos.surfacemanager", shellExe), true);
assert.strictEqual(Rules.isShell("com.webos.surfacemanager-cardshell", shellExe), true);
// The shell's name from another program (luna-send -m may take any name).
assert.strictEqual(Rules.isShell("com.webos.surfacemanager", "/usr/bin/luna-send"), false);
assert.strictEqual(Rules.isShell("com.webos.surfacemanager", ""), false);
assert.strictEqual(Rules.isShell("com.webos.surfacemanager", undefined), false);
assert.strictEqual(Rules.isShell("com.webos.surfacemanager", "/usr/bin/surface-manager2"), false);
// The shell's program under another name.
assert.strictEqual(Rules.isShell("org.example.app", shellExe), false);
assert.strictEqual(Rules.isShell("org.com.webos.surfacemanager", shellExe), false);
assert.strictEqual(Rules.isShell(null, shellExe), false);

assert.strictEqual(Rules.isAnswer("allow"), true);
assert.strictEqual(Rules.isAnswer("deny"), true);
assert.strictEqual(Rules.isAnswer("dismiss"), true);
assert.strictEqual(Rules.isAnswer(true), false);
assert.strictEqual(Rules.isAnswer("yes"), false);

// Quiet times after a "no".
var t0 = 1000000, refused;
refused = Rules.refuse(undefined, [video], "deny", t0);
assert.deepStrictEqual(refused, [{ kind: video, until: t0 + Rules.denyQuietMs }]);
assert.strictEqual(Rules.refusedRecently(refused, [video], t0 + Rules.denyQuietMs - 1), true);
assert.strictEqual(Rules.refusedRecently(refused, [video], t0 + Rules.denyQuietMs), false);
assert.strictEqual(Rules.refusedRecently(refused, [audio], t0), false);
assert.strictEqual(Rules.refusedRecently(refused, [audio, video], t0), true);
refused = Rules.refuse(refused, [video], "dismiss", t0);
assert.deepStrictEqual(refused, [{ kind: video, until: t0 + Rules.dismissQuietMs }]);
assert.ok(Rules.dismissQuietMs < Rules.denyQuietMs);
assert.deepStrictEqual(Rules.forget(refused, [video]), []);
assert.deepStrictEqual(Rules.forget(undefined, [video]), []);
assert.strictEqual(Rules.refusedRecently(undefined, [video], t0), false);
assert.strictEqual(Rules.refusedRecently([{ kind: video, until: "never" }], [video], t0), false);

// What the user reads.
assert.strictEqual(Rules.describe([video]), "videos");
assert.strictEqual(Rules.describe([audio, "com.palm.media.playlist.file:1"]), "music");
assert.strictEqual(Rules.describe([audio, video, "com.palm.media.image.file:1"]), "music, videos and pictures");
assert.strictEqual(Rules.describe(["com.palm.media.misc.file:1", video]), "documents and videos");

console.log("rules-test: all passed");

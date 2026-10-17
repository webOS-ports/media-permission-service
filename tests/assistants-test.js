/*jslint node: true */
// node tests/assistants-test.js
//
// Runs the service's sources as the service runner loads them, with the
// bus, db8 and the clock replaced, and walks each way a request can go.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var video = "com.palm.media.video.file:1", audio = "com.palm.media.audio.file:1";
var shell = { name: "com.webos.surfacemanager", exe: "/usr/bin/surface-manager" };
var DAY = 24 * 60 * 60 * 1000;

// The parts of Foundations' Future the service uses: each then() waits for
// a result, a callback that throws makes the exception the result, nest()
// passes another future's result on, and reading a failed result throws.
function Future() {
    this.queue = [];
    this.isset = false;
}
Object.defineProperty(Future.prototype, "result", {
    get: function () {
        if (this.exception) {
            throw this.exception;
        }
        return this.value;
    },
    set: function (value) {
        this.value = value;
        this.exception = undefined;
        this.isset = true;
        this.fire();
    }
});
Future.prototype.setException = function (e) {
    this.exception = e;
    this.isset = true;
    this.fire();
};
Future.prototype.getResult = function () {
    return this.result;
};
Future.prototype.then = function (fn) {
    this.queue.push(fn);
    this.fire();
    return this;
};
Future.prototype.nest = function (inner) {
    var self = this;
    inner.then(function (f) {
        try {
            self.result = f.result;
        } catch (e) {
            self.setException(e);
        }
    });
};
Future.prototype.fire = function () {
    var fn;
    while (this.isset && this.queue.length > 0 && !this.running) {
        fn = this.queue.shift();
        this.isset = false;
        this.running = true;
        try {
            fn(this);
        } catch (e) {
            this.running = false;
            this.setException(e);
            return;
        }
        this.running = false;
    }
};

function resolved(value) {
    var f = new Future();
    f.result = value;
    return f;
}

function failed(text) {
    var f = new Future();
    f.setException(new Error(text));
    return f;
}

// One service instance, with what it called recorded.
function load(options) {
    var root = path.join(__dirname, "..", "service"), sources, context, world;
    options = options || {};
    world = {
        calls: [],
        db: options.records || [],
        timers: [],
        logs: [],
        now: 1000000,
        nextId: 1
    };
    function call(uri, method, params) {
        var name = uri.replace(/^luna:\/\//, "") + "/" + method, handler = (options.bus || {})[name];
        world.calls.push({ name: name, params: plain(params) });
        if (handler) {
            return handler(params);
        }
        if (name === "com.webos.service.applicationmanager/getAppInfo") {
            return resolved({ returnValue: true, appInfo: { title: "Example" } });
        }
        if (name === "com.webos.notification/createAlert") {
            return resolved({ returnValue: true, alertId: "alert-1" });
        }
        return resolved({ returnValue: true });
    }
    context = {
        IMPORTS: {
            foundations: {
                Data: {
                    DB: {
                        find: function (query) {
                            var val = query.where[0].val;
                            world.calls.push({ name: "db/find", params: query });
                            return resolved({ returnValue: true, results: world.db.filter(function (r) {
                                return r.senderId === val;
                            }) });
                        },
                        put: function (objects) {
                            world.calls.push({ name: "db/put", params: plain(objects) });
                            if (options.dbWriteFails) {
                                return failed("db8 down");
                            }
                            objects.forEach(function (o) {
                                var copy = plain(o);
                                if (!copy._id) {
                                    copy._id = String(world.nextId++);
                                    o._id = copy._id;
                                }
                                world.db = world.db.filter(function (r) { return r._id !== copy._id; }).concat([copy]);
                            });
                            return resolved({ returnValue: true });
                        }
                    }
                },
                Control: { Future: Future },
                Err: {
                    create: function (code, text) {
                        var e = new Error(text);
                        e.errorCode = code;
                        return e;
                    }
                },
                Comms: { PalmCall: { call: call } }
            },
            // fs: the static db8 grants, from options.files {path: text}
            require: function (name) {
                if (name !== "fs") {
                    return require(name);
                }
                return {
                    readFileSync: function (file) {
                        var files = options.files || {};
                        if (!Object.prototype.hasOwnProperty.call(files, file)) {
                            throw new Error("ENOENT " + file);
                        }
                        return files[file];
                    }
                };
            }
        },
        console: { error: function (line) { world.logs.push(line); } },
        process: { on: function () { return undefined; } },
        setTimeout: function (fn, ms) {
            var t = { fn: fn, ms: ms, cleared: false };
            world.timers.push(t);
            return t;
        },
        clearTimeout: function (t) {
            if (t) {
                t.cleared = true;
            }
        },
        JSON: JSON,
        Date: { now: function () { return world.now; } }
    };
    vm.createContext(context);
    sources = JSON.parse(fs.readFileSync(path.join(root, "sources.json"), "utf8"));
    sources.forEach(function (entry) {
        if (entry.source) {
            vm.runInContext(fs.readFileSync(path.join(root, entry.source), "utf8"), context,
                            { filename: entry.source });
        }
    });
    world.context = context;
    return world;
}

// The sources run in their own context, with their own Object; compare
// copies made here.
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

// exe undefined: a palmbus without senderExePath()
function message(appId, serviceName, exe) {
    var m = {
        applicationID: function () { return appId; },
        senderServiceName: function () { return serviceName; }
    };
    if (exe !== undefined) {
        m.senderExePath = function () { return exe; };
    }
    return m;
}

function request(world, args, appId, serviceName) {
    var assistant = vm.runInContext("new RequestAssistant()", world.context), outer = new Future(), answer = {};
    assistant.controller = { args: args, message: message(appId, serviceName) };
    assistant.run(outer);
    outer.then(function (f) {
        try {
            answer.value = plain(f.result);
        } catch (e) {
            answer.value = { returnValue: false, errorText: e.message };
        }
    });
    return answer;
}

// from: {name, exe}
function respond(world, args, from) {
    var assistant = vm.runInContext("new ResponseAssistant()", world.context), outer = new Future(), answer = {};
    assistant.controller = { args: args, message: message(null, from.name, from.exe) };
    assistant.run(outer);
    outer.then(function (f) {
        try {
            answer.value = plain(f.result);
        } catch (e) {
            answer.value = { returnValue: false, errorText: e.message };
        }
    });
    return answer.value;
}

function named(world, name) {
    return world.calls.filter(function (c) { return c.name === name; });
}

function alertButtons(world) {
    var alerts = named(world, "com.webos.notification/createAlert"), alert = alerts[alerts.length - 1];
    assert.ok(alert, "the user was asked");
    return alert.params;
}


function ask(world, appId, kinds) {
    return request(world, { rights: { read: kinds || [video] } }, appId || "org.example.app");
}

function press(world, which) {
    var p = alertButtons(world);
    if (which === "close") {
        return respond(world, p.onclose.params, shell);
    }
    return respond(world, p.buttons[which === "allow" ? 1 : 0].params, shell);
}

// The indexer's static grants for videos: Videos may read them.
var videoGrants = JSON.stringify([
    { type: "db.kind", object: "com.palm.media.video.file:1", caller: "org.webosports.app.videoplayer",
      operations: { read: "allow" } },
    { type: "db.kind", object: "com.palm.media.video.file:1", caller: "org.webosports.app.preview.*",
      operations: { read: "allow" } },
    { type: "db.kind", object: "com.palm.media.audio.file:1", caller: "org.example.app",
      operations: { read: "allow" } },
    { type: "db.kind", object: "com.palm.media.video.file:1", caller: "org.example.writer",
      operations: { create: "allow" } }
]);
var staticFiles = { "/etc/palm/db/permissions/com.palm.media.video.file": videoGrants };

var tests = {
    "a built-in app with a static grant is allowed without asking": function () {
        var w = load({ files: staticFiles }), a = ask(w, "org.webosports.app.videoplayer");
        assert.deepStrictEqual(a.value, { returnValue: true, isAllowed: true });
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 0);
        assert.strictEqual(named(w, "org.webosports.service.mediaindexer/grantRead").length, 0);
        // a caller ending in "*" covers the ids it starts
        assert.deepStrictEqual(ask(w, "org.webosports.app.preview.one").value, { returnValue: true, isAllowed: true });
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 0);
    },
    "a static grant counts only for its kind, caller and read": function () {
        var w = load({ files: staticFiles });
        // org.example.app may read audio by a line in the video file: not videos
        ask(w, "org.example.app");
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 1);
        // create is not read
        ask(w, "org.example.writer");
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 2);
        // Videos is asked for what it was not granted
        ask(w, "org.webosports.app.videoplayer", [video, audio]);
        assert.strictEqual(alertButtons(w).message, "Example wants to read the music on this device.");
    },
    "an unreadable permissions file grants nothing": function () {
        var w = load({ files: { "/etc/palm/db/permissions/com.palm.media.video.file": "not json" } });
        ask(w, "org.webosports.app.videoplayer");
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 1);
    },
    "kinds that cannot be granted are refused without asking": function () {
        var w = load(), a = request(w, { rights: { read: ["com.palm.contact:1"] } }, "org.example.app");
        assert.strictEqual(a.value.returnValue, false);
        assert.ok(/Can not grant access/.test(a.value.errorText));
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 0);
    },
    "a caller without an id is refused": function () {
        var w = load(), a = request(w, { rights: { read: [video] } }, null, null);
        assert.strictEqual(a.value.returnValue, false);
        assert.strictEqual(w.calls.length, 0);
    },
    "a wildcard id is refused": function () {
        var w = load(), a = request(w, { rights: { read: [video] } }, "*", null);
        assert.strictEqual(a.value.returnValue, false);
        assert.strictEqual(w.calls.length, 0);
    },
    "what was allowed before is answered at once": function () {
        var w = load({ records: [{ _id: "1", senderId: "org.example.app", rights: { read: [video] } }] }),
            a = request(w, { rights: { read: [video] } }, "org.example.app 77");
        assert.deepStrictEqual(a.value, { returnValue: true, isAllowed: true });
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 0);
        assert.strictEqual(named(w, "org.webosports.service.mediaindexer/grantRead").length, 0);
    },
    "Allow grants through the indexer and remembers it": function () {
        var w = load(), a = ask(w), p, allow;
        p = alertButtons(w);
        assert.strictEqual(p.message, "Example wants to read the videos on this device.");
        assert.strictEqual(p.modal, true);
        assert.strictEqual(a.value, undefined, "no answer before the user's");
        allow = p.buttons[1];
        assert.strictEqual(allow.label, "Allow");
        assert.strictEqual(allow.buttonType, "ok", "drawn green");
        assert.strictEqual(p.buttons[0].buttonType, "cancel", "drawn red");
        assert.strictEqual(allow.onclick, "luna://com.palm.mediapermissions/permissionsResponse");
        assert.strictEqual(allow.params.answer, "allow");
        assert.deepStrictEqual(respond(w, allow.params, shell), { returnValue: true });
        assert.deepStrictEqual(a.value, { returnValue: true, isAllowed: true });
        assert.deepStrictEqual(named(w, "org.webosports.service.mediaindexer/grantRead")[0].params,
                               { appId: "org.example.app", kinds: [video] });
        assert.deepStrictEqual(w.db[0].rights, { read: [video] });
        assert.strictEqual(w.db[0].senderId, "org.example.app");
        // The shell closes the alert itself after a press.
        assert.strictEqual(named(w, "com.webos.notification/closeAlert").length, 0);
        assert.strictEqual(w.timers[0].cleared, true);
        // And the next request is answered without asking.
        assert.deepStrictEqual(ask(w).value, { returnValue: true, isAllowed: true });
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 1);
    },
    "a second kind is added to what was allowed before": function () {
        var w = load({ records: [{ _id: "1", senderId: "org.example.app", rights: { read: [video] } }] }),
            a = ask(w, "org.example.app", [video, audio]);
        assert.strictEqual(alertButtons(w).message, "Example wants to read the music on this device.");
        press(w, "allow");
        assert.deepStrictEqual(a.value, { returnValue: true, isAllowed: true });
        assert.deepStrictEqual(named(w, "org.webosports.service.mediaindexer/grantRead")[0].params.kinds, [audio]);
        assert.strictEqual(w.db.length, 1);
        assert.deepStrictEqual(w.db[0].rights.read, [video, audio]);
    },
    "Don't Allow grants nothing": function () {
        var w = load(), a = ask(w);
        assert.strictEqual(alertButtons(w).buttons[0].label, "Don't Allow");
        press(w, "deny");
        assert.deepStrictEqual(a.value, { returnValue: true, isAllowed: false });
        assert.strictEqual(named(w, "org.webosports.service.mediaindexer/grantRead").length, 0);
        assert.strictEqual(w.db[0].rights, undefined);
    },
    "after Don't Allow the app is not asked again for a day": function () {
        var w = load(), a;
        ask(w);
        press(w, "deny");
        w.now += DAY - 1;
        a = ask(w);
        assert.deepStrictEqual(a.value, { returnValue: true, isAllowed: false });
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 1);
        // Other kinds may still be asked for.
        ask(w, "org.example.app", [audio]);
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 2);
        press(w, "deny");
        // Another app is asked as usual.
        ask(w, "org.example.other");
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 3);
        press(w, "deny");
        w.now += 1;
        a = ask(w);
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 4, "asked again after a day");
        press(w, "allow");
        assert.strictEqual(a.value.isAllowed, true);
        assert.deepStrictEqual(w.db.filter(function (r) { return r.senderId === "org.example.app"; })[0].refused,
                               [{ kind: audio, until: 1000000 + DAY - 1 + DAY }]);
    },
    "closing the alert counts as no, quiet for ten minutes": function () {
        var w = load(), a = ask(w);
        press(w, "close");
        assert.deepStrictEqual(a.value, { returnValue: true, isAllowed: false });
        w.now += 10 * 60 * 1000 - 1;
        assert.deepStrictEqual(ask(w).value, { returnValue: true, isAllowed: false });
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 1);
        w.now += 1;
        ask(w);
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 2);
    },
    "one question per app at a time": function () {
        var w = load(), first = ask(w), second = ask(w), other;
        assert.strictEqual(second.value.returnValue, false);
        assert.ok(/already open/.test(second.value.errorText));
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 1);
        other = ask(w, "org.example.other");
        assert.strictEqual(other.value, undefined, "another app is asked");
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 2);
        respond(w, named(w, "com.webos.notification/createAlert")[0].params.buttons[1].params, shell);
        assert.strictEqual(first.value.isAllowed, true);
    },
    "only the shell's program under the shell's name may answer": function () {
        var w = load(), a = ask(w), allow;
        allow = alertButtons(w).buttons[1].params;
        assert.strictEqual(respond(w, allow, { name: "org.example.app", exe: shell.exe }).returnValue, false);
        assert.strictEqual(respond(w, allow, { name: null, exe: shell.exe }).returnValue, false);
        // luna-send -m com.webos.surfacemanager-x
        assert.strictEqual(respond(w, allow, { name: shell.name + "-x", exe: "/usr/bin/luna-send" }).returnValue, false);
        assert.strictEqual(respond(w, allow, { name: shell.name, exe: "" }).returnValue, false);
        // A palmbus that cannot tell the executable
        assert.strictEqual(respond(w, allow, { name: shell.name }).returnValue, false);
        assert.strictEqual(a.value, undefined);
        assert.strictEqual(named(w, "org.webosports.service.mediaindexer/grantRead").length, 0);
        respond(w, allow, shell);
        assert.strictEqual(a.value.isAllowed, true);
    },
    "an answer needs the question's token": function () {
        var w = load(), a = ask(w), allow;
        allow = alertButtons(w).buttons[1].params;
        assert.ok(/^[0-9a-f]{32}$/.test(allow.token));
        assert.strictEqual(respond(w, { sessionId: allow.sessionId, token: "0", answer: "allow" }, shell).returnValue, false);
        assert.strictEqual(respond(w, { sessionId: allow.sessionId, answer: "allow" }, shell).returnValue, false);
        assert.strictEqual(respond(w, { sessionId: "nope", token: allow.token, answer: "allow" }, shell).returnValue, false);
        assert.strictEqual(a.value, undefined);
        respond(w, allow, shell);
        assert.strictEqual(a.value.isAllowed, true);
        assert.strictEqual(respond(w, allow, shell).returnValue, false, "answered once only");
    },
    "an answer must be one of the three": function () {
        var w = load(), a = ask(w), p;
        p = alertButtons(w).buttons[1].params;
        assert.strictEqual(respond(w, { sessionId: p.sessionId, token: p.token, answer: true }, shell).returnValue, false);
        assert.strictEqual(respond(w, { sessionId: p.sessionId, token: p.token, allow: true }, shell).returnValue, false);
        assert.strictEqual(a.value, undefined);
    },
    "no answer in time counts as no and closes the alert": function () {
        var w = load(), a = ask(w), p;
        p = alertButtons(w).buttons[1].params;
        assert.strictEqual(w.timers.length, 1);
        assert.ok(w.timers[0].ms < 180000, "below the command timeout");
        w.timers[0].fn();
        assert.deepStrictEqual(a.value, { returnValue: true, isAllowed: false });
        assert.deepStrictEqual(named(w, "com.webos.notification/closeAlert")[0].params, { alertId: "alert-1" });
        assert.strictEqual(respond(w, p, shell).returnValue, false, "too late");
        assert.ok(w.db[0].refused[0].until === w.now + 10 * 60 * 1000);
    },
    "each question has its own session and token": function () {
        var w = load(), one, two;
        ask(w, "org.example.one");
        ask(w, "org.example.two");
        one = named(w, "com.webos.notification/createAlert")[0].params.buttons[1].params;
        two = named(w, "com.webos.notification/createAlert")[1].params.buttons[1].params;
        assert.notStrictEqual(one.sessionId, two.sessionId);
        assert.notStrictEqual(one.token, two.token);
        assert.strictEqual(respond(w, { sessionId: one.sessionId, token: two.token, answer: "allow" }, shell).returnValue, false);
    },
    "when the user cannot be asked the answer is no, and may be asked again": function () {
        var w = load({ bus: { "com.webos.notification/createAlert": function () { return failed("no shell"); } } }),
            a = ask(w);
        assert.deepStrictEqual(a.value, { returnValue: true, isAllowed: false });
        assert.strictEqual(named(w, "org.webosports.service.mediaindexer/grantRead").length, 0);
        assert.strictEqual(w.db.length, 0, "not remembered as a no");
        ask(w);
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 2);
    },
    "without a title the app id is shown": function () {
        var w = load({ bus: { "com.webos.service.applicationmanager/getAppInfo": function () { return failed("unknown"); } } });
        ask(w);
        assert.strictEqual(alertButtons(w).message, "org.example.app wants to read the videos on this device.");
    },
    "a refused grant is not reported as allowed": function () {
        var w = load({ bus: { "org.webosports.service.mediaindexer/grantRead": function () { return failed("denied"); } } }),
            a = ask(w);
        press(w, "allow");
        assert.strictEqual(a.value.returnValue, false);
        assert.ok(/media indexer could not grant/.test(a.value.errorText));
        assert.strictEqual(w.db.length, 0);
        ask(w);
        assert.strictEqual(named(w, "com.webos.notification/createAlert").length, 2, "free to ask again");
    },
    "a grant that cannot be remembered is still allowed": function () {
        var w = load({ dbWriteFails: true }), a = ask(w);
        press(w, "allow");
        assert.deepStrictEqual(a.value, { returnValue: true, isAllowed: true });
    }
};

var failures = 0;
Object.keys(tests).forEach(function (name) {
    try {
        tests[name]();
        console.log("ok   " + name);
    } catch (e) {
        failures += 1;
        console.log("FAIL " + name + "\n     " + (e.stack || e));
    }
});
console.log(failures ? failures + " failed" : "assistants-test: all passed");
process.exit(failures ? 1 : 0);

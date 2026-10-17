/*jslint sloppy: true, node: true, nomen: true */
/*global Foundations, Future, log, printObj, DB, PalmCall, Rules, IMPORTS */

/*
 * request: an application asks to read media kinds (the user's music,
 * pictures, videos and documents the media indexer lists). Every
 * application may ask; the user's answer is what decides.
 *
 *   luna://com.palm.mediapermissions/request
 *   {"rights": {"read": ["com.palm.media.video.file:1"]}}
 *   -> {"returnValue": true, "isAllowed": true|false}
 *
 * Kinds the application may read already, because the user allowed them
 * or db8's static grants list it (the built-in apps), are answered at once.
 * For the others the user is asked, in the system's alert
 * (com.webos.notification/createAlert, drawn by the shell); "Allow" makes the
 * media indexer, which owns the kinds and is the only one db8 lets change
 * who reads them, grant the application read access. The answers are kept
 * in com.palm.media.permissions:1.
 *
 * So that an application cannot keep putting the question to the user:
 * - it has at most one question open at a time; asking again meanwhile is
 *   refused;
 * - after "Don't Allow" it is answered "no" without asking for a day;
 * - after a question that was closed or not answered, for ten minutes.
 *
 * permissionsResponse: the shell's call when a button is pressed. Only the
 * shell may make it: the bus admits only holders of
 * mediapermissions-service.response, and the sender must have the shell's
 * name and run the shell's executable. It also needs the token of a
 * question still open.
 */

// Not "crypto": node 19 and later keep the WebCrypto object under that
// global name, and assigning to it is silently ignored in sloppy mode.
var nodeCrypto = IMPORTS.require("crypto");
var fs = IMPORTS.require("fs");

// How long the question stays open; then it counts as closed.
// Below the request's commandTimeout in services.json, so the caller hears
// "no" from here rather than a timeout from the framework.
var ASK_TIMEOUT_MS = 120000;

var sessions = {};

// The applications with a question open, by id.
var asking = {};

function call(uri, method, params) {
    return PalmCall.call(uri, method, params);
}

// The application's title, for the question; its id when there is none.
function appTitle(appId) {
    var future = call("luna://com.webos.service.applicationmanager", "getAppInfo", { id: appId }),
        outer = new Future();
    future.then(function () {
        var title = appId, r;
        try {
            r = future.result;
            if (r && r.appInfo && typeof r.appInfo.title === "string" && r.appInfo.title) {
                title = r.appInfo.title;
            }
        } catch (e) {
            log("No title for ", appId, ": ", printObj(e));
        }
        outer.result = { title: title };
    });
    return outer;
}

function closeAlert(alertId) {
    if (alertId) {
        call("luna://com.webos.notification", "closeAlert", { alertId: alertId }).then(function (f) {
            try {
                return f.result;
            } catch (e) {
                log("Could not close the question: ", printObj(e));
                return undefined;
            }
        });
    }
}

// answer: "allow", "deny", "dismiss" or "failed"
function finishSession(sessionId, answer) {
    var session = sessions[sessionId];
    if (!session) {
        return false;
    }
    delete sessions[sessionId];
    clearTimeout(session.timer);
    // The shell closes the alert when a button is pressed; one still up
    // after a timeout would take a press that no longer counts.
    if (answer === "dismiss") {
        closeAlert(session.alertId);
    }
    session.future.result = { answer: answer };
    return true;
}

// Asks the user; the future gets {answer: "allow"|"deny"|"dismiss"}, or
// {answer: "failed"} when the user could not be asked.
function askUser(appId, kinds) {
    var outer = new Future(), sessionId = nodeCrypto.randomBytes(8).toString("hex"),
        token = nodeCrypto.randomBytes(16).toString("hex"), titleFuture = appTitle(appId);

    sessions[sessionId] = { token: token, future: outer, alertId: null };
    sessions[sessionId].timer = setTimeout(function () {
        log("No answer for ", appId, " in time; not allowed.");
        finishSession(sessionId, "dismiss");
    }, ASK_TIMEOUT_MS);

    titleFuture.then(function () {
        var title = titleFuture.result.title, alertFuture, params = function (answer) {
            return { sessionId: sessionId, token: token, answer: answer };
        };
        alertFuture = call("luna://com.webos.notification", "createAlert", {
            title: "Media access",
            message: title + " wants to read the " + Rules.describe(kinds) + " on this device.",
            modal: true,
            // buttonType: the shell draws "cancel" red and "ok" green
            buttons: [
                { label: "Don't Allow", buttonType: "cancel", focus: true,
                  onclick: "luna://com.palm.mediapermissions/permissionsResponse", params: params("deny") },
                { label: "Allow", buttonType: "ok",
                  onclick: "luna://com.palm.mediapermissions/permissionsResponse", params: params("allow") }
            ],
            onclose: { uri: "luna://com.palm.mediapermissions/permissionsResponse", params: params("dismiss") }
        });
        alertFuture.then(function () {
            var r;
            try {
                r = alertFuture.result;
                if (sessions[sessionId]) {
                    sessions[sessionId].alertId = r.alertId;
                } else {
                    closeAlert(r.alertId);
                }
            } catch (e) {
                log("Could not ask the user: ", printObj(e));
                finishSession(sessionId, "failed");
            }
        });
    });

    return outer;
}

// Of kinds, those db8's static grants already let appId read: the
// built-in apps are never asked.
function readableAlready(appId, kinds) {
    return kinds.filter(function (kind) {
        var entries;
        try {
            entries = JSON.parse(fs.readFileSync(Rules.permissionsFile(kind), "utf8"));
        } catch (e) {
            return false;
        }
        return Rules.readableBy(entries, appId, kind);
    });
}

function remember(record) {
    DB.put([record]).then(function (f) {
        try {
            return f.result;
        } catch (e) {
            log("Could not remember the answer: ", printObj(e));
            return undefined;
        }
    });
}

var RequestAssistant = function () {};

RequestAssistant.prototype.run = function (outerfuture) {
    var args = this.controller.args, message = this.controller.message, appId, wanted, record,
        future, granted = [], missing;

    // The framework answers {returnValue: false, errorCode, errorText}
    function fail(reason) {
        log("Request refused: ", reason);
        outerfuture.setException(Foundations.Err.create(-1, reason));
        return outerfuture;
    }

    appId = Rules.callerAppId(message.applicationID && message.applicationID(),
                              message.senderServiceName && message.senderServiceName());
    if (!appId) {
        return fail("Could not tell which application is asking.");
    }
    wanted = Rules.requestedKinds(args && args.rights);
    if (wanted.error) {
        return fail(wanted.error);
    }
    wanted = wanted.kinds;

    future = DB.find({ from: "com.palm.media.permissions:1", where: [{ prop: "senderId", op: "=", val: appId }] }, false, false);

    future.then(function lookedUp() {
        var r;
        try {
            r = future.result;
            if (r.returnValue === true && r.results.length > 0) {
                record = r.results[0];
                granted = record.rights && Array.isArray(record.rights.read) ? record.rights.read : [];
            }
        } catch (e) {
            log("Could not read the answers given before: ", printObj(e));
        }
        if (!record) {
            record = { _kind: "com.palm.media.permissions:1", senderId: appId };
        }
        missing = Rules.missing(granted.concat(readableAlready(appId, wanted)), wanted);
        if (missing.length === 0) {
            outerfuture.result = { returnValue: true, isAllowed: true };
            return;
        }
        if (Rules.refusedRecently(record.refused, missing, Date.now())) {
            outerfuture.result = { returnValue: true, isAllowed: false };
            return;
        }
        if (asking[appId]) {
            fail("A question for this application is already open.");
            return;
        }
        asking[appId] = true;
        future.nest(askUser(appId, missing));
    });

    future.then(function answered() {
        var answer = future.result.answer;
        delete asking[appId];
        if (answer === "allow") {
            future.nest(call("luna://org.webosports.service.mediaindexer", "grantRead", { appId: appId, kinds: missing }));
            return;
        }
        if (answer === "deny" || answer === "dismiss") {
            record.refused = Rules.refuse(record.refused, missing, answer, Date.now());
            remember(record);
        }
        outerfuture.result = { returnValue: true, isAllowed: false };
    });

    future.then(function grantedByIndexer() {
        try {
            future.getResult();
        } catch (e) {
            fail("The media indexer could not grant access: " + printObj(e));
            return;
        }
        record.rights = { read: granted.concat(missing) };
        record.refused = Rules.forget(record.refused, missing);
        future.nest(DB.put([record]));
    });

    future.then(function remembered() {
        try {
            future.getResult();
        } catch (e) {
            // Granted all the same; db8 keeps the grant itself.
            log("Could not remember the answer: ", printObj(e));
        }
        outerfuture.result = { returnValue: true, isAllowed: true };
    });

    return outerfuture;
};

var ResponseAssistant = function () {};

ResponseAssistant.prototype.run = function (outerfuture) {
    var args = this.controller.args || {}, message = this.controller.message, session,
        sender = message.senderServiceName && message.senderServiceName(),
        // Absent from a palmbus without senderExePath(): then nobody passes.
        exe = message.senderExePath && message.senderExePath();

    if (!Rules.isShell(sender, exe)) {
        log("permissionsResponse refused from ", sender, " (", exe, ")");
        outerfuture.setException(Foundations.Err.create(-1, "Only the system shell may answer."));
        return outerfuture;
    }
    session = typeof args.sessionId === "string" ? sessions[args.sessionId] : undefined;
    if (!session || typeof args.token !== "string" || args.token !== session.token ||
            !Rules.isAnswer(args.answer)) {
        outerfuture.setException(Foundations.Err.create(-1, "No such question."));
        return outerfuture;
    }
    finishSession(args.sessionId, args.answer);
    outerfuture.result = { returnValue: true };
    return outerfuture;
};

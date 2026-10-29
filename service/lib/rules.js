// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

// What may be asked for and who may answer: plain functions over plain
// values, loaded by the service and by the tests (tests/rules.test.js).

'use strict';

var Rules = {
    // The media kinds the indexer owns and can grant read access to
    // (org.webosports.service.mediaindexer/grantRead takes the same list).
    grantableKinds: [
        "com.palm.media.audio.file:1",
        "com.palm.media.audio.album:1",
        "com.palm.media.audio.artist:1",
        "com.palm.media.audio.genre:1",
        "com.palm.media.image.file:1",
        "com.palm.media.image.album:1",
        "com.palm.media.misc.file:1",
        "com.palm.media.playlist.file:1",
        "com.palm.media.video.file:1"
    ],

    // More than there are media kinds: a longer list is not a real request.
    maxKinds: 16,

    // An application id db8 can take as a caller. No "*": db8 reads it as
    // a wildcard, and a grant to it would reach every application.
    isValidAppId: function (appId) {
        return typeof appId === "string" && appId.length > 0 && appId.length <= 128 &&
            /^[A-Za-z0-9_][A-Za-z0-9._\-]*$/.test(appId);
    },

    // The caller's application id: the first word of what the bus gives as
    // its application id (web apps carry their process id after it), or
    // its service name. Null when neither is a valid id.
    callerAppId: function (applicationId, serviceName) {
        var id = typeof applicationId === "string" ? applicationId.split(" ")[0] : "";
        if (!id && typeof serviceName === "string") {
            id = serviceName;
        }
        return Rules.isValidAppId(id) ? id : null;
    },

    // The kinds asked for, without repeats, or a reason they cannot be.
    // { kinds: [...] } or { error: "..." }
    requestedKinds: function (rights) {
        var i, kind, kinds = [];
        if (!rights || typeof rights !== "object" || !Array.isArray(rights.read)) {
            return { error: "rights.read must be a list of media kinds" };
        }
        if (rights.read.length === 0 || rights.read.length > Rules.maxKinds) {
            return { error: "rights.read must hold 1 to " + Rules.maxKinds + " media kinds" };
        }
        for (i = 0; i < rights.read.length; i += 1) {
            kind = rights.read[i];
            if (typeof kind !== "string" || Rules.grantableKinds.indexOf(kind) < 0) {
                return { error: "Can not grant access to " + String(kind) };
            }
            if (kinds.indexOf(kind) < 0) {
                kinds.push(kind);
            }
        }
        return { kinds: kinds };
    },

    // The static grants db8 loads at start: the media indexer installs one
    // file per kind here, named after the kind without its version, listing
    // who may read it (the built-in apps among them).
    permissionsDir: "/etc/palm/db/permissions",

    permissionsFile: function (kind) {
        return Rules.permissionsDir + "/" + kind.replace(/:[0-9]+$/, "");
    },

    // Whether entries (a db8 permissions file, parsed) let appId read kind.
    // db8 takes a trailing "*" in a caller as a wildcard.
    readableBy: function (entries, appId, kind) {
        if (!Array.isArray(entries)) {
            return false;
        }
        return entries.some(function (e) {
            var caller = e && e.caller;
            if (!e || e.type !== "db.kind" || e.object !== kind || typeof caller !== "string" ||
                    !e.operations || e.operations.read !== "allow") {
                return false;
            }
            if (caller.charAt(caller.length - 1) === "*") {
                return appId.indexOf(caller.slice(0, -1)) === 0;
            }
            return caller === appId;
        });
    },

    // Of wanted, those not in granted.
    missing: function (granted, wanted) {
        var have = Array.isArray(granted) ? granted : [];
        return wanted.filter(function (kind) {
            return have.indexOf(kind) < 0;
        });
    },

    // The system shell, which draws the question and calls back when the
    // user presses a button: its bus name, and the program the hub found
    // running behind it. A privileged tool may take any name, so the name
    // alone does not tell.
    shellNamePrefix: "com.webos.surfacemanager",
    shellExePath: "/usr/bin/surface-manager",

    isShell: function (serviceName, exePath) {
        return typeof serviceName === "string" && serviceName.indexOf(Rules.shellNamePrefix) === 0 &&
            exePath === Rules.shellExePath;
    },

    isAnswer: function (answer) {
        return answer === "allow" || answer === "deny" || answer === "dismiss";
    },

    // How long an application is answered "no" without asking again:
    // after "Don't Allow" a day, after a closed or unanswered question
    // ten minutes.
    denyQuietMs: 24 * 60 * 60 * 1000,
    dismissQuietMs: 10 * 60 * 1000,

    // refused: [{kind, until}] as kept in the application's record.
    // Whether any of kinds is still in its quiet time at now.
    refusedRecently: function (refused, kinds, now) {
        if (!Array.isArray(refused)) {
            return false;
        }
        return refused.some(function (r) {
            return r && kinds.indexOf(r.kind) >= 0 && typeof r.until === "number" && r.until > now;
        });
    },

    // refused with kinds quiet until now plus the time for answer.
    refuse: function (refused, kinds, answer, now) {
        var until = now + (answer === "deny" ? Rules.denyQuietMs : Rules.dismissQuietMs);
        return Rules.forget(refused, kinds).concat(kinds.map(function (kind) {
            return { kind: kind, until: until };
        }));
    },

    // refused without kinds.
    forget: function (refused, kinds) {
        if (!Array.isArray(refused)) {
            return [];
        }
        return refused.filter(function (r) {
            return r && kinds.indexOf(r.kind) < 0;
        });
    },

    // What the user is asked: which of their things the app wants to read.
    describe: function (kinds) {
        var names = [], add = function (name) {
            if (names.indexOf(name) < 0) {
                names.push(name);
            }
        };
        kinds.forEach(function (kind) {
            if (kind.indexOf("com.palm.media.audio.") === 0 || kind === "com.palm.media.playlist.file:1") {
                add("music");
            } else if (kind.indexOf("com.palm.media.image.") === 0) {
                add("pictures");
            } else if (kind === "com.palm.media.video.file:1") {
                add("videos");
            } else if (kind === "com.palm.media.misc.file:1") {
                add("documents");
            }
        });
        if (names.length <= 1) {
            return names.join("");
        }
        return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
    }
};

module.exports = Rules;

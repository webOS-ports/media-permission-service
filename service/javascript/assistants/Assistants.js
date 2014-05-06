/*jslint sloppy: true, node: true, nomen: true */
/*global Future, debug, log, printObj, DB, PalmCall */

// some auxilliary functions
function getAppId(controller) {
    "use strict";
    var appId = controller.message.applicationID().split(" ")[0];
    if (!appId) {
        appId = controller.message.senderServiceName();
    }

    debug("AppId ", appId, " from ", controller.message.applicationID(), " && ", controller.message.senderServiceName());

    return appId;
}

function getRequiredRightsFromArrays(granted, requested) {
    var i, j, found, required = [];
    for (i = 0; i < requested.length; i += 1) {
        found = false;
        for (j = 0; j < granted.length; j += 1) {
            if (requested[i] === granted[j]) {
                found = true;
                break;
            }
        }

        if (!found) {
            required.push(requested[i]);
        }
    }

    return required;
}

function getRequiredRights(granted, requested) {
    var key, result = {};
    for (key in requested) {
        if (requested.hasOwnProperty(key)) {
            if (granted[key]) {
                result[key] = getRequiredRightsFromArrays(granted[key], requested[key]);
            }
        }
    }

    //found everything.
    return result;
}

//adds permissions for all requested kinds.
//if one call fails, it will abort and return falsy.
//If all calls succeed, it will return truthy.
function addPermissions(appId, kinds, index) {
    if (!index) {
        index = 0;
    }
    if (index >= kinds.read.length) {
        return new Future({returnValue: true});
    }
    if (!kinds[index]) {
        return addPermissions(appId, kinds, index + 1);
    }

    var future = PalmCall.call("palm://com.palm.db", "putPermissions", {
        permissions: [{
            type: 'db.kind',
            object: kinds.read[index],
            caller: appId,
            operations: {read: 'allow'}
        }]
    });

    future.then(function palmCallCB() {
        try {
            var result = future.result;

            if (result.returnValue === true) {
                future.nest(addPermissions(appId, kinds, index + 1));
            } else {
                throw "putPermissions failed. " + JSON.stringify(result);
            }
        } catch (e) {
            log("Error in putPermissions: ", e);
            future.result = { returnValue: false };
        }
    });

    return future;
}

var currentMaxId = 0;
var sessions = [];

function callUI(appId, rights) {
    var uiFuture = PalmCall.call("palm://org.webosports.luna", "publishToSystemUI", {
        event: "mediaFilePermissionRequest",
        message: {
            action: 'requestPermission',
            rights: rights,
            senderId: appId,
            sessionId: currentMaxId,
            replyTo: 'palm://com.palm.mediapermission/permissionsResponse'
        }
    }), outerFuture = new Future(), id = currentMaxId;

    sessions[id] = {
        appId: appId,
        rights: rights,
        future: outerFuture
    };

    uiFuture.then(function uiCallback() {
        try {
            var result = uiFuture.result;

            //ok, what do we get from the request?? Don't really know.. hm.
            //lets print and wait for response.
            log("Result from publishToSystemUI call: ", result);

        } catch (e) {
            log("Error in UI call: ", e);
            log("Waiking up request call with error.");
            
            //work around for not yet existing UI part:
            if (e.response && e.response.errorText && e.response.errorText.indexOf("Unknown method") === 0) {
                log("UI Part not yet finished, emulating truthy result.");
                PalmCall.call("palm://com.palm.mediapermissions", "permissionsResponse", {sessionId: id});
            } else {
                outerFuture.result = {returnValue: false};
            }
        }
    });

    currentMaxId += 1;
    return outerFuture;
}

/* RequestAssistant reacts to requests from the app
 * If the UI is involved, responseAssistant is required, too.
 * This will halt and wait until the UI calls the responseAssistant
 * which then releases the request assistant to continue it's quest.
 */
var RequestAssistant = function () {};

RequestAssistant.prototype.run = function (outerfuture) {
	var args = this.controller.args, future, appId, query, requiredRights, dbObj;

    appId = getAppId(this.controller);
    if (!appId) {
        outerfuture.result = {returnValue: false, isAllowed: false, reason: "Could not determine appId."};
        return outerfuture;
    }

    if (!args.rights || !args.rights.read || !args.rights.read.length) { //kind of hack here, just check for length field in array.
                                                                         //rejects empty arrays, too, but I think that's fine.
        outerfuture.result = {returnValue: false, isAllowed: false, reason: "Require rights parameter with member read as string array containing kinds to request read access to."};
        return outerfuture;
    }

    query = {
        from: "com.palm.media.permissions:1",
        where: [
            {
                prop: "senderId",
                op: "=",
                val: appId
            }
        ]
    };

    future = DB.find(query, false, false);

    future.then(function dbCallback() {
        try {
            var result = future.result;
            if (result.returnValue === true) {
                if (result.results.length === 1) {
                    dbObj = result.results[0];
                    future.result = {returnValue: true, rights: result.results[0].rights};
                } else {
                    throw "No or too many permissions for appId " + appId;
                }
            } else {
                throw "DB lookup not successful " + printObj(future.exception);
            }

        } catch (e) {
            log("Could not get permissions from db. Reason: ", e);
            log("Continuing execution without lookup.");
            dbObj = {senderId: appId, _kind: "com.palm.media.permissions:1"};
            future.result = { returnValue: false };
        }
    });

    future.then(function parseRights() {
        var result = future.result;
        //check if rights are already granted.
        if (result.returnValue) {
            requiredRights = getRequiredRights(result.rights, args.rights);
            if (requiredRights.read.length === 0) {
                log("All requested rights already granted.");
                outerfuture.result = { returnValue: true, isAllowed: true };
            } else {
                future.nest(callUI(appId, {read: requiredRights})); //this will block until ResponseAssistant is called with right id.
                dbObj.rights = {read: result.rights.read.concat(requiredRights.read)};
            }
        } else {
            requiredRights = args.rights;
            dbObj.rights = args.rights;
            future.nest(callUI(appId, args.rights)); //this will block until ResponseAssistant is called with right id.
        }
    });

    future.then(function systemUICB() {
        try {
            var result = future.result;
            if (result.returnValue === true) {
                //ok, now add permissions for all requested kinds.
                future.nest(addPermissions(appId, requiredRights));
            } else {
                throw result.reason || "User denied access.";
            }
        } catch (e) {
            log("Asking user for permission failed: ", e);
            outerfuture.result = {returnValue: false, isAllowed: false, reason: JSON.stringify(e)};
        }
    });

    future.then(function permissionsCB() {
        try {
            var result = future.result;
            if (result.returnValue === true) {
                //ok, all permissions where set ok. Continue. :)
                future.nest(DB.merge([dbObj]));
            } else {
                throw "Setting permissions failed: " + JSON.stringify(result);
            }
        } catch (e) {
            log("Error during setting permissions", e);
            outerfuture.result = {returnValue: false, isAllowed: false, reason: JSON.stringify(e)};
        }
    });

    future.then(function dbCB() {
        try {
            var result = future.result;
            if (result.returnValue === true) {
                outerfuture.result = {returnValue: true, isAllowed: true }; //finally. :)
            } else {
                throw "Something went wrong: " + JSON.stringify(result);
            }
        } catch (e) {
            log("Error during remembering permissions: ", e);
            outerfuture.result = {returnValue: false, isAllowed: false, reason: JSON.stringify(e)};
        }
    });

	return outerfuture;
};

RequestAssistant.prototype.quit = function () {
    var key;
    log("Service will be killed because it idled too long. Abort pending sessions with error message.");
    for (key in sessions) {
        if (sessions.hasOwnProperty(key) && sessions[key].future) {
            sessions[key].future.result = { returnValue: false, reason: "Idle timeout."};
        }
    }
};

var ResponseAssistant = function () {};

ResponseAssistant.prototype.run = function (outerfuture) {
	var args = this.controller.args, sessionId, obj;

    sessionId = args.sessionId;

    obj = sessions[sessionId];
    delete sessions[sessionId];
    if (obj) {
        obj.future.result = { returnValue: true, isAllowed: args.isSenderPermitted };
    } else {
        log("Error: No session for ", sessionId, " stored. Can't continue.");
    }

    outerfuture.result = { returnValue: true };
    return outerfuture;
};

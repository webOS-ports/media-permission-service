/*jslint sloppy: true */
/*global IMPORTS, console, require:true, process */
console.error("Starting to load libraries");

//... Load the Foundations library and create
//... short-hand references to some of its components.
var Foundations = IMPORTS.foundations;
var DB = Foundations.Data.DB;
var Future = Foundations.Control.Future;
var PalmCall = Foundations.Comms.PalmCall;

console.error("--------->Loaded Libraries OK1");

var dummy = function () {};

var printObj = function (obj, depth) {
    var key, msg = "{";
    if (depth < 5) {
        for (key in obj) {
            if (obj.hasOwnProperty(key)) {
                try {
                    msg += " " + key + ": " + JSON.stringify(obj[key]) + ",";
                } catch (e) {
                    msg += " " + key + ": " + printObj(obj[key], depth + 1) + ",";
                }
            }
        }
        msg[msg.length - 1] = "}";
    } else {
        msg = "...";
    }
    return msg;
};

var logBase = function () {
    var i, pos, datum, argsArr = Array.prototype.slice.call(arguments, 0),
        data;

    for (i = 0; i < argsArr.length; i += 1) {
        if (typeof argsArr[i] !== "string") {
            try {
                argsArr[i] = JSON.stringify(argsArr[i]);
            } catch (e) {
                argsArr[i] = printObj(argsArr[i], 0);
            }
        }
    }

    data = argsArr.join(" ");

    // I want ALL my logs!
    data = data.split("\n");
    for (i = 0; i < data.length; i += 1) {
        datum = data[i];
        if (datum.length < 500) {
            console.error(datum);
        } else {
            // Do our own wrapping
            for (pos = 0; pos < datum.length; pos += 500) {
                console.error(datum.slice(pos, pos + 500));
            }
        }
    }
};

var log = logBase;

/* Simple debug function to print out to console error, error because other stuff does not show up in sys logs.. */
var debug = log;

process.on("uncaughtException", function (e) {
	log("Uncaought error:" + e.stack);
	//throw e;
});


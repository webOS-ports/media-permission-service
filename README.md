Summary
=======

Node.js service to ask for permission to media indexer database.

The service is plain Node 22, for the launcher's plain-node path
(`run-js-service` requires `service/`, as it has a `package.json`, and calls
`run()`). It used to run on mojoservice and the Foundations library; neither
is loaded any more. The old `sources.json` also loaded globalization, but
nothing used it: the question's text was, and is, English.

| | |
|---|---|
| `service/service.js` | start-up: the bus, the two methods and their timeouts |
| `service/lib/permissions.js` | `request` and `permissionsResponse` |
| `service/lib/rules.js` | what may be asked for, who may answer, the quiet times, the question's wording |
| `service/lib/mojo.js` | replies and errors as mojoservice gave them |
| `service/lib/palmcall.js` | bus calls failing as Foundations' `PalmCall` failed |
| `service/lib/bus.js`, `errors.js` | the luna bus through palmbus, from the messaging service by way of the contacts linker |

How it works
============

An application that wants to read the user's media (the
`com.palm.media.*` kinds the media indexer fills) asks:

    luna://com.palm.mediapermissions/request
    {"rights": {"read": ["com.palm.media.video.file:1"]}}

and gets `{"returnValue": true, "isAllowed": true}` or `false`.

Every application may ask. It does not need to list anything in
`requiredPermissions`; the user's answer is the gate.

- Kinds the application can already read are answered at once, without
  asking: those the user allowed before (kept in db8, in
  `com.palm.media.permissions:1`), and those db8's static grants give it.
  The built-in apps are granted statically: Videos
  (`org.webosports.app.videoplayer`), Documents (`org.webosports.app.documents`),
  Sound Recorder (`org.webosports.app.soundrecorder`) and the PDF Viewer
  (`org.webosports.app.pdf`), among others. That list is the media indexer's
  `files/db8/permissions/`, installed in `/etc/palm/db/permissions/`, one file
  per kind.
- For other kinds the user is asked in a system alert
  (`com.webos.notification/createAlert`, drawn by the shell). "Don't
  Allow", closing the alert, or no answer within two minutes all count as
  no.
- When the user allows, the service calls
  `org.webosports.service.mediaindexer/grantRead`. The media indexer owns
  the kinds, and db8 only lets a kind's owner change who may read it, so
  the indexer applies the grant. Only this service may call `grantRead`.

An application cannot keep putting the question to the user:

- it has one question open at a time; asking again meanwhile returns an
  error;
- after "Don't Allow" it is answered no, without asking, for a day;
- after a question that was closed or not answered, for ten minutes.

Only the kinds in `service/lib/rules.js` can be asked for.

Only the shell may answer. `permissionsResponse` is in its own `oem` group,
which only the shell holds. The service also checks that the sender has
the shell's bus name and runs the shell's executable
(`/usr/bin/surface-manager`), as recorded by the hub. A privileged tool can
take the shell's name, but not its executable. Each question also has its
own random token.

The executable check needs `senderExePath()` on palmbus messages
(nodejs-module-webos-sysbus). The hub only gives a sender's executable to
privileged services, so the service's role is `privileged`. Without either,
no answer is accepted.

The buttons use notificationmgr's `buttonType`: the shell draws "cancel"
(Don't Allow) red and "ok" (Allow) green.

The rewrite
===========

The first Node version makes the same decisions, the same calls with the
same arguments and gives the same replies as the mojoservice service,
including its bugs. That was checked by an A/B test: the old service run
unchanged on the host, on the frameworks of a LuneOS VM, next to the new
one, on generated scenarios and on every caller, kind list and ending,
comparing every reply, every bus call and db8 after each step. The bugs
are mended one commit at a time after that, each with its own test; the
code, tests and commits refer to them by these numbers:

- B1: when the media indexer refused a grant, the error text was the old
  `printObj()` of the error: its `errorCode`, `innerError: undefined`,
  `toString: undefined` and the indexer's reply, without the reason and
  with the brace never closed. Mended: the text ends in the indexer's
  reason.
- B2: an application's question counted as open only until the user
  answered, not until the answer was applied. A request in between read
  the answers kept from before the grant or the "Don't Allow" was written,
  so it could put the question again at once, and, for an application with
  no record yet, write a second record for it; only one of the two was read
  after that, so it was asked again for kinds it had been granted.
  Mended: the question stays open until the grant and the answer are
  written; those two calls now give up after a minute, so that one that
  never returns cannot keep it open for good (the old service waited
  without end, and answered 504 after 180 s).
- B3: when db8 could not be read, the request went on as if the user had
  never answered: an application told "no" for a day was asked again, and
  the answer was written as a second record. Mended: the request fails,
  "Could not read the answers given before.", and nobody is asked.
- B4: a question the user was never shown counted as closed. When the
  application manager or the notification manager did not answer within
  the two minutes, the application was told "no" for ten minutes without a
  question having appeared; and when the application's title came in
  later, the alert was put up after the request had been answered, and
  taken down again.

These things deliberately differ from the old service:

- mojoservice made an activity for every call (activitymanager/create
  `request_<n>`, completed with the reply), and took on an `$activity` a
  call brought. Nothing calls this service with one, and its own work needs
  none, so neither is done.
- mojoservice's `__info`, `__quit` and `__gc` methods are gone; `bus.js`
  answers `info` and `quit`, as in the messaging service and the linker.
- It quits 30 s after its last call is done, as `activityTimeout` made
  mojoservice do.

Tests
=====

    tests/run.sh

This runs the unit tests (`node --test tests/*.test.js`) over the service on a
stand-in bus with db8 in memory and the test's clock, then jshint (set
`JSHINT` if it is not on the path) and a parse of every module. They run on
the build host with plain node.

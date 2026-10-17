Summary
=======

Node.js service to ask for permission to media indexer database.

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

Only the kinds in `service/javascript/rules.js` can be asked for.

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

Tests
=====

    node tests/rules-test.js
    node tests/assistants-test.js

These run on the build host with plain node. The second one loads the
service's sources with the bus, db8 and the clock replaced by fakes.

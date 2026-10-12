#!/usr/bin/env bash
# Runs a command that needs a display. On Linux that means a private D-Bus session (single instance,
# accessibility bus) and a virtual X server; on macOS and Windows the runner session already has both.
if [ "$(uname -s)" = Linux ]; then
  exec dbus-run-session -- xvfb-run -a "$@"
fi
exec "$@"

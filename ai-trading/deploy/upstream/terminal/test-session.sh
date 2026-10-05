#!/bin/sh
# Checks the tmux session names that session.sh derives from the signed-in user.
# Run: sh ai-trading/deploy/upstream/terminal/test-session.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
status=0

check() {
  actual=$(sh "$here/session.sh" --print-name "$1")
  if [ "$actual" = "$2" ]; then
    echo "ok   '$1' -> $actual"
  else
    echo "FAIL '$1' -> $actual (want $2)"
    status=1
  fi
}

check "Toby.Tran@Example.com" "toby-tran-example-com"
check "alice@example.com" "alice-example-com"
check "bob@example.com" "bob-example-com"
check "" "default"
check "---" "default"
# shellcheck disable=SC2016 # literal on purpose: hostile input must stay unexpanded
check '$(reboot);rm -rf /' "--reboot--rm--rf--"
check "averyveryverylongemailaddress@example.com" "averyveryverylongemailaddress-ex"
exit "$status"

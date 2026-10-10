"""Exercise the installed launcher with real tmux and offline dummy apps."""

import os
import pty
import select
import signal
import subprocess
import tempfile
import time
from pathlib import Path


def check_lifecycle(app_status, interrupt=False, raw_terminal=False):
    with tempfile.TemporaryDirectory(prefix="terminal-lifecycle-") as directory:
        directory = Path(directory)
        runs = directory / "runs"
        child_pid = directory / "child-pid"
        app = directory / "dummy app"
        app.write_text(
            '#!/bin/sh\n'
            'if [ "$TEST_RAW_TERMINAL" = 1 ]; then stty raw -echo; fi\n'
            'echo $$ > "$TEST_CHILD_PID_FILE"\n'
            'echo started >> "$TEST_RUNS_FILE"\n'
            'printf "DUMMY_REPORT_%s\\n" "$(wc -l < "$TEST_RUNS_FILE")"\n'
            'if [ "$TEST_INTERRUPT" = 1 ]; then exec sleep 30; fi\n'
            'exit "$TEST_APP_STATUS"\n'
        )
        app.chmod(0o755)
        env = {
            **os.environ,
            "APP_COMMAND": str(app),
            "TTYD_USER": "lifecycle@example.test",
            "TMUX_TMPDIR": str(directory),
            "TERM": "xterm-256color",
            "TEST_RUNS_FILE": str(runs),
            "TEST_APP_STATUS": str(app_status),
            "TEST_INTERRUPT": "1" if interrupt else "0",
            "TEST_RAW_TERMINAL": "1" if raw_terminal else "0",
            "TEST_CHILD_PID_FILE": str(child_pid),
        }
        env.pop("TMUX", None)
        clients = []
        pending = {}

        def tmux(*args, check=True):
            return subprocess.run(
                ["tmux", *args], env=env, capture_output=True, text=True,
                check=check, timeout=10,
            ).stdout

        def attach():
            pid, terminal = pty.fork()
            if pid == 0:
                os.execve("/bin/sh", ["sh", "/usr/local/bin/session.sh"], env)
            clients.append((pid, terminal))
            pending[terminal] = b""
            return terminal

        def wait_for(terminal, expected):
            output = pending[terminal]
            deadline = time.monotonic() + 10
            while expected.encode() not in output and time.monotonic() < deadline:
                if not select.select([terminal], [], [], 0.1)[0]:
                    continue
                try:
                    chunk = os.read(terminal, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
            assert expected.encode() in output, (
                f"Launcher did not offer another analysis after exit {app_status}; "
                f"terminal output: {output.decode(errors='replace')!r}"
            )
            pending[terminal] = output.split(expected.encode(), 1)[1]

        def cancel_if_needed(terminal):
            if not interrupt:
                return
            # Output can arrive before exec; wait for the actual blocked child.
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                pid = child_pid.read_text().strip()
                if Path(f"/proc/{pid}/comm").read_text().strip() == "sleep":
                    os.write(terminal, b"\x03")
                    return
                time.sleep(0.01)
            raise AssertionError("Dummy child did not become ready for cancellation")

        try:
            terminal = attach()
            if interrupt:
                wait_for(terminal, "DUMMY_REPORT_1")
                cancel_if_needed(terminal)
            wait_for(terminal, "Press Enter to start another analysis")
            pane = tmux("capture-pane", "-p", "-S", "-", "-t", "lifecycle-example-test")
            assert "DUMMY_REPORT_1" in pane, "Previous report was discarded"
            if app_status:
                assert str(app_status) in pane, "Failure status was hidden"
            time.sleep(0.2)
            assert runs.read_text().splitlines() == ["started"], "App restarted automatically"

            # Losing the ttyd/tmux client must not destroy or rerun the app pane.
            os.close(terminal)
            clients[-1] = (clients[-1][0], None)
            terminal = attach()
            wait_for(terminal, "Press Enter to start another analysis")
            assert runs.read_text().splitlines() == ["started"], "Reconnect reran the app"
            os.write(terminal, b"\r")
            wait_for(terminal, "DUMMY_REPORT_2")
            cancel_if_needed(terminal)
            wait_for(terminal, "Press Enter to start another analysis")
            pane = tmux("capture-pane", "-p", "-S", "-", "-t", "lifecycle-example-test")
            assert "DUMMY_REPORT_1" in pane and "DUMMY_REPORT_2" in pane
            assert runs.read_text().splitlines() == ["started", "started"]

            # EOF ends the captive launcher instead of spinning/retrying.
            tmux("send-keys", "-t", "lifecycle-example-test", "C-d")
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if not tmux("list-sessions", check=False).strip():
                    break
                time.sleep(0.05)
            assert not tmux("list-sessions", check=False).strip(), "EOF left launcher running"
            assert runs.read_text().splitlines() == ["started", "started"]
        finally:
            tmux("kill-server", check=False)
            for pid, terminal in clients:
                if terminal is not None:
                    os.close(terminal)
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
        print(f"ok   exit {app_status}: output retained, explicit restart, reconnect, EOF")


if __name__ == "__main__":
    for status in (0, 17):
        check_lifecycle(status)
    check_lifecycle(130, interrupt=True)
    check_lifecycle(17, raw_terminal=True)

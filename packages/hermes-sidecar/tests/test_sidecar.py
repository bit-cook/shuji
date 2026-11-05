import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sidecar  # noqa: E402


class LocalServer:
    """在随机端口起一个 http.server，handler 类由调用方给出。"""

    def __init__(self, handler_cls):
        import http.server
        import threading

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def make_handler(status, body):
    import http.server

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self._respond(status, body)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self._respond(status, body)

        def _respond(self, code, payload):
            data = payload.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format, *args):  # noqa: A002
            pass

    return H


def cfg(**over):
    env = {"MC_BASE": "http://mc:3000", "MC_API_KEY": "k"}
    env.update(over)
    return sidecar.Config(env)


class TestConfig(unittest.TestCase):
    def test_missing_mc_base(self):
        with self.assertRaisesRegex(ValueError, "MC_BASE"):
            sidecar.Config({"MC_API_KEY": "k"})

    def test_missing_api_key(self):
        with self.assertRaisesRegex(ValueError, "MC_API_KEY"):
            sidecar.Config({"MC_BASE": "http://mc:3000"})

    def test_defaults(self):
        c = cfg()
        self.assertEqual(c.agent_id, "hermes-node-b")
        self.assertEqual(c.interval, 300)
        self.assertEqual(c.retry_max, 3)


class TestFetchStatus(unittest.TestCase):
    def test_rpc_online(self):
        srv = LocalServer(make_handler(200, '{"ok":true,"sessions":2}'))
        self.addCleanup(srv.stop)
        c = cfg(HERMES_RPC=f"http://127.0.0.1:{srv.port}/status")
        status, detail = sidecar.fetch_status(c)
        self.assertEqual(status, "online")
        self.assertEqual(detail["source"], "hermes-rpc")
        self.assertEqual(detail["detail"]["sessions"], 2)

    def test_rpc_down_falls_back_to_systemd_active(self):
        c = cfg(HERMES_RPC="http://127.0.0.1:1/status")  # 必然连不上
        with mock.patch.object(sidecar.subprocess, "run") as m:
            m.return_value = mock.Mock(stdout="active\n", returncode=0)
            status, detail = sidecar.fetch_status(c)
        self.assertEqual(status, "online")
        self.assertEqual(detail["source"], "systemd")

    def test_systemd_inactive_is_offline(self):
        c = cfg(HERMES_RPC="http://127.0.0.1:1/status")
        with mock.patch.object(sidecar.subprocess, "run") as m:
            m.return_value = mock.Mock(stdout="inactive\n", returncode=3)
            status, detail = sidecar.fetch_status(c)
        self.assertEqual(status, "offline")
        self.assertEqual(detail["state"], "inactive")

    def test_all_sources_down(self):
        c = cfg(HERMES_RPC="http://127.0.0.1:1/status")
        with mock.patch.object(sidecar.subprocess, "run", side_effect=OSError("no systemctl")):
            status, detail = sidecar.fetch_status(c)
        self.assertEqual(status, "offline")
        self.assertEqual(detail["source"], "none")


class TestHeartbeat(unittest.TestCase):
    def test_payload_and_auth_header(self):
        captured = {}

        import http.server

        class H(make_handler(200, '{"ok":true}')):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                captured["body"] = self.rfile.read(length).decode()
                captured["auth"] = self.headers.get("Authorization")
                self._respond(200, '{"ok":true}')

        srv = LocalServer(H)
        self.addCleanup(srv.stop)
        c = cfg()
        c.mc_base = f"http://127.0.0.1:{srv.port}"
        r = sidecar.post_heartbeat(c, "online", {"source": "test"})
        self.assertEqual(r, {"ok": True})
        body = json.loads(captured["body"])
        self.assertEqual(body["framework"], "generic")
        self.assertEqual(body["action"], "heartbeat")
        self.assertEqual(body["payload"]["agentId"], "hermes-node-b")
        self.assertEqual(body["payload"]["status"], "online")
        self.assertIn("reportedAt", body["payload"])
        self.assertEqual(captured["auth"], "Bearer k")

    def test_401_fast_fails(self):
        srv = LocalServer(make_handler(401, '{"message":"bad key"}'))
        self.addCleanup(srv.stop)
        c = cfg()
        c.mc_base = f"http://127.0.0.1:{srv.port}"
        slept = []
        ok = sidecar.run_once(c, sleep=slept.append)
        self.assertFalse(ok)
        self.assertEqual(slept, [], "401 不应重试")

    def test_transient_500_then_success(self):
        import http.server

        state = {"n": 0}

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["n"] += 1
                if state["n"] == 1:
                    self._respond(500, '{"e":1}')
                else:
                    self._respond(200, '{"ok":true}')

            def _respond(self, code, payload):
                data = payload.encode()
                self.send_response(code)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format, *args):  # noqa: A002
                pass

        srv = LocalServer(H)
        self.addCleanup(srv.stop)
        c = cfg(RETRY_MAX="3", RETRY_BACKOFF="0")
        c.mc_base = f"http://127.0.0.1:{srv.port}"
        slept = []
        ok = sidecar.run_once(c, sleep=slept.append)
        self.assertTrue(ok)
        self.assertEqual(state["n"], 2)
        self.assertEqual(slept, [0.0])

    def test_persistent_failure_gives_up_after_retry_max(self):
        srv = LocalServer(make_handler(500, '{"e":1}'))
        self.addCleanup(srv.stop)
        c = cfg(RETRY_MAX="3", RETRY_BACKOFF="0")
        c.mc_base = f"http://127.0.0.1:{srv.port}"
        slept = []
        ok = sidecar.run_once(c, sleep=slept.append)
        self.assertFalse(ok)
        self.assertEqual(len(slept), 2)  # 3 次尝试之间 2 次退避


class TestCli(unittest.TestCase):
    def test_once_exit_code_success(self):
        srv = LocalServer(make_handler(200, '{"ok":true}'))
        self.addCleanup(srv.stop)
        env = dict(os.environ)
        env.update({"MC_BASE": f"http://127.0.0.1:{srv.port}", "MC_API_KEY": "k"})
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch.object(sys, "argv", ["sidecar.py", "--once"]):
                self.assertEqual(sidecar.main(), 0)

    def test_once_exit_code_failure(self):
        srv = LocalServer(make_handler(500, '{"e":1}'))
        self.addCleanup(srv.stop)
        env = dict(os.environ)
        env.update({"MC_BASE": f"http://127.0.0.1:{srv.port}", "MC_API_KEY": "k", "RETRY_MAX": "1"})
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch.object(sys, "argv", ["sidecar.py", "--once"]):
                self.assertEqual(sidecar.main(), 1)

    def test_missing_config_exit_code_2(self):
        env = {k: v for k, v in os.environ.items() if k not in ("MC_BASE", "MC_API_KEY")}
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch.object(sys, "argv", ["sidecar.py", "--once"]):
                self.assertEqual(sidecar.main(), 2)


if __name__ == "__main__":
    unittest.main()

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app.db import SensorRow
from app.discord_alerts import DiscordAlerts, build_message, event_for, normalize_mention
from app.status import Status as S

ROW = SensorRow("water_tank_1", "40th St & Camelback", 33.5097, -111.9967, 50.0, road="N 40th St")
SIM = SensorRow("FR-02", "Sim dip", 33.5, -112.0, None, simulated=True)


@pytest.mark.parametrize("prev,new,event", [
    (S.CLEAR, S.FLOODED, "flooded"), (S.CAUTION, S.FLOODED, "flooded"),
    (S.FLOODED, S.CAUTION, "reopened"), (S.FLOODED, S.CLEAR, "reopened"),
    (S.CLEAR, S.CAUTION, "caution"), (S.CAUTION, S.CLEAR, "clear"),
    (S.CLEAR, S.OFFLINE, "offline"), (S.OFFLINE, S.CLEAR, None), (S.OFFLINE, S.CAUTION, None),
])
def test_event_for(prev, new, event):
    assert event_for(prev, new) == event


def test_flooded_message():
    body = build_message("flooded", ROW, 30.0, 2.5, mention="123")
    e = body["embeds"][0]
    assert "40th St & Camelback" in e["title"] and "flooded" in e["title"].lower()
    assert e["color"] == 0xE5484D
    assert {f["name"] for f in e["fields"]} == {"Road", "Depth", "Rising", "Location"}
    assert body["content"].startswith("<@&123> ") and body["allowed_mentions"] == {"roles": ["123"]}


def test_everyone_mention():
    body = build_message("flooded", ROW, 30.0, None, mention="everyone")
    assert body["content"].startswith("@everyone ") and body["allowed_mentions"] == {"parse": ["everyone"]}


@pytest.mark.parametrize("raw,norm", [("@everyone", "everyone"), ("Everyone", "everyone"), ("@here", "here"),
                                      ("<@&123>", "123"), ("123", "123"), ("", ""), ("bogus", "")])
def test_normalize_mention(raw, norm):
    assert normalize_mention(raw) == norm


def test_no_mention_except_flooded():
    body = build_message("reopened", ROW, 3.0, None, mention="everyone")
    assert "content" not in body and body["allowed_mentions"] == {"parse": []}


def test_filters_and_cooldown():
    d = DiscordAlerts("http://x", notify_on="flooded,reopened", cooldown_s=60)
    assert d.status_changed(ROW, S.CLEAR, S.FLOODED, 20, 1) is True
    assert d.status_changed(ROW, S.CLEAR, S.FLOODED, 20, 1) is False   # cooldown
    assert d.status_changed(ROW, S.FLOODED, S.CLEAR, 1, 0) is True     # different event
    assert d.status_changed(ROW, S.CLEAR, S.CAUTION, 6, 0) is False    # not subscribed
    assert d.status_changed(SIM, S.CLEAR, S.FLOODED, 20, 1) is False   # simulated excluded
    assert DiscordAlerts("").status_changed(ROW, S.CLEAR, S.FLOODED, 20, 1) is False  # disabled


class _Hook(BaseHTTPRequestHandler):
    received: list = []
    codes: list = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).received.append((self.headers["User-Agent"], body))
        code = type(self).codes.pop(0) if type(self).codes else 204
        self.send_response(code)
        if code == 429:
            payload = b'{"retry_after": 0.05}'
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.end_headers()

    def log_message(self, *a):
        pass


async def test_delivers_to_webhook_with_429_retry():
    _Hook.received, _Hook.codes = [], [429]
    srv = HTTPServer(("127.0.0.1", 0), _Hook)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        d = DiscordAlerts(f"http://127.0.0.1:{srv.server_port}/hook")
        task = asyncio.create_task(d.run())
        d.status_changed(ROW, S.CAUTION, S.FLOODED, 18.0, 2.2)
        for _ in range(100):
            if d.sent:
                break
            await asyncio.sleep(0.02)
        task.cancel()
        assert d.sent == 1 and d.last_error is None
        assert len(_Hook.received) == 2                      # 429 then retry
        ua, body = _Hook.received[-1]
        assert ua.startswith("DiscordBot")
        assert "Road flooded" in body["embeds"][0]["title"]
    finally:
        srv.shutdown()

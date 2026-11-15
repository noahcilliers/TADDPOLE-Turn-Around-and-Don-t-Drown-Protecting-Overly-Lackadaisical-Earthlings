import asyncio

import pytest

from app.camera import CameraGate, Verdict, is_water


def V(kind, water, trusted, obj=""):
    return Verdict(verdict=kind, water_present=water, object_under_sensor=not trusted,
                   object_description=obj, reading_trustworthy=trusted, confidence=0.9, reason="test")


@pytest.mark.parametrize("v,expected", [
    (V("flood_water", True, True), True),
    (V("object_under_sensor", False, False, "toy car"), False),
    (V("object_and_water", True, False, "box"), False),
    (V("nothing", False, True), False),
    (V("unclear", False, True), None),
])
def test_is_water(v, expected):
    assert is_water(v) is expected


def gate(answer):
    """A gate with a fake Gemini client that returns `answer` (a Verdict or an Exception)."""
    g = CameraGate(api_key="", camera="0", sensor_ids=["tank"], model="m")
    g._client, g.problem = object(), None
    g._photo = lambda: b"\xff\xd8fake"

    def ask(jpg, depth):
        if isinstance(answer, Exception):
            raise answer
        return answer
    g._ask_gemini = ask
    return g


async def settle(g, sid="tank"):
    await g.sensors[sid].task


async def test_water_allows_after_check():
    g = gate(V("flood_water", True, True))
    assert g.covers("tank") and not g.covers("other")
    assert g.decide("tank", 6.0) == "pending"       # first call takes a photo, holds meanwhile
    await settle(g)
    assert g.decide("tank", 6.0) == "allow"


async def test_object_blocks():
    g = gate(V("object_under_sensor", False, False, "toy car"))
    g.decide("tank", 12.0)
    await settle(g)
    assert g.decide("tank", 12.0) == "block"
    assert g.snapshot()["sensors"]["tank"]["holding_alert"] is True


async def test_camera_failure_fails_open():
    g = gate(RuntimeError("webcam unplugged"))
    assert g.decide("tank", 20.0) == "pending"
    await settle(g)
    assert g.decide("tank", 20.0) == "allow"


async def test_stale_verdict_rechecks():
    g = gate(V("flood_water", True, True))
    g.decide("tank", 6.0)
    await settle(g)
    g.sensors["tank"].verdict_at -= g.verdict_max_age_s + 1
    assert g.decide("tank", 8.0) == "pending"
    await settle(g)
    assert g.decide("tank", 8.0) == "allow"


def test_disabled_without_key():
    g = CameraGate(api_key="", camera="1", sensor_ids=["tank"], model="m")
    assert not g.enabled and not g.covers("tank") and g.source == 1


# ---------- URL mode: deployed backend <- scripts/camera_server.py on the webcam laptop ----------
import importlib.util
import threading
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "camera_server", Path(__file__).resolve().parent.parent / "scripts" / "camera_server.py")
camera_server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(camera_server)

JPEG = b"\xff\xd8\xff\xe0fake-frame"


@pytest.fixture
def snapshot_url():
    srv = camera_server.make_server("127.0.0.1", 0, "s3cret", lambda: JPEG)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/snapshot.jpg"
    srv.shutdown()


def url_gate(url, token, answer):
    g = CameraGate(api_key="", camera=url, camera_token=token, sensor_ids=["tank"], model="m")
    g._client, g.problem = object(), None
    seen = []
    g._ask_gemini = lambda jpg, depth: (seen.append(jpg), answer)[1]
    return g, seen


async def test_url_mode_fetches_with_token(snapshot_url):
    g, seen = url_gate(snapshot_url, "s3cret", V("object_under_sensor", False, False, "hand"))
    assert g.decide("tank", 10.0) == "pending"
    await settle(g)
    assert seen == [JPEG]
    assert g.decide("tank", 10.0) == "block"


async def test_url_mode_wrong_token_fails_open(snapshot_url):
    g, seen = url_gate(snapshot_url, "wrong", V("flood_water", True, True))
    g.decide("tank", 10.0)
    await settle(g)
    assert seen == [] and "401" in g.sensors["tank"].error
    assert g.decide("tank", 10.0) == "allow"


def test_camera_server_requires_token():
    with pytest.raises(SystemExit):
        camera_server.make_server("127.0.0.1", 0, "", lambda: JPEG)

"""POST /v1/camera/{id}: the Wi-Fi camera's upload endpoint (CAMERA=push)."""
import pytest
from fastapi.testclient import TestClient

from app.camera import CameraGate
from app.config import Settings
from app.main import app

JPEG = b"\xff\xd8\xff\xe0fake-frame"


def client(camera="push", token="s3cret"):
    app.state.cfg = Settings(camera=camera, camera_token=token, database_url="postgresql://x@localhost/x")
    app.state.camera = CameraGate(api_key="", camera=camera, camera_token=token, sensor_ids=["tank"], model="m")
    return TestClient(app)          # no `with`: skip the lifespan (no database needed)


def post(c, body=JPEG, token="s3cret", sid="tank"):
    return c.post(f"/v1/camera/{sid}", content=body,
                  headers={"X-Camera-Token": token, "Content-Type": "image/jpeg"})


def test_upload_stored():
    c = client()
    assert post(c).status_code == 204
    assert app.state.camera._uploads["tank"][0] == JPEG


@pytest.mark.parametrize("kw,code", [
    ({"token": "wrong"}, 401),
    ({"token": ""}, 401),
    ({"sid": "other"}, 404),
    ({"body": b"<html>"}, 422),
    ({"body": JPEG + b"0" * 1_000_001}, 413),
])
def test_upload_rejected(kw, code):
    assert post(client(), **kw).status_code == code
    assert "tank" not in app.state.camera._uploads


def test_upload_needs_push_mode():
    assert post(client(camera="0")).status_code == 409


def test_upload_disabled_without_token():
    assert post(client(token=""), token="").status_code == 404

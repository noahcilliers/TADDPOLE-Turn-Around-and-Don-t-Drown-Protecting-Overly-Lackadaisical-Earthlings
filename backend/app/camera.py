"""Camera check: is the thing under the sensor actually water?

When a camera-equipped sensor's status is about to go UP (clear -> caution, -> flooded), the
poller asks `CameraGate.decide(...)` first. The gate grabs a webcam frame, asks Gemini whether
the surface under the ultrasonic sensor is water or an object (car, hand, box...), and answers:

  allow    water confirmed (or the camera/Gemini is broken -> fail open, a real flood must alert)
  block    Gemini says it's NOT water: hold the old status, so no alert, no reroute
  pending  a check is running: hold the old status for a few seconds until the verdict lands

Going DOWN is never gated. Enabled when GEMINI_API_KEY is set; CAMERA picks the webcam
(0 = built-in, 1 = USB, ...) or a URL that returns a JPEG, e.g. scripts/camera_server.py on the
webcam laptop behind a tunnel, so the deployed backend can use it (sends CAMERA_TOKEN). opencv / google-genai are imported
lazily, so the backend still runs (ungated) without them.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import platform
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal
from urllib.request import Request, urlopen

from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

Decision = Literal["allow", "block", "pending"]


# ================= Gemini =================
class Verdict(BaseModel):
    verdict: Literal["flood_water", "object_under_sensor", "object_and_water", "nothing", "unclear"] = Field(
        description="flood_water: the rise is caused by water. object_under_sensor: a solid object "
                    "(no meaningful water) is under the sensor. object_and_water: an object is under the "
                    "sensor AND there is water. nothing: dry and empty. unclear: image too dark/blurry.")
    water_present: bool = Field(description="True if any water is visible under the sensor.")
    object_under_sensor: bool = Field(
        description="True if a solid object directly under the sensor sticks up above the water/ground, "
                    "so the sensor would hit the object instead of the water.")
    object_description: str = Field(description="Short name of the object, e.g. 'toy car', 'hand'. "
                                                "Empty string if none.")
    reading_trustworthy: bool = Field(
        description="True if the distance sensor is measuring water or bare ground (not an object).")
    confidence: float = Field(description="0.0 to 1.0")
    reason: str = Field(description="One short sentence explaining the decision.")


PROMPT = """You are the safety check for a roadside flash-flood sensor.
An ultrasonic distance sensor points straight down at the area shown in this photo (the camera is
mounted next to it). The sensor just reported that the surface below got closer:
  measured water depth: {depth:.1f} cm

Decide WHY the surface got closer:
- flood_water: water (clear, muddy, flowing, still) is rising. Ripples, foam, glare and REFLECTIONS
  on the water surface are still water, not objects.
- object_under_sensor: a solid object (vehicle or toy car, person, hand, animal, box, debris,
  branch, trash...) is under the sensor and there is no meaningful water.
- object_and_water: there is water AND a solid object under the sensor sticking up out of it.
- nothing: dry and empty (the reading was probably noise).
- unclear: you cannot tell (too dark, blurry, lens blocked).
A flat object lying fully under the water does not count as being under the sensor.
reading_trustworthy must be false whenever object_under_sensor is true."""


def is_water(v: Verdict) -> bool | None:
    """True = the depth reading is real water, False = it isn't, None = can't tell."""
    if v.verdict == "unclear":
        return None
    return v.water_present and v.reading_trustworthy


# ================= webcam =================
def camera_source(value: str) -> int | str:
    v = str(value).strip()
    return int(v) if v.isdigit() else v


class Webcam:
    """Keeps a USB webcam open in a background thread so a fresh frame is always ready."""

    def __init__(self, index: int):
        import cv2
        self.cv2 = cv2
        self.index = index
        self.frame = None
        self.frame_time = 0.0
        self.error: str | None = None
        self.backend = ""
        self.lock = threading.Lock()
        threading.Thread(target=self._run, daemon=True, name=f"webcam-{index}").start()

    def _open(self):
        cv2 = self.cv2
        if platform.system() == "Windows":
            backends = [("DSHOW", cv2.CAP_DSHOW), ("MSMF", cv2.CAP_MSMF), ("ANY", cv2.CAP_ANY)]
        else:
            backends = [("ANY", cv2.CAP_ANY)]
        for name, backend in backends:
            cap = cv2.VideoCapture(self.index, backend)
            if cap.isOpened():
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                ok, _ = cap.read()
                if ok:
                    self.backend = name
                    return cap
            cap.release()
        return None

    def _run(self):
        while True:
            cap = self._open()
            if cap is None:
                self.error = (f"can't open webcam {self.index} (wrong CAMERA number in .env, another app "
                              "is using it, or the terminal has no camera permission)")
                log.warning(self.error)
                time.sleep(3)
                continue
            self.error = None
            log.info("webcam %s open (%s)", self.index, self.backend)
            fails = 0
            while fails < 50:
                ok, frame = cap.read()
                if ok:
                    fails = 0
                    with self.lock:
                        self.frame, self.frame_time = frame, time.time()
                else:
                    fails += 1
                    time.sleep(0.05)
            log.warning("webcam %s stopped sending frames, reopening", self.index)
            cap.release()

    def jpeg(self) -> bytes:
        with self.lock:
            frame, age = self.frame, time.time() - self.frame_time
        if frame is None or age > 3:
            raise RuntimeError(self.error or "no recent webcam frame")
        ok, buf = self.cv2.imencode(".jpg", frame, [self.cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            raise RuntimeError("could not encode webcam frame")
        return buf.tobytes()


# ================= gate =================
@dataclass
class _SensorCam:
    verdict: Verdict | None = None
    verdict_at: float = 0.0            # monotonic time the photo was taken
    error: str | None = None
    error_at: float = 0.0
    pending_since: float | None = None
    task: asyncio.Task | None = None
    last_jpeg: bytes | None = None
    last_checked: datetime | None = None
    held: bool = False                 # last decide() held the status back
    log_key: tuple = field(default_factory=tuple)


class CameraGate:
    def __init__(
        self,
        *,
        api_key: str,
        camera: str,
        camera_token: str = "",
        sensor_ids: list[str],
        model: str,
        verdict_max_age_s: float = 30.0,
        recheck_s: float = 10.0,
        timeout_s: float = 30.0,
    ):
        self.api_key = api_key.strip()
        self.source = camera_source(camera)
        self.camera_token = camera_token.strip()
        self.sensor_ids = {s.strip() for s in sensor_ids if s.strip()}
        self.model = model
        self.verdict_max_age_s = verdict_max_age_s
        self.recheck_s = recheck_s
        self.timeout_s = timeout_s
        self.sensors: dict[str, _SensorCam] = {}
        self.problem: str | None = None
        self._client = None
        self._webcam: Webcam | None = None

        if not self.api_key:
            self.problem = "GEMINI_API_KEY not set"
        elif not self.sensor_ids:
            self.problem = "CAMERA_SENSORS is empty"
        else:
            try:
                from google import genai
                self._client = genai.Client(api_key=self.api_key)
            except ImportError:
                self.problem = "google-genai not installed (pip install -r requirements-camera.txt)"
            except Exception as e:
                self.problem = f"Gemini init failed: {e}"
        if self.problem:
            log.warning("camera water check OFF: %s (alerts are not camera-checked)", self.problem)
        else:
            log.info("camera water check ON for %s (camera %r, model %s)",
                     ", ".join(sorted(self.sensor_ids)), self.source, self.model)

    @property
    def enabled(self) -> bool:
        return self._client is not None

    def covers(self, sid: str) -> bool:
        return self.enabled and sid in self.sensor_ids

    def start(self) -> None:
        """Open the webcam at startup so it's warm before the first flood."""
        if self.enabled and isinstance(self.source, int):
            try:
                self._webcam = Webcam(self.source)
            except ImportError:
                self.problem = "opencv not installed (pip install -r requirements-camera.txt)"
                log.warning("camera water check: %s; escalations will fail open", self.problem)

    # ---------- decision (called from the poller, must be fast) ----------
    def decide(self, sid: str, depth_cm: float | None) -> Decision:
        """Should this sensor be allowed to escalate right now?"""
        sc = self.sensors.setdefault(sid, _SensorCam())
        now = time.monotonic()
        running = sc.task is not None and not sc.task.done()

        if sc.verdict is not None and now - sc.verdict_at <= self.verdict_max_age_s:
            water = is_water(sc.verdict)
            if water is False:
                # Not water. Keep blocking, but re-look now and then: the object may move,
                # or real water may have risen around it.
                if not running and now - sc.verdict_at >= self.recheck_s:
                    self._start_check(sid, sc, depth_cm)
                return self._out(sid, sc, "block", f"not water: {sc.verdict.verdict}"
                                 f"{' (' + sc.verdict.object_description + ')' if sc.verdict.object_description else ''}"
                                 f" - {sc.verdict.reason}")
            return self._out(sid, sc, "allow", "water confirmed" if water else "camera unclear, failing open")

        # No fresh verdict. If the camera/Gemini just failed, don't sit on a possible flood.
        if sc.error is not None and now - sc.error_at <= self.verdict_max_age_s:
            if not running and now - sc.error_at >= self.recheck_s:
                self._start_check(sid, sc, depth_cm)          # retry in the background
            return self._out(sid, sc, "allow", f"camera check failed, failing open: {sc.error}")
        if not running:
            self._start_check(sid, sc, depth_cm)
        if sc.pending_since is not None and now - sc.pending_since > self.timeout_s + 5:
            return self._out(sid, sc, "allow", "camera check timed out, failing open")
        return self._out(sid, sc, "pending", "checking camera")

    def _out(self, sid: str, sc: _SensorCam, d: Decision, why: str) -> Decision:
        sc.held = d != "allow"
        key = (d, why)
        if key != sc.log_key:          # log on change, not every poll tick
            sc.log_key = key
            (log.warning if d == "block" else log.info)("camera gate %s: %s (%s)", sid, d.upper(), why)
        return d

    def _start_check(self, sid: str, sc: _SensorCam, depth_cm: float | None) -> None:
        if sc.pending_since is None:
            sc.pending_since = time.monotonic()
        sc.task = asyncio.create_task(self._check(sid, sc, depth_cm or 0.0), name=f"camera-{sid}")

    async def _check(self, sid: str, sc: _SensorCam, depth_cm: float) -> None:
        taken = time.monotonic()
        try:
            jpg = await asyncio.to_thread(self._photo)
            sc.last_jpeg, sc.last_checked = jpg, datetime.now(timezone.utc)
            v = await asyncio.wait_for(asyncio.to_thread(self._ask_gemini, jpg, depth_cm), self.timeout_s)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            msg = "Gemini timed out" if isinstance(e, asyncio.TimeoutError) else f"{type(e).__name__}: {e}"
            sc.error, sc.error_at, sc.pending_since = msg[:300], time.monotonic(), None
            log.warning("camera check %s failed: %s", sid, sc.error)
            return
        sc.verdict, sc.verdict_at, sc.error, sc.pending_since = v, taken, None, None
        log.info("camera check %s at %.1f cm -> %s (water=%s, object=%r, conf=%.2f): %s",
                 sid, depth_cm, v.verdict, v.water_present, v.object_description, v.confidence, v.reason)

    # ---------- blocking I/O (runs in a thread) ----------
    def _photo(self) -> bytes:
        if isinstance(self.source, int):
            if self._webcam is None:
                raise RuntimeError(self.problem or "webcam not started")
            deadline = time.time() + 3            # first open takes a moment
            while True:
                try:
                    return self._webcam.jpeg()
                except RuntimeError:
                    if time.time() > deadline:
                        raise
                    time.sleep(0.2)
        headers = {"X-Camera-Token": self.camera_token} if self.camera_token else {}
        with urlopen(Request(self.source, headers=headers), timeout=6) as r:
            data = r.read()
        if not data.startswith(b"\xff\xd8"):
            raise RuntimeError("camera URL did not return a JPEG")
        return data

    def _ask_gemini(self, jpg: bytes, depth_cm: float) -> Verdict:
        prompt = PROMPT.format(depth=depth_cm)
        client = self._client
        if hasattr(client, "interactions"):                 # newer SDK
            interaction = client.interactions.create(
                model=self.model,
                input=[{"type": "text", "text": prompt},
                       {"type": "image", "data": base64.b64encode(jpg).decode("utf-8"),
                        "mime_type": "image/jpeg"}],
                response_format={"type": "text", "mime_type": "application/json",
                                 "schema": Verdict.model_json_schema()},
            )
            return Verdict.model_validate_json(interaction.output_text)
        from google.genai import types                      # older SDK
        response = client.models.generate_content(
            model=self.model,
            contents=[types.Part.from_bytes(data=jpg, mime_type="image/jpeg"), prompt],
            config={"response_mime_type": "application/json", "response_schema": Verdict},
        )
        return Verdict.model_validate_json(response.text)

    # ---------- introspection ----------
    def snapshot(self) -> dict:
        now = time.monotonic()
        return {
            "enabled": self.enabled,
            "problem": self.problem,
            "camera": self.source,
            "webcam_error": self._webcam.error if self._webcam else None,
            "sensors": {
                sid: {
                    "holding_alert": sc.held,
                    "checking": sc.task is not None and not sc.task.done(),
                    "verdict": sc.verdict.model_dump() if sc.verdict else None,
                    "verdict_age_s": round(now - sc.verdict_at, 1) if sc.verdict else None,
                    "error": sc.error,
                    "last_photo_at": sc.last_checked.isoformat() if sc.last_checked else None,
                }
                for sid, sc in self.sensors.items()
            },
        }

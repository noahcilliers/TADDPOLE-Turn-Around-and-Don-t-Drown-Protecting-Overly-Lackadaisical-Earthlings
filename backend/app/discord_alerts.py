"""Discord webhook alerts for road status changes.

The poller calls `DiscordAlerts.status_changed(...)` on every status transition. That only
queues a message; a background task posts them one at a time, so a slow or failing Discord
never stalls the poll loop. Set DISCORD_WEBHOOK_URL to enable; empty = off.

Events (pick with DISCORD_NOTIFY_ON, comma-separated):
  flooded   any -> flooded              road closed
  reopened  flooded -> caution/clear    road passable again
  caution   clear -> caution            water rising
  clear     caution -> clear            all clear (no flood in between)
  offline   any -> offline              sensor stopped reporting
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from .db import SensorRow
from .status import Status, describe_depth

log = logging.getLogger(__name__)

EVENTS = ("flooded", "reopened", "caution", "clear", "offline")
COLORS = {  # embed side-bar colours
    "flooded": 0xE5484D,
    "reopened": 0x30A46C,
    "caution": 0xF5A524,
    "clear": 0x30A46C,
    "offline": 0x8B8D98,
}
# Discord's edge (Cloudflare) rejects urllib's default User-Agent.
USER_AGENT = "DiscordBot (floodroute, 1.0)"


def event_for(prev: Status, new: Status) -> str | None:
    """Which alert a transition is, or None if it isn't one we report."""
    if new is Status.FLOODED:
        return "flooded"
    if new is Status.OFFLINE:
        return "offline"
    if prev is Status.FLOODED:
        return "reopened"           # -> caution or clear
    if prev is Status.CLEAR and new is Status.CAUTION:
        return "caution"
    if prev is Status.CAUTION and new is Status.CLEAR:
        return "clear"
    return None                     # offline -> clear/caution: sensor back, nothing to shout about


def build_message(
    event: str,
    row: SensorRow,
    depth_cm: float | None,
    rise_cm_per_min: float | None,
    *,
    app_url: str = "",
    mention: str = "",
    at: datetime | None = None,
) -> dict:
    """Webhook JSON body for one alert."""
    name = row.name
    depth = describe_depth(depth_cm)
    title, desc = {
        "flooded": (f"🚫 Road flooded: {name}", f"Water is {depth}. Turn around, don't drown. Drivers are being rerouted."),
        "reopened": (f"✅ Road reopened: {name}", f"Water has dropped ({depth}). The road is passable again; drive with care."),
        "caution": (f"⚠️ Water rising: {name}", f"Water is {depth} and rising. Use caution."),
        "clear": (f"✅ All clear: {name}", "Water has drained from the road."),
        "offline": (f"📡 Sensor offline: {name}", "No readings from this sensor. Road conditions here are unknown."),
    }[event]

    fields = []
    if row.road:
        fields.append({"name": "Road", "value": row.road, "inline": True})
    if depth_cm is not None and event != "offline":
        fields.append({"name": "Depth", "value": f"{depth_cm:.1f} cm ({depth_cm / 2.54:.1f} in)", "inline": True})
    if rise_cm_per_min is not None and event in ("flooded", "caution"):
        fields.append({"name": "Rising", "value": f"{rise_cm_per_min:+.1f} cm/min", "inline": True})
    maps = f"https://www.google.com/maps?q={row.lat:.6f},{row.lon:.6f}"
    fields.append({"name": "Location", "value": f"[{row.lat:.5f}, {row.lon:.5f}]({maps})", "inline": False})

    embed = {
        "title": title,
        "description": desc,
        "color": COLORS[event],
        "fields": fields,
        "footer": {"text": f"FloodRoute · sensor {row.sensor_id}" + (" (simulated)" if row.simulated else "")},
        "timestamp": (at or datetime.now(timezone.utc)).isoformat(),
    }
    if app_url:
        embed["url"] = app_url

    body: dict = {"username": "FloodRoute", "embeds": [embed], "allowed_mentions": {"parse": []}}
    if mention and event == "flooded":
        # Embeds never ping; the mention has to be in `content` and allowed explicitly.
        if mention in ("everyone", "here"):
            body["content"] = f"@{mention} {title}"
            body["allowed_mentions"] = {"parse": ["everyone"]}   # covers @here too
        else:
            body["content"] = f"<@&{mention}> {title}"
            body["allowed_mentions"] = {"roles": [mention]}
    return body


def normalize_mention(value: str) -> str:
    """'@everyone' / 'everyone' / '@here' / '<@&123>' / '123' -> 'everyone' | 'here' | '123' | ''."""
    v = value.strip().lstrip("<").rstrip(">").lstrip("@&").strip().lower()
    if v in ("everyone", "here") or v.isdigit():
        return v
    if v:
        log.warning("DISCORD_MENTION=%r not understood; use everyone, here or a role ID", value)
    return ""


class DiscordAlerts:
    def __init__(
        self,
        webhook_url: str,
        *,
        notify_on: str = "flooded,reopened",
        cooldown_s: float = 60.0,
        include_simulated: bool = False,
        app_url: str = "",
        mention: str = "",
    ):
        self.webhook_url = webhook_url.strip()
        self.events = {e.strip().lower() for e in notify_on.split(",") if e.strip()}
        unknown = self.events - set(EVENTS)
        if unknown:
            log.warning("DISCORD_NOTIFY_ON: ignoring unknown event(s) %s; valid: %s", sorted(unknown), ", ".join(EVENTS))
            self.events -= unknown
        self.cooldown_s = cooldown_s
        self.include_simulated = include_simulated
        self.app_url = app_url
        self.mention = normalize_mention(mention)
        self._queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=100)
        self._last: dict[tuple[str, str], float] = {}   # (sensor_id, event) -> monotonic time sent
        self.sent = 0
        self.last_error: str | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.webhook_url)

    def status_changed(
        self, row: SensorRow, prev: Status, new: Status, depth_cm: float | None, rise_cm_per_min: float | None
    ) -> bool:
        """Queue an alert for this transition if it's one we report. Returns True if queued."""
        if not self.enabled or (row.simulated and not self.include_simulated):
            return False
        event = event_for(prev, new)
        if event is None or event not in self.events:
            return False
        key, now = (row.sensor_id, event), time.monotonic()
        if now - self._last.get(key, float("-inf")) < self.cooldown_s:
            log.info("discord: %s %s suppressed (cooldown)", row.sensor_id, event)
            return False
        self._last[key] = now
        return self.enqueue(build_message(event, row, depth_cm, rise_cm_per_min,
                                          app_url=self.app_url, mention=self.mention))

    def enqueue(self, body: dict) -> bool:
        try:
            self._queue.put_nowait(body)
            return True
        except asyncio.QueueFull:
            log.warning("discord: queue full, dropping alert")
            return False

    async def send_now(self, body: dict) -> None:
        """POST one message, honouring a single 429 retry. Raises on failure."""
        for attempt in range(2):
            status, retry_after = await asyncio.to_thread(self._post, body)
            if status == 429 and attempt == 0:
                await asyncio.sleep(min(retry_after or 1.0, 30.0))
                continue
            if not 200 <= status < 300:
                raise RuntimeError(f"Discord webhook returned HTTP {status}")
            self.sent += 1
            return

    def _post(self, body: dict) -> tuple[int, float | None]:
        req = urllib.request.Request(
            self.webhook_url,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, None
        except urllib.error.HTTPError as e:
            retry = None
            if e.code == 429:
                try:
                    retry = float(json.loads(e.read() or b"{}").get("retry_after", 1.0))
                except Exception:
                    retry = 1.0
            return e.code, retry

    async def run(self) -> None:
        if not self.enabled:
            return
        log.info("discord alerts on for: %s%s", ", ".join(sorted(self.events)) or "(nothing)",
                 " (incl. simulated sensors)" if self.include_simulated else "")
        while True:
            body = await self._queue.get()
            try:
                await self.send_now(body)
                self.last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"
                log.warning("discord: alert not delivered: %s", self.last_error)

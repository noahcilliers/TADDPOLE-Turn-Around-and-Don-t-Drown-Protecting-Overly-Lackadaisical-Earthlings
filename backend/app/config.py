from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Tiger Data / TimescaleDB connection string, e.g.
    # postgres://tsdbadmin:<pw>@<host>.tsdb.cloud.timescale.com:<port>/tsdb?sslmode=require
    # Accepts DATABASE_URL or TIGER_DB.
    database_url: str = Field(
        default="postgresql://postgres:password@localhost:5432/postgres",
        validation_alias=AliasChoices("DATABASE_URL", "TIGER_DB"),
    )

    # Poller
    poll_interval_s: float = 1.0
    sensor_refresh_s: int = 30            # reload `sensors` table (new sensors / baselines)
    stale_after_s: int = 60               # no reading for this long -> sensor flagged stale
    offline_after_s: int = 300            # no reading for this long -> status `offline`

    # Status thresholds (cm). Defaults: 6 in knocks a person over, 12 in floats a car.
    caution_cm: float = 5.0
    flooded_cm: float = 15.0
    rise_rate_cm_per_min: float = 2.0     # rising this fast -> at least caution
    rise_window_s: int = 60               # net-change window for the rise rate
    median_of: int = 3                    # median of last N readings to kill ultrasonic noise
    hysteresis_cm: float = 2.0            # must drop this far below a threshold to downgrade

    # Spike filter for history charts / stats (Hampel; see app/filters.py)
    spike_half_window: int = 3            # neighbours each side; removes spikes up to this many readings long
    spike_sigmas: float = 3.0             # robust std-devs from the local median that count as a spike
    spike_min_cm: float = 1.0             # never treat a deviation smaller than this as a spike

    # Routing
    graph_path: str = "data/camelback.graphml"
    flood_block_radius_m: float = 300.0   # a flooded sensor closes every road segment within this radius
    flood_buffer_m: float = 700.0         # ...and makes roads within this radius progressively more expensive

    # Stage demo (handoff demo_scenario.json corridor: 40th St northbound through Camelback)
    demo_sensor_id: str = "water_tank_1"
    hazard_ttl_s: int = 1800
    # The handoff's profiles/demo curve assume 10/30 cm thresholds. Scale them so they hit the
    # same states against ours. Empty = flooded_cm / 30.
    sim_depth_scale: float | None = None

    @property
    def effective_sim_scale(self) -> float:
        return self.sim_depth_scale if self.sim_depth_scale else self.flooded_cm / 30.0

    # Discord alerts (app/discord_alerts.py). Empty webhook URL = off.
    discord_webhook_url: str = ""
    discord_notify_on: str = "flooded,reopened"   # also: caution, clear, offline
    discord_cooldown_s: float = 60.0              # min gap between identical alerts for one sensor
    discord_include_simulated: bool = False       # simulated sensors replay 24 h profiles; noisy
    discord_mention: str = ""                     # ping on `flooded`: everyone, here, or a role ID
    discord_app_url: str = ""                     # link embeds to the live map

    # Camera water check (app/camera.py). Empty GEMINI_API_KEY = off (alerts work as before).
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash"
    camera: str = "0"                             # webcam number (0 built-in, 1 USB, ...) or JPEG URL
    camera_token: str = ""                        # shared secret with scripts/camera_server.py (URL mode)
    camera_sensors: str = "water_tank_1"          # comma-separated sensors the camera is pointed at
    camera_verdict_max_age_s: float = 30.0        # a verdict this old is stale; take a new photo
    camera_recheck_s: float = 10.0                # while blocked as "not water", re-look this often
    camera_timeout_s: float = 30.0                # give up on Gemini after this long (then fail open)

    # API
    cors_origins: str = "*"               # comma-separated
    admin_token: str = ""                 # required for /admin/*; empty disables admin endpoints

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()

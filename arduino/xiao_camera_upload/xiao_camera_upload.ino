/*
  TADDPOLE camera: Seeed XIAO ESP32-S3 Sense -> live backend, no laptop.

  Every 3 s: take a photo and POST it to the backend over HTTPS. When a sensor's status is
  about to go up, the backend uses the next photo that arrives to ask Gemini "is it really
  water?" (server .env needs CAMERA=push and the same CAMERA_TOKEN as below).

  Endpoint: POST /v1/camera/water_tank_1   body = JPEG   header X-Camera-Token: <CAMERA_TOKEN>

  Aiming: open http://<the IP printed in Serial Monitor>/ on a phone or laptop on the same
  Wi-Fi to see what the camera sees (local network only, refreshes every second).

  Arduino IDE setup:
    Boards Manager "esp32 by Espressif Systems" -> board "XIAO_ESP32S3"
    Tools > PSRAM > "OPI PSRAM"   (required: photos live in PSRAM)
  Put your Wi-Fi name/password and the camera token in arduino_secrets.h (never commit it).
*/
#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include "arduino_secrets.h"   // SECRET_SSID, SECRET_PASS, SECRET_CAMERA_TOKEN

// ---------- settings ----------
const char UPLOAD_URL[] = "https://ifyourreadingthisimstranded.us/v1/camera/water_tank_1";
const unsigned long UPLOAD_EVERY_MS = 3000;
// -------------------------------

// XIAO ESP32-S3 Sense camera pins (same as Espressif's CameraWebServer example)
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  10
#define SIOD_GPIO_NUM  40
#define SIOC_GPIO_NUM  39
#define Y9_GPIO_NUM    48
#define Y8_GPIO_NUM    11
#define Y7_GPIO_NUM    12
#define Y6_GPIO_NUM    14
#define Y5_GPIO_NUM    16
#define Y4_GPIO_NUM    18
#define Y3_GPIO_NUM    17
#define Y2_GPIO_NUM    15
#define VSYNC_GPIO_NUM 38
#define HREF_GPIO_NUM  47
#define PCLK_GPIO_NUM  13

WiFiClientSecure tls;
HTTPClient http;
WebServer aimPage(80);
unsigned long lastUpload = 0;
int failsInARow = 0;

bool startCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;
  c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;
  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;
  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;
  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAMESIZE_VGA;          // 640x480: plenty for Gemini, ~30 KB per photo
  c.jpeg_quality = 12;                   // 0-63, lower = better
  c.fb_count = 2;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;      // always hand out the newest frame
  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("camera init failed (0x%x): is the camera board clicked on firmly?\n", err);
    return false;
  }
  return true;
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("Connecting to Wi-Fi \"%s\" ...\n", SECRET_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                  // faster, steadier uploads
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  for (int i = 0; WiFi.status() != WL_CONNECTED; i++) {
    delay(500);
    if (i == 30) {
      Serial.println("  still not connected (2.4 GHz network? right password? antenna on?)");
      i = 0;
    }
  }
  Serial.printf("Wi-Fi OK. Aim the camera at: http://%s/\n", WiFi.localIP().toString().c_str());
}

bool uploadPhoto() {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("couldn't take a photo");
    return false;
  }
  http.begin(tls, UPLOAD_URL);
  http.setTimeout(10000);
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Camera-Token", SECRET_CAMERA_TOKEN);
  int code = http.POST(fb->buf, fb->len);
  size_t bytes = fb->len;
  esp_camera_fb_return(fb);
  if (code == 204) {
    http.end();
    Serial.printf("photo sent (%u bytes)\n", (unsigned)bytes);
    return true;
  }
  Serial.printf("upload failed: %d %s\n", code,
                code > 0 ? http.getString().c_str() : http.errorToString(code).c_str());
  if (code == 401) Serial.println("  -> SECRET_CAMERA_TOKEN doesn't match CAMERA_TOKEN on the server");
  if (code == 409) Serial.println("  -> the server's .env needs CAMERA=push");
  http.end();
  return false;
}

// ---------- local aiming page ----------
void handleAimPage() {
  aimPage.send(200, "text/html",
    "<!doctype html><meta name=viewport content='width=device-width'>"
    "<title>TADDPOLE camera</title><body style='margin:0;background:#000'>"
    "<img id=p style='width:100%'><script>"
    "setInterval(()=>p.src='/photo.jpg?'+Date.now(),1000)</script>");
}

void handleAimPhoto() {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    aimPage.send(503, "text/plain", "no photo");
    return;
  }
  aimPage.sendHeader("Cache-Control", "no-store");
  aimPage.send_P(200, "image/jpeg", (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("TADDPOLE camera (XIAO ESP32-S3 Sense) starting");
  if (!psramFound()) {
    Serial.println("No PSRAM! In Arduino IDE set Tools > PSRAM > OPI PSRAM, then upload again.");
    while (true) delay(1000);
  }
  if (!startCamera()) {
    delay(3000);
    ESP.restart();
  }
  connectWiFi();
  // Encrypted, but the server's certificate isn't checked (keeps the sketch simple).
  tls.setInsecure();
  http.setReuse(true);                   // keep one HTTPS connection open between photos
  aimPage.on("/", handleAimPage);
  aimPage.on("/photo.jpg", handleAimPhoto);
  aimPage.begin();
}

void loop() {
  aimPage.handleClient();
  if (millis() - lastUpload < UPLOAD_EVERY_MS) return;
  lastUpload = millis();
  connectWiFi();
  failsInARow = uploadPhoto() ? 0 : failsInARow + 1;
  if (failsInARow >= 20) {               // ~1 minute of failures: start fresh
    Serial.println("too many failures, restarting");
    ESP.restart();
  }
}

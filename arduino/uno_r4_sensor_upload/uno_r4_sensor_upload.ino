/*
  TADDPOLE water sensor: Arduino UNO R4 WiFi -> live backend, no laptop.

  Every 2 s: measure the distance to the water with the ultrasonic sensor, turn it into a
  depth, and POST it to the backend over HTTPS. The backend saves it into the same
  water_levels table the old laptop logger (arduino/sensor.ino) wrote to, so everything
  downstream (status, alerts, camera check, rerouting) works exactly as before.

  Endpoint: POST /admin/sensors/water_tank_1/simulate   body {"depth_cm": 12.3}
            header X-Admin-Token: <ADMIN_TOKEN from the server's .env>

  Wiring (HC-SR04 style sensor; change the pins below to match yours):
    VCC -> 5V    GND -> GND    TRIG -> pin 9    ECHO -> pin 10

  Needs: Boards Manager "Arduino UNO R4 Boards"; Library Manager "ArduinoHttpClient".
  Put your Wi-Fi name/password and the admin token in arduino_secrets.h (never commit it).
*/
#include <WiFiS3.h>
#include <ArduinoHttpClient.h>
#include "arduino_secrets.h"   // SECRET_SSID, SECRET_PASS, SECRET_ADMIN_TOKEN

// ---------- settings ----------
const char HOST[] = "ifyourreadingthisimstranded.us";
const char PATH[] = "/admin/sensors/water_tank_1/simulate";
const int TRIG_PIN = 9;
const int ECHO_PIN = 10;
// Distance from the sensor to the DRY tub bottom, in cm. 24 in = 60.96 cm.
// To calibrate: empty the tub, open Serial Monitor (115200), and copy the "distance" it prints.
const float BASELINE_CM = 60.96;
const unsigned long SEND_EVERY_MS = 2000;
// -------------------------------

WiFiSSLClient tls;
HttpClient http(tls, HOST, 443);
unsigned long lastSend = 0;

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("Connecting to Wi-Fi \"");
  Serial.print(SECRET_SSID);
  Serial.println("\" ...");
  while (WiFi.status() != WL_CONNECTED) {
    WiFi.begin(SECRET_SSID, SECRET_PASS);
    for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; i++) delay(500);
    if (WiFi.status() != WL_CONNECTED) Serial.println("  not yet, retrying (2.4 GHz network? right password?)");
  }
  Serial.print("Wi-Fi OK, IP ");
  Serial.println(WiFi.localIP());
}

// One ping -> distance in cm, or -1 if no echo came back.
float pingCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long us = pulseIn(ECHO_PIN, HIGH, 30000UL);   // ~5 m max
  if (us == 0) return -1;
  return us * 0.0343 / 2.0;
}

// Median of 5 pings, so one bad echo doesn't count. -1 if most pings failed.
float distanceCm() {
  float v[5];
  int n = 0;
  for (int i = 0; i < 5; i++) {
    float d = pingCm();
    if (d > 0) v[n++] = d;
    delay(60);                                            // let the last echo die out
  }
  if (n < 3) return -1;
  for (int i = 1; i < n; i++) {                           // tiny insertion sort
    float x = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
    v[j + 1] = x;
  }
  return v[n / 2];
}

bool sendDepth(float depthCm) {
  String body = "{\"depth_cm\":" + String(depthCm, 2) + "}";
  http.beginRequest();
  http.post(PATH);
  http.sendHeader("Content-Type", "application/json");
  http.sendHeader("Content-Length", body.length());
  http.sendHeader("X-Admin-Token", SECRET_ADMIN_TOKEN);
  http.beginBody();
  http.print(body);
  http.endRequest();
  int status = http.responseStatusCode();
  String reply = http.responseBody();                     // read it all so the connection can be reused
  if (status == 200) return true;
  Serial.print("  server said ");
  Serial.print(status);
  Serial.print(": ");
  Serial.println(reply);
  if (status == 401) Serial.println("  -> wrong SECRET_ADMIN_TOKEN in arduino_secrets.h");
  if (status < 0) http.stop();                             // network error: reconnect next time
  return false;
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  Serial.println("TADDPOLE sensor (UNO R4 WiFi) starting");
  connectWiFi();
  http.connectionKeepAlive();                              // reuse one HTTPS connection
  http.setHttpResponseTimeout(8000);
}

void loop() {
  if (millis() - lastSend < SEND_EVERY_MS) return;
  lastSend = millis();
  connectWiFi();

  float dist = distanceCm();
  if (dist < 0) {
    Serial.println("no echo from the sensor (check wiring / aim)");
    return;
  }
  float depth = BASELINE_CM - dist;
  if (depth < 0) depth = 0;                                // a bit of noise below the dry bottom

  Serial.print("distance ");
  Serial.print(dist, 1);
  Serial.print(" cm -> depth ");
  Serial.print(depth, 1);
  Serial.print(" cm  ");
  Serial.println(sendDepth(depth) ? "sent" : "NOT sent");
}

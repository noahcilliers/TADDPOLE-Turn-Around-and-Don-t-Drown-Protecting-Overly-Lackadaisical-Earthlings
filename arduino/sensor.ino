import serial
import requests
import psycopg2
import time
import re

# 1. Arduino Serial Settings
SERIAL_PORT = "COM3"  # Update to your Arduino's port
BAUD_RATE = 9600

# 2. Tiger Cloud (TimescaleDB) Connection String
DB_CONNECTION_STRING = ""

# 3. Discord Webhook URL (Optional - leave blank "" to disable Discord)
WEBHOOK_URL = ""

# 4. Logging Interval (in seconds)
LOG_INTERVAL = 2
SENSOR_NAME = "water_tank_1"

def extract_inches(raw_text):
    # Check if already in inches
    in_match = re.search(r"([0-9]+\.?[0-9]*)\s*in", raw_text, re.IGNORECASE)
    if in_match:
        return round(float(in_match.group(1)), 2)

    # Convert from centimeters if needed
    cm_match = re.search(r"([0-9]+\.?[0-9]*)\s*cm", raw_text, re.IGNORECASE)
    if cm_match:
        return round(float(cm_match.group(1)) / 2.54, 2)

    return None

print("Connecting to Tiger Cloud database...")
conn = psycopg2.connect(DB_CONNECTION_STRING)
cursor = conn.cursor()

print(f"Connecting to Arduino on {SERIAL_PORT}...")
ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
time.sleep(2)
print("Connected! Logging inches to TigerDB...")

last_log_time = 0

try:
    while True:
        if ser.in_waiting > 0:
            line = ser.readline().decode("utf-8", errors="ignore").strip()
            
            if line:
                inches = extract_inches(line)
                current_time = time.time()

                if inches is not None and (current_time - last_log_time >= LOG_INTERVAL):
                    # 1. Insert into TigerDB
                    cursor.execute(
                        "INSERT INTO water_levels (time, sensor_id, distance_inches) VALUES (NOW(), %s, %s);",
                        (SENSOR_NAME, inches)
                    )
                    conn.commit()
                    print(f"-> Saved to TigerDB: {inches} in")

                    # 2. Send to Discord (if URL is set)
                    if WEBHOOK_URL:
                        payload = {"content": f"💧 **Water Sensor:** {inches} in"}
                        requests.post(WEBHOOK_URL, json=payload)

                    last_log_time = current_time

except KeyboardInterrupt:
    print("\nStopping logger...")
finally:
    cursor.close()
    conn.close()
    ser.close()

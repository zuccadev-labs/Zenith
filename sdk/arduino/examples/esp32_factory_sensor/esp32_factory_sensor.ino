/**
 * ZenithIoT SDK — Ejemplo Completo ESP32
 * =======================================
 * Hardware recomendado: ESP32 WROOM-32D
 *
 * Sensores de ejemplo:
 *   - DHT22    → temperatura + humedad (GPIO 4)
 *   - BMP280   → presión barométrica (I2C: SDA=21, SCL=22)
 *   - ACS712   → corriente eléctrica (GPIO 34 ADC)
 *   - LED RGB  → actuador controlado por comandos (GPIO 25, 26, 27)
 *
 * Setup en Zenith Backend:
 *   1. POST /iot/devices  → registrar el dispositivo
 *   2. POST /iot/devices/{id}/token → obtener el Device Token
 *   3. Pegar el token en DEVICE_TOKEN abajo
 *
 * Compilar con:
 *   Board: "ESP32 Dev Module"
 *   Partition: "Default 4MB with spiffs"
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include "ZenithIoT.h"

// ── CONFIGURA AQUÍ ──────────────────────────────────────────────────────────

// WiFi
const char* WIFI_SSID     = "TuRed";
const char* WIFI_PASSWORD = "TuContraseña";

// Zenith Backend
const char* ZENITH_MQTT_HOST  = "192.168.14.50";  // IP del servidor lab
const uint16_t ZENITH_PORT    = 51883;              // Puerto MQTT lab (51883 → 1883)
const char* DEVICE_ID         = "esp32-factory-01";
const char* DEVICE_NAMESPACE  = "my-factory";
const char* DEVICE_TOKEN      = "zen-iot-xxxx-xxxx-xxxx"; // Token generado en el backend

// GPIO
const int PIN_LED_R = 25;
const int PIN_LED_G = 26;
const int PIN_LED_B = 27;
const int PIN_CURR  = 34;  // ADC para sensor de corriente ACS712

// Intervalos
const uint32_t TELEMETRY_INTERVAL_MS = 5000;  // Enviar telemetría cada 5 segundos
const uint32_t ALERT_TEMP_THRESHOLD  = 45.0f; // Temperatura crítica °C

// ── INSTANCIA GLOBAL ─────────────────────────────────────────────────────────

WiFiClient    wifiClient;
ZenithDevice  device(DEVICE_ID, DEVICE_NAMESPACE, DEVICE_TOKEN, ZENITH_MQTT_HOST, ZENITH_PORT);

uint32_t lastTelemetry = 0;
float    simTemperature = 22.0f;  // Simulación de sensor DHT22

// ── CALLBACK DE COMANDOS ─────────────────────────────────────────────────────

/**
 * Se llama cuando el backend envía un comando al dispositivo.
 * Ejemplo: POST /iot/devices/esp32-factory-01/command
 *          Body: {"action": "SET_LED", "r": 255, "g": 0, "b": 0}
 */
void onZenithCommand(const char* commandType, JsonDocument& payload) {
  Serial.print("[CMD] Received: ");
  Serial.println(commandType);

  if (strcmp(commandType, "SET_LED") == 0) {
    int r = payload["r"] | 0;
    int g = payload["g"] | 0;
    int b = payload["b"] | 0;
    analogWrite(PIN_LED_R, r);
    analogWrite(PIN_LED_G, g);
    analogWrite(PIN_LED_B, b);
    Serial.printf("[CMD] LED set to R=%d G=%d B=%d\n", r, g, b);
  }

  else if (strcmp(commandType, "REBOOT") == 0) {
    Serial.println("[CMD] Rebooting in 2 seconds...");
    delay(2000);
    ESP.restart();
  }

  else if (strcmp(commandType, "SET_INTERVAL") == 0) {
    // Cambiar intervalo de telemetría remotamente
    // uint32_t ms = payload["ms"] | 5000;
    // TELEMETRY_INTERVAL_MS = ms;  // En producción usar variable global
    Serial.println("[CMD] Interval change received (implement as needed)");
  }

  else {
    Serial.printf("[CMD] Unknown command: %s\n", commandType);
  }
}

// ── SETUP ────────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n══════════════════════════════════════");
  Serial.println("  ZenithIoT SDK — ESP32 Example");
  Serial.println("  Version: " ZENITH_SDK_VERSION);
  Serial.println("══════════════════════════════════════\n");

  // Configurar GPIO
  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);
  analogWrite(PIN_LED_R, 0);
  analogWrite(PIN_LED_G, 0);
  analogWrite(PIN_LED_B, 50); // LED azul en boot

  // Conectar WiFi
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n[WiFi] Connected!");
  Serial.print("[WiFi] IP: ");
  Serial.println(WiFi.localIP());

  // Configurar cliente Zenith
  device.setWifiClient(wifiClient);
  device.setDebug(true);                      // Logs por Serial
  device.setHeartbeatInterval(30000);          // Heartbeat cada 30s
  device.onCommand(onZenithCommand);           // Registrar callback

  // Conectar a broker MQTT Zenith
  bool ok = device.connect();
  if (ok) {
    Serial.println("[Zenith] ✅ Connected to Zenith Backend!");
    // LED verde = conectado
    analogWrite(PIN_LED_R, 0);
    analogWrite(PIN_LED_G, 50);
    analogWrite(PIN_LED_B, 0);
  } else {
    Serial.println("[Zenith] ❌ Connection failed. Check MQTT host and token.");
    // LED rojo = error
    analogWrite(PIN_LED_R, 50);
    analogWrite(PIN_LED_G, 0);
    analogWrite(PIN_LED_B, 0);
  }
}

// ── LOOP ─────────────────────────────────────────────────────────────────────

void loop() {
  // OBLIGATORIO: mantiene conexión MQTT + heartbeat
  device.loop();

  uint32_t now = millis();

  // Enviar telemetría cada TELEMETRY_INTERVAL_MS
  if (now - lastTelemetry >= TELEMETRY_INTERVAL_MS) {
    lastTelemetry = now;

    // ── Leer sensores ────────────────────────────────────────────────────
    // En producción: reemplazar con lecturas reales de DHT22, BMP280, etc.
    simTemperature += random(-10, 10) / 10.0f; // Simulación

    float temperature = simTemperature;  // DHT22: dht.readTemperature()
    float humidity    = 65.0f;           // DHT22: dht.readHumidity()
    float pressure    = 1013.25f;        // BMP280: bmp.readPressure() / 100.0f

    // Corriente (ACS712 30A): (ADC_raw * 3.3V / 4095) / 0.066V_per_A - offset
    int adcRaw = analogRead(PIN_CURR);
    float voltage = (adcRaw * 3.3f) / 4095.0f;
    float current = (voltage - 1.65f) / 0.066f; // ACS712-30A sensitivity

    // ── Batch telemetría (SenML) ─────────────────────────────────────────
    ZenithMetric metrics[] = {
      {"temperature", temperature, "Cel",  false, nullptr},
      {"humidity",    humidity,    "%RH",  false, nullptr},
      {"pressure",    pressure,    "hPa",  false, nullptr},
      {"current",     current,     "A",    false, nullptr},
      {"uptime",      (float)(now / 1000), "s", false, nullptr},
      {"rssi",        (float)WiFi.RSSI(),  "dBm", false, nullptr},
    };

    bool published = device.sendBatch(metrics, 6);
    if (published) {
      Serial.printf("[Telemetry] temp=%.1f°C hum=%.1f%% pres=%.2fhPa curr=%.2fA\n",
        temperature, humidity, pressure, current);
    }

    // ── Detección de anomalía → Alert ────────────────────────────────────
    if (temperature > ALERT_TEMP_THRESHOLD) {
      device.sendAlert(
        "HIGH_TEMPERATURE",    // Código de alerta (mapea al backend)
        "critical",            // Severidad
        temperature,           // Valor actual
        ALERT_TEMP_THRESHOLD   // Umbral
      );
      // LED rojo = alerta
      analogWrite(PIN_LED_R, 255);
      analogWrite(PIN_LED_G, 0);
      analogWrite(PIN_LED_B, 0);
    } else {
      // LED verde = normal
      analogWrite(PIN_LED_R, 0);
      analogWrite(PIN_LED_G, 30);
      analogWrite(PIN_LED_B, 0);
    }
  }

  // WiFi watchdog — reconectar si se pierde
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Connection lost — reconnecting...");
    WiFi.reconnect();
    delay(5000);
  }
}

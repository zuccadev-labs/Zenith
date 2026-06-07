/**
 * ZenithIoT Arduino SDK
 * =====================
 * Librería para conectar dispositivos Arduino/ESP32/ESP8266 a Zenith Backend.
 *
 * Compatibilidad:
 *   - Arduino Uno/Mega/Nano (con Ethernet Shield W5100/W5500)
 *   - ESP8266 (NodeMCU, Wemos D1)
 *   - ESP32 (WROOM, S3, C3) ← RECOMENDADO
 *   - Arduino MKR WiFi 1010
 *   - Raspberry Pi Pico W
 *
 * Protocolo: MQTT 3.1.1 sobre TCP/WebSocket
 * Formato:   SenML (RFC 8428) — estándar industrial IoT
 *
 * Topics Zenith:
 *   PUB: zenith/telemetry/{namespace}/{deviceId}   → Enviar datos de sensores
 *   PUB: zenith/status/{namespace}/{deviceId}       → heartbeat (online/offline)
 *   SUB: zenith/commands/{namespace}/{deviceId}     → Recibir comandos del servidor
 *   PUB: zenith/alerts/{namespace}/{deviceId}       → Alertas críticas
 *
 * Instalación:
 *   1. Descargar ZenithIoT.h y ZenithIoT.cpp a tu carpeta de librería Arduino
 *   2. Instalar dependencias:
 *      - PubSubClient (Nick O'Leary)       → MQTT client
 *      - ArduinoJson (Benoit Blanchon)     → JSON parsing
 *      - WiFi / Ethernet según tu hardware
 *
 * EJEMPLO COMPLETO al final de este archivo.
 */

#ifndef ZENITH_IOT_H
#define ZENITH_IOT_H

#include <Arduino.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

#ifdef ESP32
  #include <WiFi.h>
  #include <WiFiClient.h>
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <WiFiClient.h>
#else
  // Arduino con Ethernet Shield
  #include <Ethernet.h>
  #include <EthernetClient.h>
  #define USE_ETHERNET
#endif

// ── Constantes ──────────────────────────────────────────────────────────────

#define ZENITH_MAX_METRICS       16      // Máx métricas por payload SenML
#define ZENITH_TOPIC_MAX_LEN     128     // Máx longitud de topic MQTT
#define ZENITH_PAYLOAD_MAX_LEN   512     // Máx tamaño de payload JSON
#define ZENITH_SDK_VERSION       "1.0.0"
#define ZENITH_DEFAULT_QOS       1       // QoS 1: at least once

// ── Tipos ────────────────────────────────────────────────────────────────────

/**
 * SenML Record — RFC 8428
 * Una medición de un sensor en un instante de tiempo.
 */
struct ZenithMetric {
  const char* name;        // Nombre de la métrica (ej. "temperature")
  float       value;       // Valor numérico
  const char* unit;        // Unidad SenML (ej. "Cel", "hPa", "%RH", "A", "V", "W", "m/s2")
  bool        isString;    // Si true, usar stringValue en lugar de value
  const char* stringValue; // Valor string (ej. estado "RUNNING"/"STOPPED")
};

/** Callback para recibir comandos del servidor */
typedef void (*ZenithCommandCallback)(const char* commandType, JsonDocument& payload);

/** Callback para reconexión Wi-Fi/Ethernet */
typedef void (*ZenithConnectCallback)();

// ── Clase ZenithDevice ───────────────────────────────────────────────────────

class ZenithDevice {
public:
  /**
   * Constructor
   *
   * @param deviceId    ID único del dispositivo (ej. "pump-A3", "sensor-floor-2-01")
   * @param namespace   Namespace del tenant (ej. "factory-a", "building-7")
   * @param deviceToken Token de autenticación generado con POST /iot/devices/:id/token
   * @param mqttHost    IP o hostname del servidor EMQX (ej. "192.168.14.50")
   * @param mqttPort    Puerto MQTT TCP (default: 1883, lab: 51883 mappea a 1883)
   */
  ZenithDevice(
    const char* deviceId,
    const char* namespace_,
    const char* deviceToken,
    const char* mqttHost,
    uint16_t    mqttPort = 1883
  );

  // ── Configuración ──────────────────────────────────────────────────────

  /** Configura el cliente WiFi (ESP8266/ESP32) */
  void setWifiClient(WiFiClient& client);

#ifdef USE_ETHERNET
  /** Configura el cliente Ethernet (Arduino con shield) */
  void setEthernetClient(EthernetClient& client);
#endif

  /** Registra el callback para recibir comandos del servidor */
  void onCommand(ZenithCommandCallback callback);

  /**
   * Establece el intervalo de heartbeat (online/offline status).
   * Default: 30000ms (30 segundos)
   */
  void setHeartbeatInterval(uint32_t intervalMs);

  /** Habilita logs de debug por Serial */
  void setDebug(bool enabled);

  // ── Conexión ──────────────────────────────────────────────────────────

  /**
   * Conecta al broker MQTT y suscribe al topic de comandos.
   * Llama en setup().
   *
   * @return true si la conexión fue exitosa
   */
  bool connect();

  /**
   * Mantiene la conexión MQTT activa y envía heartbeat.
   * DEBE llamarse en loop() en cada ciclo.
   */
  void loop();

  /** Desconecta del broker */
  void disconnect();

  /** true si está conectado al broker */
  bool isConnected() const;

  // ── Telemetría ────────────────────────────────────────────────────────

  /**
   * Envía una sola métrica (shorthand de sendTelemetry).
   *
   * @example
   *   device.send("temperature", 22.5f, "Cel");
   *   device.send("humidity",    65.0f, "%RH");
   *   device.send("state",       "RUNNING"); // String
   */
  bool send(const char* metricName, float value, const char* unit = nullptr);
  bool send(const char* metricName, const char* stringValue);

  /**
   * Envía múltiples métricas en un solo payload SenML (eficiente).
   * Reduce el número de mensajes MQTT — preferido para batching.
   *
   * @example
   *   ZenithMetric metrics[] = {
   *     {"temperature", 22.5f, "Cel"},
   *     {"humidity",    65.0f, "%RH"},
   *     {"pressure",    1013.25f, "hPa"},
   *   };
   *   device.sendBatch(metrics, 3);
   */
  bool sendBatch(ZenithMetric* metrics, uint8_t count);

  /**
   * Envía una alerta crítica al servidor.
   * Se publica con QoS 2 (exactly-once) y retain=true.
   *
   * @example
   *   device.sendAlert("HIGH_TEMPERATURE", "critical", 95.2f, 85.0f);
   */
  bool sendAlert(
    const char* alertCode,
    const char* severity,   // "info" | "warning" | "critical" | "emergency"
    float       value,
    float       threshold
  );

  // ── Getters ───────────────────────────────────────────────────────────
  const char* getDeviceId()   const { return _deviceId; }
  const char* getNamespace()  const { return _namespace; }
  uint32_t    getUptime()     const { return millis() / 1000; }

private:
  const char*          _deviceId;
  const char*          _namespace;
  const char*          _deviceToken;
  const char*          _mqttHost;
  uint16_t             _mqttPort;
  bool                 _debug;
  uint32_t             _heartbeatInterval;
  uint32_t             _lastHeartbeat;
  uint32_t             _lastReconnect;
  PubSubClient*        _mqtt;
  ZenithCommandCallback _commandCallback;

  char _telemetryTopic[ZENITH_TOPIC_MAX_LEN];
  char _statusTopic[ZENITH_TOPIC_MAX_LEN];
  char _commandTopic[ZENITH_TOPIC_MAX_LEN];
  char _alertTopic[ZENITH_TOPIC_MAX_LEN];

  void _buildTopics();
  bool _reconnect();
  void _sendHeartbeat(bool online);
  void _mqttCallback(char* topic, byte* payload, unsigned int length);
  bool _publishSenML(ZenithMetric* metrics, uint8_t count);
  void _log(const char* msg);
  void _logf(const char* fmt, ...);
};

#endif // ZENITH_IOT_H

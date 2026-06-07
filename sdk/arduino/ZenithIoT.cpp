/**
 * ZenithIoT Arduino SDK — Implementación
 * =======================================
 * Autor:    Zenith Labs (open source)
 * Versión:  1.0.0
 * Licencia: MIT
 *
 * Dependencias:
 *   - PubSubClient >= 2.8   (Nick O'Leary)
 *   - ArduinoJson >= 7.0    (Benoit Blanchon)
 */

#include "ZenithIoT.h"
#include <stdarg.h>

// ── Constructor ──────────────────────────────────────────────────────────────

ZenithDevice::ZenithDevice(
  const char* deviceId,
  const char* namespace_,
  const char* deviceToken,
  const char* mqttHost,
  uint16_t    mqttPort
) {
  _deviceId         = deviceId;
  _namespace        = namespace_;
  _deviceToken      = deviceToken;
  _mqttHost         = mqttHost;
  _mqttPort         = mqttPort;
  _debug            = false;
  _heartbeatInterval = 30000;
  _lastHeartbeat    = 0;
  _lastReconnect    = 0;
  _commandCallback  = nullptr;
  _mqtt             = nullptr;

  _buildTopics();
}

// ── Configuración ─────────────────────────────────────────────────────────────

void ZenithDevice::setWifiClient(WiFiClient& client) {
  _mqtt = new PubSubClient(client);
  _mqtt->setServer(_mqttHost, _mqttPort);
  _mqtt->setBufferSize(ZENITH_PAYLOAD_MAX_LEN);

  // Captura el puntero 'this' para el callback estático
  ZenithDevice* self = this;
  _mqtt->setCallback([self](char* topic, byte* payload, unsigned int length) {
    self->_mqttCallback(topic, payload, length);
  });
}

#ifdef USE_ETHERNET
void ZenithDevice::setEthernetClient(EthernetClient& client) {
  _mqtt = new PubSubClient(client);
  _mqtt->setServer(_mqttHost, _mqttPort);
  _mqtt->setBufferSize(ZENITH_PAYLOAD_MAX_LEN);
  ZenithDevice* self = this;
  _mqtt->setCallback([self](char* topic, byte* payload, unsigned int length) {
    self->_mqttCallback(topic, payload, length);
  });
}
#endif

void ZenithDevice::onCommand(ZenithCommandCallback callback) {
  _commandCallback = callback;
}

void ZenithDevice::setHeartbeatInterval(uint32_t intervalMs) {
  _heartbeatInterval = intervalMs;
}

void ZenithDevice::setDebug(bool enabled) {
  _debug = enabled;
}

// ── Conexión ──────────────────────────────────────────────────────────────────

bool ZenithDevice::connect() {
  if (!_mqtt) {
    _log("ERROR: No client set. Call setWifiClient() or setEthernetClient() first.");
    return false;
  }

  _log("Connecting to Zenith MQTT broker...");
  return _reconnect();
}

void ZenithDevice::loop() {
  if (!_mqtt) return;

  if (!_mqtt->connected()) {
    uint32_t now = millis();
    // Reconexión cada 5 segundos para no saturar el broker
    if (now - _lastReconnect > 5000) {
      _lastReconnect = now;
      _reconnect();
    }
  } else {
    _mqtt->loop();

    // Enviar heartbeat periódico
    uint32_t now = millis();
    if (now - _lastHeartbeat > _heartbeatInterval) {
      _lastHeartbeat = now;
      _sendHeartbeat(true);
    }
  }
}

void ZenithDevice::disconnect() {
  if (_mqtt && _mqtt->connected()) {
    _sendHeartbeat(false);
    _mqtt->disconnect();
    _log("Disconnected from broker.");
  }
}

bool ZenithDevice::isConnected() const {
  return _mqtt && _mqtt->connected();
}

// ── Telemetría ────────────────────────────────────────────────────────────────

bool ZenithDevice::send(const char* metricName, float value, const char* unit) {
  ZenithMetric m = { metricName, value, unit, false, nullptr };
  return _publishSenML(&m, 1);
}

bool ZenithDevice::send(const char* metricName, const char* stringValue) {
  ZenithMetric m = { metricName, 0.0f, nullptr, true, stringValue };
  return _publishSenML(&m, 1);
}

bool ZenithDevice::sendBatch(ZenithMetric* metrics, uint8_t count) {
  return _publishSenML(metrics, count);
}

bool ZenithDevice::sendAlert(
  const char* alertCode,
  const char* severity,
  float value,
  float threshold
) {
  if (!_mqtt || !_mqtt->connected()) return false;

  StaticJsonDocument<256> doc;
  doc["deviceId"]   = _deviceId;
  doc["namespace"]  = _namespace;
  doc["code"]       = alertCode;
  doc["severity"]   = severity;
  doc["value"]      = value;
  doc["threshold"]  = threshold;
  doc["timestamp"]  = millis();  // En producción: usar NTP para timestamp real
  doc["resolved"]   = false;

  char payload[256];
  serializeJson(doc, payload, sizeof(payload));

  _logf("ALERT [%s] %s: %.2f (threshold: %.2f)", severity, alertCode, value, threshold);

  // QoS 2 + retain para alertas críticas
  return _mqtt->publish(_alertTopic, (const uint8_t*)payload, strlen(payload), true);
}

// ── Privados ──────────────────────────────────────────────────────────────────

void ZenithDevice::_buildTopics() {
  snprintf(_telemetryTopic, ZENITH_TOPIC_MAX_LEN,
    "zenith/telemetry/%s/%s", _namespace, _deviceId);
  snprintf(_statusTopic, ZENITH_TOPIC_MAX_LEN,
    "zenith/status/%s/%s", _namespace, _deviceId);
  snprintf(_commandTopic, ZENITH_TOPIC_MAX_LEN,
    "zenith/commands/%s/%s", _namespace, _deviceId);
  snprintf(_alertTopic, ZENITH_TOPIC_MAX_LEN,
    "zenith/alerts/%s/%s", _namespace, _deviceId);
}

bool ZenithDevice::_reconnect() {
  if (!_mqtt) return false;

  // Client ID único: "zenith-" + deviceId (máx 23 chars para MQTT 3.1.1)
  char clientId[24];
  snprintf(clientId, sizeof(clientId), "zen-%s", _deviceId);

  // LAST WILL: publicar "offline" al desconectarse inesperadamente
  const char* lwt_payload = "offline";
  _mqtt->setKeepAlive(15);

  bool connected = _mqtt->connect(
    clientId,
    _deviceId,    // username = deviceId
    _deviceToken, // password = deviceToken
    _statusTopic,       // LWT topic
    ZENITH_DEFAULT_QOS, // LWT QoS
    true,               // LWT retain
    lwt_payload         // LWT message
  );

  if (connected) {
    _logf("Connected! ClientID: %s", clientId);

    // Suscribirse al topic de comandos (QoS 1)
    _mqtt->subscribe(_commandTopic, ZENITH_DEFAULT_QOS);
    _logf("Subscribed to: %s", _commandTopic);

    // Publicar online inmediatamente
    _sendHeartbeat(true);
  } else {
    _logf("Connection failed. State: %d", _mqtt->state());
    // Códigos de error:
    //  -4 MQTT_CONNECTION_TIMEOUT
    //  -3 MQTT_CONNECTION_LOST
    //  -2 MQTT_CONNECT_FAILED
    //  -1 MQTT_DISCONNECTED
    //   1 MQTT_CONNECT_BAD_PROTOCOL
    //   2 MQTT_CONNECT_BAD_CLIENT_ID
    //   3 MQTT_CONNECT_UNAVAILABLE
    //   4 MQTT_CONNECT_BAD_CREDENTIALS  ← token inválido
    //   5 MQTT_CONNECT_UNAUTHORIZED
  }

  return connected;
}

void ZenithDevice::_sendHeartbeat(bool online) {
  if (!_mqtt) return;
  const char* status = online ? "online" : "offline";
  _mqtt->publish(_statusTopic, status, true); // retain=true
}

void ZenithDevice::_mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (!_commandCallback) return;

  // Parse JSON del payload
  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, payload, length);

  if (err) {
    _logf("Command JSON parse error: %s", err.c_str());
    return;
  }

  const char* commandType = doc["action"] | doc["type"] | "unknown";
  _logf("Command received: %s", commandType);
  _commandCallback(commandType, doc);
}

bool ZenithDevice::_publishSenML(ZenithMetric* metrics, uint8_t count) {
  if (!_mqtt || !_mqtt->connected()) {
    _log("Not connected — cannot publish.");
    return false;
  }

  // Construir payload SenML (RFC 8428) como array JSON
  // [{"bn":"urn:dev:mac:<deviceId>/","bt":<timestamp_s>,"n":"temperature","v":22.5,"u":"Cel"}]
  StaticJsonDocument<ZENITH_PAYLOAD_MAX_LEN> doc;
  JsonArray array = doc.to<JsonArray>();

  uint32_t ts = millis(); // En producción: timestamp Unix real via NTP

  for (uint8_t i = 0; i < count && i < ZENITH_MAX_METRICS; i++) {
    JsonObject record = array.createNestedObject();

    if (i == 0) {
      // Base Name y Base Time solo en el primer record (optimización SenML)
      char baseName[64];
      snprintf(baseName, sizeof(baseName), "urn:dev:id:%s/", _deviceId);
      record["bn"] = baseName;
      record["bt"] = ts;  // ms desde boot — el servidor lo normaliza a Unix ms
    }

    record["n"] = metrics[i].name;

    if (metrics[i].isString) {
      record["vs"] = metrics[i].stringValue;
    } else {
      record["v"] = metrics[i].value;
    }

    if (metrics[i].unit && !metrics[i].isString) {
      record["u"] = metrics[i].unit;
    }
  }

  // Serializar a buffer
  char payload[ZENITH_PAYLOAD_MAX_LEN];
  size_t len = serializeJson(doc, payload, sizeof(payload));

  if (len >= ZENITH_PAYLOAD_MAX_LEN) {
    _log("Payload too large — reduce metric count.");
    return false;
  }

  if (_debug) {
    _logf("PUB [%s]: %s", _telemetryTopic, payload);
  }

  return _mqtt->publish(_telemetryTopic, (const uint8_t*)payload, len, false);
}

void ZenithDevice::_log(const char* msg) {
  if (_debug) {
    Serial.print("[ZenithIoT] ");
    Serial.println(msg);
  }
}

void ZenithDevice::_logf(const char* fmt, ...) {
  if (!_debug) return;
  char buf[128];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  _log(buf);
}

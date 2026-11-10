# 05 — Observabilidad Corporativa (OpenTelemetry) y Documentación Viva (OpenAPI)

> ℹ️ **Estado: histórico.** Investigación previa al diseño actual; sus imports y rutas (`@zenith/core`, `src/cli/`…) no son los del código. Índice vigente: [docs/index.md](../index.md).

> **Fase**: Diseño Arquitectónico (System Design)  
> **Autor**: Equipo Zenith — @zuccadev-labs  
> **Fecha**: 2026-05-22  
> **Estado**: Draft v1.0  
> **Prerrequisito**: [03_zenith_architecture.md](./03_zenith_architecture.md)

---

## 1. Observabilidad Corporativa: OpenTelemetry (OTel)

En un ecosistema distribuido (Polyglot Persistence con MongoDB y ScyllaDB, Streaming Media y WebRTC), depender de `console.log` para la depuración es inviable. Necesitamos rastrear una petición desde que entra al Gateway, pasa por la validación criptográfica, hasta que interactúa con la base de datos.

### 1.1 Decisión Arquitectónica (ADR)
Se descarta el Logger estático monolítico de Parse Server y se adopta el estándar mundial de la Cloud Native Computing Foundation (CNCF): **OpenTelemetry**.

**Justificación:**
- **Estándar de la Industria:** Es agnóstico al proveedor. Nos permite exportar métricas, logs y trazas (Traces) hacia Jaeger, Datadog, Prometheus o Grafana sin cambiar el código de Zenith.
- **Trazabilidad Distribuida:** Utiliza "Context Propagation" (W3C Trace Context) para pasar el ID de la traza entre microservicios.
- **Implementación en Zenith:** Se utilizará `@opentelemetry/sdk-trace-base` para instanciar un `TracerProvider` real y un `OTLPTraceExporter`. Cada Trait (como `SchemaTrait` o `MongoAdapter`) añadirá eventos al *Span* activo.

---

## 2. API Contract: Barrits y OpenAPI v3.1

Parse Server no posee una especificación nativa de Swagger/OpenAPI. Su API REST simplemente "existe" y depende de la documentación estática escrita por humanos. Esto causa desincronización entre el código y los SDKs.

### 2.1 Decisión Arquitectónica (ADR)
Se adopta **OpenAPI v3.1** como la fuente de la verdad para todas las rutas HTTP, generado automáticamente (Inferencia de AST) usando `@zuccadev-labs/barrits/schema`.

**Justificación:**
- **El Antipatrón del Router Manual:** Mantener un `router.ts` con cientos de líneas `router.get(...)` es código redundante.
- **Inferencia Mágica (Zero-Hallucination):** Barrits puede leer etiquetas de metadatos (JSDoc `@barrits-trait http-endpoint`) y generar el JSON de Swagger dinámicamente. Esto garantiza que la documentación siempre refleja matemáticamente el código desplegado.
- **Descentralización:** El Trait de Usuarios será dueño de `/users`, y el Trait de Streaming dueño de `/media`. El acoplamiento desaparece.

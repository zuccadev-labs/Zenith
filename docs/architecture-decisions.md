# Architecture Decision Record (ADR): Media Streaming & WebRTC Scalability

## Contexto y Problema
Zenith requiere capacidades nativas de streaming de audio y video en tiempo real, operando sobre WebRTC (WHIP/WHEP) para lograr latencias ultra bajas. 

El dilema arquitectónico radica en **dónde y cómo** se enrutan los paquetes de medios. Un flujo de video típico genera miles de paquetes UDP por segundo por cada cliente conectado.
- En una sala de streaming con 1 emisor y 1,000 espectadores, el servidor (Selective Forwarding Unit o SFU) debe replicar y enrutar 1,000 veces cada paquete de video en tiempo real.
- Las plataformas construidas puramente en ecosistemas V8 (Node.js / Deno) manejan eficientemente I/O asíncrono (WebSockets, HTTP), pero sufren bloqueos en el Event Loop y una alta recolección de basura (Garbage Collection) cuando se ven forzadas a procesar arreglos binarios crudos a tasas extremadamente altas.

## Alternativas Evaluadas

### Opción 1: SFU Nativo en Deno/TypeScript
Construir el motor de retransmisión directamente en Zenith usando las APIs de Deno.
* **Pros:** Un solo binario, ecosistema unificado, fácil despliegue.
* **Cons:** Cuellos de botella severos de CPU, penalizaciones por el Garbage Collector bajo alta carga, límite bajo de espectadores concurrentes por nodo antes de degradar la experiencia (latencia inducida).

### Opción 2: Separación de Planos (Control Plane vs Data Plane)
Zenith actúa como el "Control Plane" gestionando la autenticación, señalización (SDP), permisos (JWT) y estados en memoria, pero delega el "Data Plane" (reenvío masivo de paquetes UDP de video/audio) a un binario externo nativo escrito exclusivamente en **Rust**.
* **Pros:** Separación estricta de responsabilidades, concurrencia masiva segura gracias al modelo de Ownership de Rust, cero recolección de basura (Zero-cost abstractions), y cero interferencia con la API REST principal de Zenith.
* **Cons:** Complejidad operativa al requerir orquestar el nodo Rust (SFU) junto a Zenith.

## Decisión Adoptada
Hemos decidido adoptar la **Opción 2: Separación de Planos usando Rust como motor Data Plane**.

Como ingenieros de sistemas a escala corporativa, el **Single Responsibility Principle (SRP)** también aplica a la topología de red:
1. **Control Plane (Zenith en Deno):** Se encarga de quién entra, quién sale, grabar el estado en la base de datos y proveer la API WHIP/WHEP (`MediaStreamTrait`). *Nota Corporativa: Para el almacenamiento de estado en memoria ultra-rápido de los streams y el Media LiveQuery, la arquitectura recomienda el uso de **ScyllaDB** (el mismo motor usado por Discord para su infraestructura en tiempo real), garantizando velocidad extrema sin cuellos de botella.*
2. **Data Plane (Zenith SFU en Rust vía FFI):** Manejará los túneles UDP crudos. Rust se acopla directamente al proceso de Deno usando **FFI (Foreign Function Interface)**. Al no levantar un servidor HTTP interno, eliminamos cualquier vector de ataque de red (como SSRF). Rust y Deno comparten el mismo espacio de memoria segura.

## Consecuencias
- La compilación generará una librería dinámica (`.dll` o `.so`) nativa de Rust (`zenith_sfu`), en lugar de un ejecutable independiente.
- El `MediaStreamTrait` de Zenith se convertirá en un orquestador que usa `Deno.dlopen` para conectarse a nivel de C-ABI (Application Binary Interface) con Rust.
- **Protección FFI (Buenas Prácticas):** La interfaz binaria será protegida previniendo fugas de memoria (Memory Leaks) al gestionar la transferencia de punteros entre JS y C, garantizando que Rust capture sus propios "Panics" mediante `catch_unwind` para evitar que un fallo en WebRTC derribe el servidor principal de Deno.
- Todo el proyecto está diseñado para eventualmente ser empaquetado y compilado como binarios nativos portables (Single Executable Applications) usando Rust y Deno Compile, garantizando despliegues DevOps sin dependencias externas.

---

# Architecture Decision Record (ADR): Orquestación Modular e Inteligencia Artificial AIOps (Fase 9 - 14)

## Contexto y Problema
En las fases avanzadas de desarrollo, surgió la necesidad de dotar a Zenith de las siguientes capacidades de grado corporativo:
1. **Topología Dinámica:** Capacidad de escalar diferentes módulos del servidor de forma asimétrica (ej: nodos dedicados solo a WebRTC, nodos dedicados solo a AI, nodos puramente HTTP).
2. **Data Plane Inter-Nodo Seguro:** Necesidad de comunicación de clúster sub-milisegundo sin sobrecargar el Event Loop de Deno.
3. **Agentes de IA (AIOps):** Integrar Modelos de Lenguaje (LLMs) para tareas de infraestructura y negocio sin arriesgar la seguridad del SO o comprometer la latencia de las peticiones HTTP concurrentes.

## Decisiones Adoptadas

### 1. Inversión de Control mediante `barrits` (Dynamic Traits)
*Decisión:* Reestructurar la base de Zenith para usar un patrón de *Traits* (vía la librería `@zuccadev-labs/barrits`).
*Justificación:* Permite inyección de dependencias estricta. Al arrancar Zenith, se especifica una variable de entorno `ZENITH_TOPOLOGY`. Si el nodo se levanta como `runner`, Zenith NO cargará los middlewares HTTP ni el ruteador REST. Esto asegura que la memoria RAM se use estrictamente para la tarea requerida (Microservicios Puros).

### 2. Clúster ZeroMQ (CurveZMQ) en Rust FFI
*Decisión:* Para la sincronización del estado del clúster y la ejecución remota de comandos, implementar `zenith-cluster` en Rust exponiendo una API FFI a Deno. 
*Justificación:* HTTP(s) o gRPC sobre Node/Deno implican serialización pesada y sobrecarga de red. ZeroMQ escrito en Rust usando cifrado matemático de curvas elípticas (CurveZMQ) garantiza transferencias directas sobre TCP con cero recolección de basura, posibilitando envío de comandos Sysadmin entre servidores en microsegundos de manera blindada.

### 3. Aislamiento Zero-Trust para la Inteligencia Artificial (Deno Web Workers)
*Decisión:* Ejecutar todos los Agentes de IA (`AITrait`) dentro de Deno Web Workers efímeros con permisos restringidos a nivel del Kernel (`--allow-net=openai.com` pero `--deny-read --deny-env --deny-run`).
*Justificación:* Si un LLM (Ollama, GPT-4, Claude) es engañado mediante un Prompt Injection, no podrá ejecutar comandos de shell ni leer el sistema de archivos del host. Para interactuar con bases de datos, debe hacer una petición RPC (postMessage) al hilo Maestro, quien aplica un estricto Control de Acceso (ACL).

### 4. Desacoplamiento de AIOps Sysadmin (Zenith Agent CLI)
*Decisión:* Extraer la lógica de gestión autónoma de clúster (reiniciar pods, leer logs de red) a un **CLI independiente (`zenith-agent`)**, fuera del núcleo del servidor Zenith.
*Justificación:* Aplicar la filosofía UNIX. Si el servidor HTTP de Zenith colapsa por alto tráfico, un Agente IA alojado internamente también moriría. Al tener un CLI independiente corriendo en modo Demonio (`--daemon`), el agente puede despertar, monitorear la caída usando herramientas estandarizadas de *Function Calling* y reiniciar el servidor mediante el RunnerTrait.

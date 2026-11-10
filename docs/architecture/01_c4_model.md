# Zenith — C4 Architecture Model

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../index.md).

> **Notation:** C4 model (Context, Containers, Components, Code)
> **Format:** Mermaid (renders natively in GitHub, GitLab, Notion, Obsidian)

## Level 1 — System Context

```mermaid
graph LR
    User[End User<br/>Web/Mobile App]
    Dev[Developer]
    Admin[Customer Admin]
    SRE[Zenith SRE]
    
    User -->|HTTPS| Zenith
    Dev -->|HTTPS + SDK| Zenith
    Admin -->|HTTPS + OIDC| Zenith
    SRE -->|kubectl + Grafana| Zenith
    
    subgraph Zenith
        Zenith[Zenith BaaS<br/>BaaS Platform]
    end
    
    Zenith -->|CRUD/Query| MongoDB[(MongoDB)]
    Zenith -->|Files| S3[(S3 / GCS)]
    Zenith -->|Secrets| Vault[HashiCorp Vault]
    Zenith -->|Email| Postal[Postal SMTP]
    Zenith -->|Auth| Keycloak[Keycloak / Zitadel]
```

## Level 2 — Container

```mermaid
graph TB
    subgraph Edge [Edge Plane]
        CF[Cloudflare WAF]
        LB[AWS ALB / nginx]
    end
    
    subgraph Control [Control Plane]
        APIGW[API Gateway]
        Auth[Auth Service]
        Keys[API Key Manager]
        Audit[Audit Log]
    end
    
    subgraph Data [Data Plane]
        CRUD[CRUD Engine]
        Files[File Service]
        Push[Push Notifier]
        Func[Cloud Functions]
        WS[WebSocket Server]
    end
    
    subgraph Plugins [Plugin Runtime]
        Runtime[Sandboxed JS]
    end
    
    subgraph Stores [Data Stores]
        Mongo[(MongoDB)]
        S3Buck[(S3 / GCS)]
        VaultSec[Vault KV]
        PostalSMTP[Postal]
    end
    
    CF --> LB --> APIGW
    APIGW --> Auth
    APIGW --> CRUD
    APIGW --> Files
    APIGW --> Push
    APIGW --> Func
    APIGW --> WS
    
    Auth --> VaultSec
    Keys --> VaultSec
    CRUD --> Mongo
    Files --> S3Buck
    Push --> PostalSMTP
    Func --> Runtime
    
    Auth --> Audit
    Keys --> Audit
    CRUD --> Audit
    Files --> Audit
```

## Level 3 — Component (Auth trait)

```mermaid
graph TB
    subgraph Auth [Auth Trait]
        Login[LoginHandler]
        Signup[SignupHandler]
        Session[SessionStore]
        JWT[JWTSigner]
        Argon[Argon2id Hasher]
        ACL[ACL Checker]
    end
    
    Login --> Argon
    Login --> Session
    Login --> JWT
    Signup --> Argon
    Signup --> Session
    Signup --> JWT
    Session --> VaultSec[(Vault)]
    JWT --> VaultSec
    ACL --> MongoACL[(MongoDB)]
```

## Level 4 — Code (CRUD request flow)

```mermaid
sequenceDiagram
    participant Client
    participant API as API Gateway
    participant Auth as Auth Middleware
    participant CRUD as CRUD Engine
    participant ACL as ACL Checker
    participant DB as MongoDB
    participant Cache as Redis
    
    Client->>API: POST /classes/Item
    API->>Auth: validate session/JWT
    Auth->>Cache: lookup session
    Cache-->>Auth: { userId, appId, scopes }
    Auth-->>API: auth context
    API->>CRUD: dispatch
    CRUD->>ACL: check (user, class, op)
    ACL->>DB: find class permissions
    DB-->>ACL: { read, write, acl }
    ACL-->>CRUD: allow
    CRUD->>DB: insertOne(...)
    DB-->>CRUD: { _id, ... }
    CRUD-->>Client: 201 { objectId, createdAt }
```

## Deployment topology

```mermaid
graph TB
    subgraph K8s [Kubernetes Cluster]
        subgraph Ingress
            NGI[nginx Ingress]
        end
        subgraph Zenith [zenith namespace]
            Pod1[zenith pod 1]
            Pod2[zenith pod 2]
            Pod3[zenith pod 3]
        end
        subgraph Vault [vault namespace]
            Vault0[Vault pod 0]
            Vault1[Vault pod 1]
            Vault2[Vault pod 2]
        end
        subgraph Mongo [mongo namespace]
            Mongo0[docdb primary]
            Mongo1[docdb secondary]
            Mongo2[docdb secondary]
        end
    end
    
    NGI --> Pod1
    NGI --> Pod2
    NGI --> Pod3
    Pod1 --> Vault0
    Pod1 --> Mongo0
    Pod2 --> Vault1
    Pod2 --> Mongo1
    Pod3 --> Vault2
    Pod3 --> Mongo2
```

## Data flow — file upload

```mermaid
sequenceDiagram
    participant App
    participant API
    participant ACL
    participant Vault
    participant S3
    participant Audit
    
    App->>API: POST /files/photo.jpg
    API->>Vault: get S3 credentials
    Vault-->>API: STS creds (1h TTL)
    API->>ACL: check tenant scope
    ACL-->>API: allow
    API->>S3: PUT (signed URL)
    S3-->>API: 200 { etag, url }
    API->>Audit: log upload
    API-->>App: 201 { name, url }
```

## Data flow — cloud function

```mermaid
sequenceDiagram
    participant App
    participant API
    participant Auth
    participant Runtime
    participant Vault
    participant Plugin
    
    App->>API: POST /functions/sendEmail
    API->>Auth: validate session
    Auth-->>API: ok
    API->>Runtime: load + verify signature
    Runtime->>Vault: fetch plugin public key
    Vault-->>Runtime: ed25519 pubkey
    Runtime->>Runtime: JCS verify
    Runtime->>Plugin: invoke(body, ctx)
    Plugin-->>Runtime: { ok: true, result }
    Runtime-->>API: response
    API-->>App: 200 { result }
```

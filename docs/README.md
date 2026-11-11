# Zenith API Reference

> Generado automáticamente por `zen generate docs`
> Versión: 1.0.0 | Base URL: http://localhost:1337
> Las mismas rutas que monta el router (zenith-backend/src/core/route-collection.ts).

## Autenticación

Cada ruta declara quién puede llamarla (ADR-013); la sección `security` de cada operación lo dice:

- **public**: sin credenciales (`/health`, `/login`, `/openapi.json`…).
- **user**: sesión (`X-Parse-Session-Token` o `Authorization: Bearer`) o API key.
- **master**: `X-Parse-Master-Key`, aceptada **solo desde localhost**. Es el valor por defecto.

```http
X-Parse-Application-Id: <tu-app-id>          # siempre
X-Parse-Session-Token: <token-del-usuario>   # rutas user
X-Parse-Master-Key: <master-key>              # rutas master, desde localhost
```

## Secciones

- [ACL](./api/ACL.md) (3 endpoints)
- [API Keys](./api/API_Keys.md) (4 endpoints)
- [Agents](./api/Agents.md) (4 endpoints)
- [Automation](./api/Automation.md) (9 endpoints)
- [Blog](./api/Blog.md) (6 endpoints)
- [CRM](./api/CRM.md) (18 endpoints)
- [CRUD](./api/CRUD.md) (7 endpoints)
- [CSV](./api/CSV.md) (3 endpoints)
- [Cache](./api/Cache.md) (2 endpoints)
- [Calendar](./api/Calendar.md) (15 endpoints)
- [Cloudcode](./api/Cloudcode.md) (3 endpoints)
- [Collaboration](./api/Collaboration.md) (15 endpoints)
- [Crypto](./api/Crypto.md) (2 endpoints)
- [ERP](./api/ERP.md) (17 endpoints)
- [Email](./api/Email.md) (11 endpoints)
- [Favorites](./api/Favorites.md) (3 endpoints)
- [Features](./api/Features.md) (2 endpoints)
- [Forum](./api/Forum.md) (7 endpoints)
- [GRAPHQL](./api/GRAPHQL.md) (2 endpoints)
- [HR](./api/HR.md) (2 endpoints)
- [Hooks](./api/Hooks.md) (8 endpoints)
- [Inventory](./api/Inventory.md) (1 endpoints)
- [Mediastream](./api/Mediastream.md) (3 endpoints)
- [Meta](./api/Meta.md) (2 endpoints)
- [Metadata](./api/Metadata.md) (9 endpoints)
- [Notifications](./api/Notifications.md) (6 endpoints)
- [Observability](./api/Observability.md) (4 endpoints)
- [Plugins](./api/Plugins.md) (8 endpoints)
- [Queue](./api/Queue.md) (3 endpoints)
- [Ratelimit](./api/Ratelimit.md) (2 endpoints)
- [Runner](./api/Runner.md) (2 endpoints)
- [Schema](./api/Schema.md) (5 endpoints)
- [Search](./api/Search.md) (2 endpoints)
- [Shell](./api/Shell.md) (2 endpoints)
- [Storage](./api/Storage.md) (3 endpoints)
- [Tags](./api/Tags.md) (8 endpoints)
- [Timeline](./api/Timeline.md) (1 endpoints)
- [User](./api/User.md) (2 endpoints)
- [User Management](./api/User_Management.md) (5 endpoints)
- [Views](./api/Views.md) (5 endpoints)
- [Webhooks](./api/Webhooks.md) (13 endpoints)
- [Workspace](./api/Workspace.md) (6 endpoints)

## Quick Start

```bash
# Importar spec en Swagger UI local
npx @stoplight/elements-dev-portal --api-url ./docs/openapi.json

# Importar en Postman
# File → Import → zenith.postman.json

# Visualizar con Redoc
# Abrir docs/index.html en el navegador
```
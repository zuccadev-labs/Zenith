# Zenith API Reference

> Generado automáticamente por `zen generate docs`
> Versión: 1.0.0 | Base URL: http://localhost:3000

## Autenticación

Todas las rutas requieren los headers de Parse Server:

```http
X-Parse-Application-Id: <tu-app-id>
X-Parse-Session-Token: <token-del-usuario>  # Para rutas de usuario
X-Parse-Master-Key: <master-key>             # Para rutas de administración
```

## Secciones


## Quick Start

```bash
# Importar spec en Swagger UI local
npx @stoplight/elements-dev-portal --api-url ./docs/openapi.json

# Importar en Postman
# File → Import → zenith.postman.json

# Visualizar con Redoc
# Abrir docs/index.html en el navegador
```
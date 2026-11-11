# Features



## `GET /zen/features`
**Loaded features and whether each one is on**

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `PUT /zen/features/{id}`
**Turn a loaded feature on or off without restarting. Its routes answer 404 while it is off**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `id` | path | string | ✅ |  |

### Body
```json
{
  "type": "object",
  "required": [
    "enabled"
  ],
  "properties": {
    "enabled": {
      "type": "boolean"
    }
  }
}
```

### Respuestas
- **200**: Updated
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

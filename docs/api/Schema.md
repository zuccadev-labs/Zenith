# Schema

> Definición dinámica de clases y columnas (Code-first schema management).

## `GET /schemas`
**List all registered schemas**

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `POST /schemas/{className}`
**Create or update a schema for a class**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `className` | path | string | ✅ |  |

### Body
```json
{
  "type": "object",
  "properties": {
    "fields": {
      "type": "object"
    },
    "clp": {
      "type": "object"
    }
  }
}
```

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `GET /schemas/{className}`
**Get the schema for a class**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `className` | path | string | ✅ |  |

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `PUT /schemas/{className}`
**Update a schema (add fields, modify CLP)**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `className` | path | string | ✅ |  |

### Respuestas
- **200**: Updated
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `DELETE /schemas/{className}`
**Delete a schema definition (does not delete data)**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `className` | path | string | ✅ |  |

### Respuestas
- **204**: No Content
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

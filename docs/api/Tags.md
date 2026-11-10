# Tags

> Etiquetas polimórficas asignables a cualquier record del sistema. Cascade delete.

## `GET /zen/tags`
**Listar Tags del workspace**

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `POST /zen/tags`
**Crear Tag**

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `PUT /zen/tags/{objectId}`
**Actualizar Tag**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `objectId` | path | string | ✅ |  |

### Respuestas
- **200**: Updated
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `DELETE /zen/tags/{objectId}`
**Eliminar Tag (cascade)**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `objectId` | path | string | ✅ |  |

### Respuestas
- **204**: No Content
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `POST /zen/tags/{tagId}/assign`
**Asignar Tag a un record**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `tagId` | path | string | ✅ |  |

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `GET /zen/tags/{tagId}/records`
**Obtener records con este Tag**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `tagId` | path | string | ✅ |  |

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `POST /zen/tags/{tagId}/unassign`
**Quitar Tag de un record**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `tagId` | path | string | ✅ |  |

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `GET /zen/tags/record/{targetClassName}/{targetId}`
**Obtener Tags de un record**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `targetClassName` | path | string | ✅ |  |
| `targetId` | path | string | ✅ |  |

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

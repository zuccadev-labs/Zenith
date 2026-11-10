# Metadata

> Custom Objects y Custom Fields — extiende el schema sin código ni migrations.

## `GET /zen/metadata/field-types`
**Tipos de campo disponibles con descripción**

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `GET /zen/metadata/objects`
**Listar todos los Custom Objects**

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `POST /zen/metadata/objects`
**Crear Custom Object (genera clase y schema)**

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `GET /zen/metadata/objects/{name}`
**Obtener Custom Object con sus fields**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `name` | path | string | ✅ |  |

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `PUT /zen/metadata/objects/{name}`
**Actualizar metadata del Custom Object**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `name` | path | string | ✅ |  |

### Respuestas
- **200**: Updated
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `DELETE /zen/metadata/objects/{name}`
**Eliminar Custom Object**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `name` | path | string | ✅ |  |

### Respuestas
- **204**: No Content
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `POST /zen/metadata/objects/{name}/fields`
**Añadir campo al Custom Object**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `name` | path | string | ✅ |  |

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `PUT /zen/metadata/objects/{name}/fields/{fieldName}`
**Actualizar campo del Custom Object**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `name` | path | string | ✅ |  |
| `fieldName` | path | string | ✅ |  |

### Respuestas
- **200**: Updated
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `DELETE /zen/metadata/objects/{name}/fields/{fieldName}`
**Eliminar campo del Custom Object**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `name` | path | string | ✅ |  |
| `fieldName` | path | string | ✅ |  |

### Respuestas
- **204**: No Content
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

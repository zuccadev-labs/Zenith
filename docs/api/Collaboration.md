# Collaboration

> Notes, Tasks (Kanban), Comments @mentions, Attachments — vinculados a cualquier objeto CRM/ERP.

## `POST /zen/attachments`
**Subir Adjunto (multipart)**

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `DELETE /zen/attachments/{objectId}`
**Eliminar Adjunto**

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

## `GET /zen/attachments/{targetClassName}/{targetId}`
**Listar Adjuntos**

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

## `POST /zen/comments`
**Crear Comentario**

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `PUT /zen/comments/{objectId}`
**Editar Comentario**

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

## `DELETE /zen/comments/{objectId}`
**Eliminar Comentario**

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

## `GET /zen/comments/{targetClassName}/{targetId}`
**Listar Comentarios**

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

## `POST /zen/notes`
**Crear Nota**

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `PUT /zen/notes/{objectId}`
**Actualizar Nota**

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

## `DELETE /zen/notes/{objectId}`
**Eliminar Nota**

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

## `GET /zen/notes/{targetClassName}/{targetId}`
**Listar Notas de un record**

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

## `GET /zen/tasks`
**Listar Tareas**

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `POST /zen/tasks`
**Crear Tarea**

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `PUT /zen/tasks/{objectId}`
**Actualizar Tarea**

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

## `DELETE /zen/tasks/{objectId}`
**Eliminar Tarea**

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

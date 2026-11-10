# CSV

> Import/Export masivo de datos: batch insert, dry-run, validación de campos, descarga automática.

## `GET /zen/csv/export/{className}`
**Exportar registros como CSV (download)**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `className` | path | string | ✅ |  |
| `filter` | query | string | — | FilterGroup JSON |
| `fields` | query | string | — | Columnas a incluir (comma-separated) |

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `POST /zen/csv/import/{className}`
**Importar registros desde CSV (multipart/form-data)**

### Parámetros
| Nombre | In | Tipo | Requerido | Descripción |
|--------|----|------|-----------|-------------|
| `className` | path | string | ✅ |  |
| `dryRun` | query | boolean | — | Validar sin insertar |
| `batchSize` | query | integer | — | Registros por lote (default 50) |

### Respuestas
- **201**: Created
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

## `GET /zen/csv/schema`
**Clases y campos disponibles para CSV Import/Export**

### Respuestas
- **200**: OK
- **400**: Bad Request - parámetros inválidos
- **401**: Unauthorized - falta API key, JWT o session token
- **403**: Forbidden - ACL/CLP denied
- **404**: Not Found - el recurso no existe
- **429**: Too Many Requests - rate limit exceeded
- **500**: Internal Server Error

---

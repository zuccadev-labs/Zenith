---
description: "ADR-014 — El CRUD `/classes` abierto a usuarios."
tipo: adr
estado: aceptada
---

# ADR-014 — El CRUD `/classes` abierto a usuarios

> **Estado:** Aceptada
> **Fecha:** 2026-11-10
> **Relacionado:** `zenith-backend/src/traits/rest/crud.trait.ts`, `crud.guard.ts`, `src/core/router.ts`, ADR-012, ADR-013

## Contexto

ADR-013 dejó todas las rutas de negocio con master key. El CRUD `/classes` es lo primero que necesita un cliente
Parse, pero no podía abrirse tal como estaba. Tenía estos fallos:

1. **No había identidad.** Leía `ctx.user` y `ctx.master`, que nadie rellenaba: todo usuario era anónimo.
2. **Listar no filtraba por ACL.** `listClass` devolvía todos los objetos de la clase. Además, el filtro `where`
   se guardaba como un campo literal y nunca llegaba a la consulta.
3. **Los datos internos quedaban expuestos.** Los traits guardan sus datos (claves de API, auditoría…) sin ACL, y
   un objeto sin ACL era público. Cualquier usuario podía leer esas colecciones o escribir en ellas.
4. **Había inyección de consultas.** Los operadores desconocidos llegaban tal cual a MongoDB (`$where` ejecuta
   JavaScript). `$inQuery` consultaba cualquier colección sin ACL, así que permitía adivinar su contenido.
5. **`include` saltaba el ACL.** Expandía punteros usando el nombre del campo como nombre de clase, sin comprobar
   permisos.
6. **Errores de diseño:**
   - escribir en objetos ajenos respondía 403, lo que revela que el objeto existe;
   - el cliente podía elegir `objectId` y `createdAt`;
   - con `/users/:id`, el handler leía la clase de la URL original y no de la reescrita;
   - `checkCLP` daba permiso a cualquier usuario si la regla nombraba `role:admin`.

## Decisión

Se abre con `access: "user"` y aplica las comprobaciones de Parse Server en producción
(`allowClientClassCreation: false`), en este orden:

1. **La clase.** Solo las definidas en el esquema (`POST /schemas/:className`, con master key). Las que empiezan
   por `_` (`_User`, `_Session`…) y las colecciones internas de los traits solo admiten la master key.
   - Con `allowClientClassCreation: true` un usuario puede crear una clase nueva.
   - Nunca puede adoptar una colección que ya existe, porque puede ser de un trait.
2. **Los permisos de clase (CLP)** del esquema, por operación (`find`, `count`, `get`, `create`, `update`,
   `delete`). Los roles cuentan de verdad.
3. **El ACL de cada objeto:**
   - **Al leer**, el ACL forma parte de la consulta a la base de datos, así que `limit`, `skip` y `count` son
     correctos. Después se vuelve a comprobar en memoria, como segunda defensa.
   - **Lo que no puede leer o escribir** responde 101 "not found", como Parse: no revela si existe.
   - **Sin ACL**, un objeto nuevo es solo de su creador. Parse lo haría público; olvidar el ACL no debe publicar
     datos.
4. **La entrada**, validada por `crud.guard.ts`:
   - **Consultas:** operadores Parse en lista blanca, sin consultas sobre `ACL`, `$regex` acotado y anidación
     limitada.
   - **Escrituras:** nombres de campo Parse, sin claves `$` ni `.` anidadas; `objectId`, `createdAt` y `updatedAt`
     los pone el servidor.
   - **ACL** bien formado.
   - **Límites:** `limit` ≤ 1000 y `batch` ≤ 50.
5. **Operaciones Parse** (`Increment`, `AddUnique`, `Remove`, `Delete`): las aplica MongoDB de forma atómica.
   `Add` se calcula en memoria.

**Identidad.** El router añade `ctx.master` y `ctx.user` a cada handler. Los roles de `ctx.user` son los roles
Parse más los grupos del directorio (FreeIPA/LDAP vía engine-auth): un ACL `role:admins` incluye a los miembros
del grupo `admins`.

**Esquemas.** Las definiciones se leen de `_SCHEMA` y se guardan en caché 30 s por instancia. Antes vivían solo
en la memoria del proceso que las creó.

## Consecuencias

- **Pruebas:** `tests/unit/crud-guard.test.ts` cubre cada regla. `tests/integration/classes.test.ts` prueba con
  dos usuarios reales, MongoDB 9 y engine-auth:
  - no ven ni tocan lo del otro;
  - la paginación respeta el ACL;
  - las clases del servidor y las colecciones internas están cerradas;
  - la inyección se rechaza;
  - `batch` aplica las mismas comprobaciones;
  - `allowClientClassCreation` no adopta colecciones existentes.

  Quitar el filtro ACL de la consulta hace fallar la prueba (mutación comprobada).
- **Para un cliente Parse:**
  - las clases hay que definirlas antes con la master key;
  - un objeto creado sin ACL no es público.
- **Pendiente** (`zenith-backend/docs/pending.md`):
  - `$inQuery` seguro en el adaptador;
  - `updatedAt` en cada escritura;
  - abrir funciones Cloud y LiveQuery.

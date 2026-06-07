# Diseño del Sistema de Esquemas y Soporte Blockchain

Este documento detalla la arquitectura de inferencia y validación de tipos del motor Zenith, combinando la flexibilidad de Parse Server con soporte de primera clase para la Web3 y la era de la IA.

## 1. Clases Base de Parse Integradas

Para mantener retrocompatibilidad y adoptar 10 años de estabilidad probada, Zenith hereda las colecciones por defecto de Parse con sus columnas estrictas:

- **`_User`**: `username`, `password` (protegido), `email`, `emailVerified`, `authData`.
- **`_Role`**: `name`, `users` (Relation a `_User`), `roles` (Relation a `_Role`).
- **`_Session`**: `user` (Pointer a `_User`), `sessionToken`, `installationId`, `expiresAt`.
- **`_Installation`**: `installationId`, `deviceToken`, `deviceType`, `pushType`.

Cualquier intento de crear un objeto en estas colecciones sin respetar los tipos originales será rechazado automáticamente por el `SchemaTrait`.

## 2. Soporte Extendido de Tipos de Datos (Parse Clásico)

Al igual que Parse, cada campo se adhiere a un tipo estricto. Una vez registrado, su mutación a otro tipo está bloqueada (evitando corrupción de datos en DB NoSQL como MongoDB o ScyllaDB):
- `String`, `Number`, `Boolean`, `Date`, `Object`, `Array`
- `Pointer` (Relación 1:1, N:1 extendida con `databaseId` en Zenith)
- `Relation` (Relación N:N)
- `GeoPoint` (Soporte nativo para coordenadas y búsquedas radiales)
- `File` (Referencias a RustFS/S3)
- `Bytes` (Datos binarios)

## 3. Soporte Nativo Web3 (Nuevos Tipos Blockchain)

Para hacer que Zenith no solo sea el sucesor de Parse, sino el estándar de la era Web3, hemos extendido el sistema de esquemas con tipos nativos para contratos inteligentes y carteras:

### `BlockchainAddress`
Un tipo especializado derivado de `String` que implementa validaciones criptográficas. Un cliente no puede guardar `"hola mundo"` en un campo definido como `BlockchainAddress`. El Trait de esquemas verificará expresiones regulares o sumas de comprobación (ej. Formato hexadecimal de Ethereum `0x...` o Base58 de Solana).

### `EncryptedKey` (Arquitectura Non-Custodial)
Un tipo complejo (`Object`) diseñado para proteger llaves privadas. 
**Regla de Oro:** Zenith jamás almacenará llaves privadas expuestas ni tokens estáticos que desencripten la llave directamente en el schema.

#### Flujo de Inserción:
El SDK del Frontend será responsable de generar la llave privada, encriptarla localmente usando la contraseña o biométricos del usuario (KDF), y enviar **solo la bóveda encriptada (Ciphertext)** al backend.

El esquema en Zenith asegurará la estructura:
```json
{
  "type": "EncryptedKey",
  "ciphertext": "...",
  "iv": "...",
  "salt": "...",
  "mac": "..."
}
```
*Si un objeto se define como `EncryptedKey`, se aplicará automáticamente un mecanismo de `protectedFields` (similar al `password` de `_User`) para que no se devuelva nunca por error en un query abierto sin los ACLs adecuados.*

## 4. Inmutabilidad en Producción
A través de `zen.config.ts`, la variable `allowClientClassCreation` determinará si el sistema es "Elástico" o "Rígido". Si está en `false`, el servidor leerá la colección `_SCHEMA` en memoria y actuará como un motor SQL estricto, ideal para infraestructura de gran corporación con migraciones controladas.

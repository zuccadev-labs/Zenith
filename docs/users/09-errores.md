# Zenith Error Codes

The following is a list of all the error codes that can be returned by the Zenith Backend API. This system maintains 100% parity with the [Parse Server Error Codes](https://github.com/parse-community/docs/blob/gh-pages/_includes/common/errors.md) while expanding the namespaces to support Enterprise and Media features.

All API responses containing errors will return an HTTP Status Code corresponding to the severity (e.g. 400, 404, 401) alongside a JSON payload:

```json
{
  "code": 142,
  "error": "Password must be at least 12 characters long..."
}
```

## Parse Standard Error Codes (100 - 299)

### API Issues

| Name                        | Code | Description                                                                                 |
|-----------------------------|------|---------------------------------------------------------------------------------------------|
| `InternalServerError`       | 1    | Internal server error. Indicates an unhandled exception or infrastructure failure.          |
| `ConnectionFailed`          | 100  | Connection to backend failed.                                                               |
| `ObjectNotFound`            | 101  | The specified object or session doesn't exist or you don't have read access.                |
| `InvalidQuery`              | 102  | Malformed query constraint or parameter.                                                    |
| `InvalidClassName`          | 103  | Class names must start with a letter and contain only alphanumeric characters or underscores.|
| `MissingObjectId`           | 104  | Object ID is required for this operation.                                                   |
| `InvalidKeyName`            | 105  | Invalid field name structure.                                                               |
| `InvalidPointer`            | 106  | A malformed pointer was provided.                                                           |
| `InvalidJSON`               | 107  | Badly formed JSON in the request body.                                                      |
| `CommandUnavailable`        | 108  | Command is only available internally.                                                       |
| `NotInitialized`            | 109  | SDK not properly initialized before usage.                                                  |
| `IncorrectType`             | 111  | Data type provided does not match schema requirements.                                      |
| `InvalidChannelName`        | 112  | Invalid push or pubsub channel name.                                                        |
| `PushMisconfigured`         | 113  | Push notification certificates or credentials missing.                                      |
| `ObjectTooLarge`            | 116  | Payload or document exceeds maximum size limits.                                            |
| `InvalidLimitError`         | 117  | Invalid `limit` parameter on query.                                                         |
| `InvalidSkipError`          | 118  | Invalid `skip` parameter on query.                                                          |
| `OperationForbidden`        | 119  | Action blocked by Class Level Permissions (CLP) or Access Control Lists (ACL).              |
| `CacheMiss`                 | 120  | Requested item not found in cache.                                                          |
| `InvalidNestedKey`          | 121  | Nested key operation is invalid.                                                            |
| `InvalidFileName`           | 122  | File name violates constraints.                                                             |
| `InvalidACL`                | 123  | Invalid ACL structure provided.                                                             |
| `Timeout`                   | 124  | Operation exceeded maximum execution time.                                                  |
| `InvalidEmailAddress`       | 125  | The email format is invalid.                                                                |
| `FileSaveError`             | 130  | Error while writing to storage adapter (S3 / Local).                                        |
| `DuplicateValue`            | 137  | A unique constraint was violated (e.g. unique field).                                       |
| `InvalidRoleName`           | 139  | Role name is malformed.                                                                     |
| `ExceededCollectionQuota`   | 140  | Maximum collection/class limit reached.                                                     |
| `ScriptFailed`              | 141  | Cloud Function or Trigger execution failed.                                                 |
| `ValidationError`           | 142  | Data validation failed (e.g. password complexity requirements).                             |
| `WebhookError`              | 143  | Upstream webhook failure.                                                                   |
| `InvalidImageData`          | 150  | Image processing failed or format unrecognized.                                             |
| `UnsavedFileError`          | 151  | Attempting to attach an unsaved file to an object.                                          |
| `InvalidPushTimeError`      | 152  | Invalid schedule time for push notifications.                                               |
| `FileDeleteError`           | 153  | Failed to delete file from storage.                                                         |
| `RequestLimitExceeded`      | 155  | Rate limit / DDoS protection triggered.                                                     |
| `InvalidEventName`          | 160  | Analytics event name is invalid.                                                            |
| `ClassNotEmpty`             | 255  | Attempting to drop a class that contains records.                                           |

### Authentication & User Management

| Name                        | Code | Description                                                                                 |
|-----------------------------|------|---------------------------------------------------------------------------------------------|
| `UsernameMissing`           | 200  | Username is required.                                                                       |
| `PasswordMissing`           | 201  | Password is required.                                                                       |
| `UsernameTaken`             | 202  | Username is already in use.                                                                 |
| `EmailTaken`                | 203  | Email is already linked to another account.                                                 |
| `MissingEmail`              | 204  | Email address required.                                                                     |
| `AuthDataError`             | 205  | Invalid 3rd party authentication payload (OAuth/SSO).                                       |
| `SessionMissing`            | 206  | A valid session token is required for this route.                                           |
| `MustCreateUser`            | 207  | User must be created before this action.                                                    |
| `AccountAlreadyLinked`      | 208  | The OAuth provider is already linked.                                                       |
| `InvalidSessionToken`       | 209  | Session token expired, revoked, or invalid.                                                 |
| `MfaRequired`               | 210  | Multi-factor authentication is required.                                                    |
| `AccountLocked`             | 211  | Account has been locked due to security policies.                                           |
| `Unauthorized`              | 212  | Unauthorized request.                                                                       |

---

## Zenith Custom Extensions (300 - 599)

Zenith extends the core BaaS functionality with Realtime Media, Corporate Identity, and Trait architectures.

### WebSockets & LiveQuery (300 - 349)

| Name                           | Code | Description                                                                                 |
|--------------------------------|------|---------------------------------------------------------------------------------------------|
| `LiveQuerySocketClosed`        | 300  | The websocket connection was unexpectedly terminated.                                       |
| `LiveQuerySubscriptionError`   | 301  | Failed to subscribe to a LiveQuery (e.g. invalid query format).                             |
| `LiveQueryUnauthorized`        | 302  | Insufficient ACLs or session missing to subscribe to this query.                            |
| `LiveQueryQuotaExceeded`       | 303  | Reached maximum concurrent active subscriptions per connection.                             |

### Media & Streaming (350 - 399)

| Name                           | Code | Description                                                                                 |
|--------------------------------|------|---------------------------------------------------------------------------------------------|
| `StreamNotFound`               | 350  | The media room or WebRTC stream does not exist.                                             |
| `StreamCodecUnsupported`       | 351  | The client requested an unsupported codec (e.g. requires VP8, client offers H.264).         |
| `StreamQuotaExceeded`          | 352  | Room capacity reached.                                                                      |
| `RecordingFailed`              | 353  | Failed to dump or process media recording buffers.                                          |
| `SFrameKeyNegotiationFailed`   | 354  | End-to-End Encryption (E2EE) key negotiation rejected.                                      |
| `MediaUnauthorized`            | 355  | Caller is not authorized to join or broadcast in this media room.                           |

### Enterprise & LDAP (400 - 449)

| Name                           | Code | Description                                                                                 |
|--------------------------------|------|---------------------------------------------------------------------------------------------|
| `LdapConnectionFailed`         | 400  | Could not reach corporate LDAP server.                                                      |
| `LdapBindFailed`               | 401  | Invalid LDAP bind credentials.                                                              |
| `LdapUserNotFound`             | 402  | User not found in Corporate Active Directory.                                               |
| `OAuthProviderUnavailable`     | 403  | Auth adapter provider is currently offline.                                                 |

### Zenith Barrits Trait Engine (500 - 599)

| Name                           | Code | Description                                                                                 |
|--------------------------------|------|---------------------------------------------------------------------------------------------|
| `TraitContractViolation`       | 500  | A required capability is missing during runtime composition.                                |
| `TraitConflict`                | 501  | Multiple traits attempt to inject the same strict dependency.                               |
| `MissingProvider`              | 502  | Dependency Injection failed due to an unresolved provider interface.                        |

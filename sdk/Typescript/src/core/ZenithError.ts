export enum ZenithErrorCode {
  // Parse Standard API Issues (100 - 199)
  INTERNAL_SERVER_ERROR      = 1,
  CONNECTION_FAILED          = 100,
  OBJECT_NOT_FOUND           = 101,
  INVALID_QUERY              = 102,
  INVALID_CLASS_NAME         = 103,
  MISSING_OBJECT_ID          = 104,
  INVALID_KEY_NAME           = 105,
  INVALID_POINTER            = 106,
  INVALID_JSON               = 107,
  COMMAND_UNAVAILABLE        = 108,
  NOT_INITIALIZED            = 109,
  INCORRECT_TYPE             = 111,
  INVALID_CHANNEL_NAME       = 112,
  PUSH_MISCONFIGURED         = 113,
  OBJECT_TOO_LARGE           = 116,
  INVALID_LIMIT_ERROR        = 117,
  INVALID_SKIP_ERROR         = 118,
  OPERATION_FORBIDDEN        = 119,
  CACHE_MISS                 = 120,
  INVALID_NESTED_KEY         = 121,
  INVALID_FILE_NAME          = 122,
  INVALID_ACL                = 123,
  TIMEOUT                    = 124,
  INVALID_EMAIL_ADDRESS      = 125,
  FILE_SAVE_ERROR            = 130,
  DUPLICATE_VALUE            = 137,
  INVALID_ROLE_NAME          = 139,
  EXCEEDED_COLLECTION_QUOTA  = 140,
  SCRIPT_FAILED              = 141,
  VALIDATION_ERROR           = 142,
  WEBHOOK_ERROR              = 143,
  INVALID_IMAGE_DATA         = 150,
  UNSAVED_FILE_ERROR         = 151,
  INVALID_PUSH_TIME_ERROR    = 152,
  FILE_DELETE_ERROR          = 153,
  REQUEST_LIMIT_EXCEEDED     = 155, // Also RATE_LIMIT_EXCEEDED
  INVALID_EVENT_NAME         = 160,
  CLASS_NOT_EMPTY            = 255,

  // Parse Standard Auth Issues (200 - 299)
  USERNAME_MISSING           = 200,
  PASSWORD_MISSING           = 201,
  USERNAME_TAKEN             = 202,
  EMAIL_TAKEN                = 203,
  MISSING_EMAIL              = 204,
  AUTH_DATA_ERROR            = 205,
  SESSION_MISSING            = 206,
  MUST_CREATE_USER           = 207,
  ACCOUNT_ALREADY_LINKED     = 208,
  INVALID_SESSION_TOKEN      = 209,
  MFA_REQUIRED               = 210,
  ACCOUNT_LOCKED             = 211,
  UNAUTHORIZED               = 212,

  // ─── Zenith Custom Extensions ───

  // Zenith WebSockets & LiveQuery (300 - 349)
  LIVEQUERY_SOCKET_CLOSED       = 300,
  LIVEQUERY_SUBSCRIPTION_ERROR  = 301,
  LIVEQUERY_UNAUTHORIZED        = 302,
  LIVEQUERY_QUOTA_EXCEEDED      = 303,

  // Zenith Media & Streaming (350 - 399)
  STREAM_NOT_FOUND              = 350,
  STREAM_CODEC_UNSUPPORTED      = 351,
  STREAM_QUOTA_EXCEEDED         = 352,
  RECORDING_FAILED              = 353,
  SFRAME_KEY_NEGOTIATION_FAILED = 354,
  MEDIA_UNAUTHORIZED            = 355,

  // Zenith Enterprise & LDAP (400 - 449)
  LDAP_CONNECTION_FAILED        = 400,
  LDAP_BIND_FAILED              = 401,
  LDAP_USER_NOT_FOUND           = 402,
  OAUTH_PROVIDER_UNAVAILABLE    = 403,

  // Zenith Barrits Trait Engine (500 - 599)
  TRAIT_CONTRACT_VIOLATION      = 500,
  TRAIT_CONFLICT                = 501,
  MISSING_PROVIDER              = 502,
}

export class ZenithError extends Error {
  public code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'ZenithError';
    this.code = code;
    Object.setPrototypeOf(this, ZenithError.prototype);
  }
}

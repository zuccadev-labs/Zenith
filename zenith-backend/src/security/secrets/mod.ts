/**
 * @module @zenith/security/secrets
 *
 * Public API para gestión de secrets.
 */

export {
  VaultClient,
  type VaultConfig,
  type VaultLogger,
  type KvV2Response,
  type PkiIssueResponse,
} from "./vault-client.ts";

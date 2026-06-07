# 06 — API Key Compromise

> **Owner:** Security lead
> **Trigger:** any indication that an API key (pk/sk/rk) has leaked, been phished, or is in a public repo.

## First 5 minutes

1. **Identify the key** in the audit log:
   ```bash
   vault kv get -format=json secret/zenith/api-keys | \
     jq '.data.data.metadata.prefix'
   ```
2. **Confirm** the scope and tenant of the compromised key.
3. **Revoke immediately:**
   ```bash
   vault kv metadata delete secret/zenith/api-keys/<key-id>
   ```
4. **Rotate the downstream service** (re-issue a new key, deploy it).

## Investigation

- Pull the last 100 audit events for the key prefix:
  ```bash
  vault audit list -format=json | jq -r '.[] | .path'
  ```
- Check for unusual:
  - Source IPs (CIDR not in tenant allow-list)
  - Endpoints (e.g. admin routes from a `pk` key)
  - Volume (rate > 10x baseline)
  - Time of day (outside business hours)

## Customer notification

If the key was a **master key** or had `admin:*` scope, notify:

- The customer within 24 h (per our SLA).
- The security@zenith.io distribution list.
- Legal/PR if customer data was potentially exposed.

## Post-incident

- [ ] Add the leaked fingerprint to the denylist (`vault kv put secret/zenith/api-keys/denylist <fp>`).
- [ ] Force-rotate all keys in the same tenant (best practice).
- [ ] Open a GitHub issue with the post-mortem.
- [ ] Update the rate-limit defaults if abuse was the cause.
- [ ] Add a `gitleaks` pre-commit hook if the leak was a code commit.

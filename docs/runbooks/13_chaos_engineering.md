# Chaos Engineering & Game Day Plan

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../index.md).

> **Methodology:** Principles of Chaos Engineering.
> **Cadence:** monthly game day + ad-hoc experiments.
> **Owner:** SRE lead.
> **Tooling:** LitmusChaos, ChaosBlade, Gremlin.

## 1. Steady state (hypothesis)

Before any experiment, define the **steady state** — the metric that should
not change during the chaos:

| Component  | Steady state (control metric)              | SLO            |
| ---------- | ------------------------------------------ | -------------- |
| API        | `sli:zenith:availability:ratio_30d` > 99.95 %| 99.95 %        |
| API        | p95 < 400 ms                               | 99 %           |
| MongoDB    | replication lag < 5 s                     | 5 s            |
| Vault      | sealed = false                              | always         |
| WebSocket  | connection success rate > 99 %              | 99 %           |
| Push       | delivery success rate > 99.5 %              | 99.5 %         |

## 2. Experiment catalog

| ID   | Experiment                                     | Tool          | Steady state to verify         |
| ---- | ---------------------------------------------- | ------------- | ------------------------------ |
| C-01 | Kill 1 of 6 backend pods                       | LitmusChaos   | RPS, p95, error rate           |
| C-02 | Kill 2 of 6 backend pods (50 % capacity)       | LitmusChaos   | HPA scale-up within 2 min      |
| C-03 | Node drain (simulate cluster upgrade)          | kubectl       | PDB holds; no downtime         |
| C-04 | MongoDB primary failover                       | ChaosBlade    | < 30 s failover; no data loss  |
| C-05 | MongoDB network partition (10 s)               | ChaosBlade    | writes retry; no duplicates    |
| C-06 | Vault seal (1 node)                            | chaos-mesh    | HA cluster; reads succeed      |
| C-07 | Vault all-sealed                                | chaos-mesh    | recovery via unseal tokens     |
| C-08 | Redis instance kill                            | LitmusChaos   | cache miss storm; no data loss |
| C-09 | S3 upload throttle (simulate 50 % slowdown)   | Toxiproxy     | uploads queue; eventual success|
| C-10 | Cloudflare 503 for 30 s                        | chaos-mesh    | WAF fallback; full outage OK   |
| C-11 | DNS failure for vault.zenith.internal (5 min)  | chaos-mesh    | circuit breaker opens; no crash|
| C-12 | Latency injection: +200 ms on MongoDB          | Toxiproxy     | p95 spike < 1 s                |
| C-13 | Memory leak in one pod (grow to OOM)           | chaos-mesh    | OOMKilled; HPA re-creates      |
| C-14 | Network blackhole: AZ us-east-1c for 5 min     | chaos-mesh    | traffic shifts to 1a/1b        |
| C-15 | Rate limit: send 10x normal traffic            | k6 + Gremlin  | WAF rate-limits; no crash      |
| C-16 | Malformed payload flood                        | k6            | input validation rejects; no crash |
| C-17 | Cert rotation in the middle of the day         | manual        | no TLS errors                  |
| C-18 | API key revocation under load                  | manual        | 401 returned; no DoS           |
| C-19 | Plugin signing key compromise                  | manual        | all unsigned plugins rejected  |
| C-20 | Region failover us-east-1 → us-west-2          | manual        | RTO < 4 h, RPO < 15 min       |

## 3. Game day plan (monthly, 2 h block)

| Time    | Activity                                                |
| ------- | ------------------------------------------------------- |
| 0:00    | Kick-off: scope, abort criteria, comms                  |
| 0:10    | Run 1-2 experiments from the catalog                    |
| 0:50    | Pause: observe metrics, hypotheses, surprises            |
| 1:00    | Debrief: what broke, what surprised us                  |
| 1:30    | Action items: file tickets, assign owners                |
| 1:50    | Update runbooks                                         |
| 2:00    | End                                                     |

## 4. Abort criteria

Stop the experiment **immediately** if:

- Steady state metric degrades by > 5 % sustained for 1 min.
- Customer-impacting bug discovered (any severity).
- SEV-1 or SEV-2 incident declared in another service.
- PagerDuty pages an unrelated on-call (collateral).
- On-call IC calls abort.

## 5. Safety

- All experiments run in **staging** unless explicitly approved for prod.
- Prod experiments require:
  - Written approval from VP Eng.
  - Change-management ticket (CHG-XXXX).
  - Customer notification 24 h in advance.
  - Roll-back plan documented.
  - On-call IC present.
- Customer data is never touched (use synthetic data).
- Experiments during business hours only (09:00-17:00 UTC).

## 6. Reporting

A monthly report goes to `#sre` and `#leadership`:

```
Game day report — 2026-06-06
Experiments run:    C-01, C-04, C-08
Hypotheses confirmed: 3/3
Surprises:          1 (HPA scale-up takes 90s, not 30s)
Action items:       3
  - [SRE-123] Tune HPA scale-up policy (owner: alice)
  - [SRE-124] Add cache pre-warm to deployment (owner: bob)
  - [SRE-125] Document Redis failover (owner: carol)
```

## 7. Production chaos

Once a quarter, one experiment runs in production:

- Q1: C-14 (AZ blackhole)
- Q2: C-04 (MongoDB primary failover)
- Q3: C-20 (region failover)
- Q4: full DR drill (see `tools/dr-drill/run-dr-drill.sh`)

Production experiments are scheduled, communicated to customers in advance,
and only run during the lowest-traffic window (Sunday 04:00 UTC).

# Zenith Performance Benchmarks (Phase 3.D)

> **Date:** 2026-06-06
> **Tooling:** k6 0.49+ (https://k6.io)
> **Status:** Scenario scripts ready. Initial baseline pending cluster run.

## 1. Service Level Objectives (SLOs)

| Path                                | p50  | p95  | p99  | RPS (per node) | Error budget |
| ----------------------------------- | ---- | ---- | ---- | -------------- | ------------ |
| `GET /health`                       | 5 ms | 20 ms | 50 ms | 5 000          | 0.1 %        |
| `POST /users` (signup)              | 80 ms | 300 ms | 600 ms | 500            | 1 %          |
| `POST /login`                       | 60 ms | 150 ms | 300 ms | 1 000          | 0.5 %        |
| `GET /users/me`                     | 10 ms | 80 ms  | 150 ms | 2 000          | 0.5 %        |
| `POST /classes/:name`               | 50 ms | 200 ms | 400 ms | 1 500          | 0.5 %        |
| `GET /classes/:name/:id`            | 8 ms  | 80 ms  | 150 ms | 4 000          | 0.1 %        |
| `PUT /classes/:name/:id`            | 50 ms | 200 ms | 400 ms | 1 500          | 0.5 %        |
| `DELETE /classes/:name/:id`         | 50 ms | 200 ms | 400 ms | 1 500          | 0.5 %        |
| `GET /classes/:name` (query)        | 60 ms | 250 ms | 500 ms | 1 000          | 0.5 %        |
| `POST /push`                        | 100 ms | 400 ms | 800 ms | 200            | 1 %          |
| `POST /functions/:name`             | 200 ms | 1 s  | 2 s  | 100            | 1 %          |
| `GET /graphql`                      | 100 ms | 500 ms | 1 s  | 200            | 1 %          |
| `GET /files/:name`                  | 30 ms | 200 ms | 500 ms | 2 000          | 0.5 %        |

Targets assume:
- Single-node deployment on `c6i.2xlarge` (8 vCPU, 16 GiB RAM)
- MongoDB 7.0 on `db.r6g.xlarge` (4 vCPU, 32 GiB RAM, gp3 1 TB)
- 1 ms intra-AZ network

## 2. Test scenarios

| File                     | Purpose                                                  | Stages                                  |
| ------------------------ | -------------------------------------------------------- | --------------------------------------- |
| `scenarios/auth.js`      | signup → me → logout → login flow per VU                 | 0 → 50 → 100 → 0                         |
| `scenarios/crud.js`      | full CRUD cycle per VU                                   | 0 → 100 → 500 → 1 000 → 0               |
| `scenarios/push.js`      | installation registration + push to channel              | 0 → 20 → 50 → 0                         |
| `scenarios/mixed.js`     | mixed-workload (auth + CRUD constant arrival rate)       | ramp + 200 req/s                        |

Each scenario enforces a `http_req_failed: rate<0.005–0.01` threshold.

## 3. How to run

### 3.1 Local

```bash
# 1. Start Zenith
cd zenith-backend
deno task start

# 2. (Optional) Start MongoDB + Postal + Vault
cd ../lab-infra
docker compose up -d mongo

# 3. Run a scenario
k6 run -e ZENITH_URL=http://localhost:8080 \
       -e ZENITH_APP_ID=loadtest-app \
       -e ZENITH_MASTER_KEY=dev-master \
       tests/load/scenarios/crud.js
```

### 3.2 Cluster

```bash
# Use the k8s helm chart
helm install zenith-bench ./k8s/zenith-bench --set image.tag=latest
kubectl exec -it deploy/zenith-bench -- k6 run \
  -e ZENITH_URL=http://zenith-backend.zenith.svc.cluster.local:8080 \
  /tests/load/scenarios/mixed.js
```

### 3.3 CI integration (gated, manual)

Add to `.github/workflows/perf.yml` (deferred to user authorization):

```yaml
on: workflow_dispatch
jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker run --rm -v $PWD:/scripts grafana/k6 run /scripts/zenith-backend/tests/load/scenarios/mixed.js
```

## 4. Output

Each scenario writes:

- `summary.json` (k6 summary metrics)
- `summary.html` (k6 web-dashboard export)

These files are ignored by `.gitignore` (`**/summary.*`).

## 5. Pass/fail criteria

A scenario **passes** when:

1. All `thresholds.http_req_*` rules succeed (k6 exits 0).
2. No p99 above the SLO table.
3. Error rate under the SLO's error budget.

A scenario **fails** when:

1. p95 > SLO by > 25 %.
2. Error rate > 2x error budget.
3. Memory leak detected (RSS grows > 50 % over 5 min at constant load).

## 6. Baseline run (pending)

To be filled in after the first cluster run on the dev cluster. Expected:

- Mixed scenario: p95 ≈ 280 ms @ 200 RPS sustained, error rate < 0.5 %.

## 7. Regression policy

- **Hard regression:** p95 > 1.5x baseline for any SLO → block merge.
- **Soft regression:** p95 > 1.2x baseline → open a tracking issue.
- **Improvement:** p95 < 0.8x baseline → celebrate in release notes.

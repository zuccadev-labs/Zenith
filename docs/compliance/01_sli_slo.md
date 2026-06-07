# Zenith — Service Level Indicators (SLI) & Objectives (SLO)

> **Methodology:** Google SRE Workbook, Chapter 5 (SLI/SLO).
> **Date:** 2026-06-06
> **Owner:** SRE lead, Product lead.
> **Review:** quarterly.

## 1. User journeys

We define SLIs around the **3 user journeys** that matter most:

| Journey                          | Description                                                |
| -------------------------------- | ---------------------------------------------------------- |
| **J1 — API request**             | Customer makes an HTTP request to Zenith                   |
| **J2 — Real-time delivery**      | Customer subscribes to a live query / push channel         |
| **J3 — Cloud function execution**| Customer invokes a cloud function and gets a response      |

## 2. SLI definitions

### 2.1 J1 — API request

| SLI                                  | Definition                                                                              | Window |
| ------------------------------------ | --------------------------------------------------------------------------------------- | ------ |
| **Availability** (binary)            | `count(status < 500) / count(all)`                                                      | 30 d   |
| **Latency** (fraction)               | `count(duration < 400ms) / count(all)`                                                  | 30 d   |
| **Throughput** (informational)       | RPS                                                                                     | —      |

**SLO targets:**

| SLI                  | Target | Error budget (30 d) |
| -------------------- | -----: | ------------------: |
| Availability         | 99.95 %| 21.6 min downtime   |
| Latency (p95 < 400ms)| 99.0 % | 7.2 h of slowness   |

### 2.2 J2 — Real-time delivery

| SLI                          | Definition                                                        | Window |
| ---------------------------- | ----------------------------------------------------------------- | ------ |
| **Delivery success rate**    | `count(delivered in < 5s) / count(sent)`                          | 30 d   |
| **Connection success rate**  | `count(ws open < 1s) / count(ws open attempts)`                   | 30 d   |

**SLO targets:**

| SLI                          | Target |
| ---------------------------- | -----: |
| Delivery success rate        | 99.5 % |
| Connection success rate      | 99.0 % |

### 2.3 J3 — Cloud function

| SLI                          | Definition                                                        | Window |
| ---------------------------- | ----------------------------------------------------------------- | ------ |
| **Execution success rate**   | `count(2xx) / count(all)`                                         | 30 d   |
| **Execution latency**        | p95 < 1 s                                                        | 30 d   |

**SLO targets:**

| SLI                          | Target |
| ---------------------------- | -----: |
| Execution success rate       | 99.0 % |
| Execution latency            | 95.0 % |

## 3. Burn rate alerts

We use the **multi-window burn rate** approach (Google SRE Workbook, Ch. 5).

### 3.1 Availability burn rate

For an SLO of 99.95 %, the **error budget** is 0.05 %.

| Window | Burn rate threshold | Time to exhaust | Page severity | Alert        |
| ------ | ------------------- | --------------- | ------------- | ------------ |
| 1 h    | 14.4 ×              | 2 days          | critical      | page         |
| 6 h    | 6 ×                 | 4 days          | warning       | ticket       |
| 24 h   | 3 ×                 | 8 days          | warning       | ticket       |
| 3 d    | 1 ×                 | 25 days         | info          | log only     |

The corresponding PromQL:

```promql
# 1h window, alert if burn rate > 14.4x for 2 minutes
(
  sum(rate(http_requests_total{job="zenith",code=~"5.."}[1h]))
  /
  sum(rate(http_requests_total{job="zenith"}[1h]))
) > (14.4 * 0.001)
```

### 3.2 Latency burn rate

For an SLO of 99 % requests < 400 ms:

```promql
# 1h window
1 - (
  sum(rate(http_request_duration_seconds_bucket{job="zenith",le="0.4"}[1h]))
  /
  sum(rate(http_request_duration_seconds_bucket{job="zenith",le="+Inf"}[1h]))
) > (14.4 * 0.01)
```

## 4. Recording rules (Prometheus)

```yaml
groups:
  - name: zenith.slo
    interval: 30s
    rules:
      - record: sli:zenith:availability:ratio_1h
        expr: |
          sum(rate(http_requests_total{job="zenith",code!~"5.."}[1h]))
          /
          sum(rate(http_requests_total{job="zenith"}[1h]))

      - record: sli:zenith:availability:ratio_6h
        expr: |
          sum(rate(http_requests_total{job="zenith",code!~"5.."}[6h]))
          /
          sum(rate(http_requests_total{job="zenith"}[6h]))

      - record: sli:zenith:availability:ratio_30d
        expr: |
          sum(rate(http_requests_total{job="zenith",code!~"5.."}[30d]))
          /
          sum(rate(http_requests_total{job="zenith"}[30d]))

      - record: sli:zenith:latency_p95_1h
        expr: |
          histogram_quantile(0.95,
            sum(rate(http_request_duration_seconds_bucket{job="zenith"}[1h])) by (le)
          )

      - record: error_budget:zenith:availability:remaining_30d
        expr: |
          1 - (
            1 -
            sum(rate(http_requests_total{job="zenith",code!~"5.."}[30d]))
            /
            sum(rate(http_requests_total{job="zenith"}[30d]))
          ) / 0.0005
```

## 5. Error budget policy

- **Budget > 75 %** — normal mode, ship features at will.
- **Budget 50-75 %** — SRE reviews recent incidents; freeze non-critical deploys.
- **Budget 25-50 %** — feature freeze; only reliability work ships.
- **Budget < 25 %** — incident mode; on-call + product + eng manager meet daily.
- **Budget exhausted (0 %)** — hard freeze; only security + critical bug fixes ship.

The current budget is visible at <https://grafana.zenith.io/d/zenith-slo>.

## 6. Reporting

A weekly SLO report is auto-generated to `#slo-report`:

```
Week of 2026-06-01 → 2026-06-07
Availability: 99.982 %  (target: 99.95 %)  budget remaining: 64 %
Latency p95:  245 ms    (target: < 400 ms)  budget remaining: 88 %
Incidents:    1 SEV-3 (10 min downtime)
Postmortems:  0 outstanding
```

The report includes a burn-down chart and a per-route breakdown.

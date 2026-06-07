# Zenith — Total Cost of Ownership (TCO) Calculator

> **Date:** 2026-06-06
> **Audience:** Finance, Sales Engineering, Customer Success.

## 1. Pricing model

Zenith uses **consumption-based pricing** with three tiers:

| Tier        | Monthly base | Per request | Per GB stored | Per GB egress |
| ----------- | ------------ | ----------- | ------------- | ------------- |
| **Starter** | $0           | $0.50 / 1M  | $0.10         | $0.05         |
| **Growth**  | $499         | $0.30 / 1M  | $0.08         | $0.04         |
| **Enterprise** | $4 999    | $0.20 / 1M  | $0.05         | $0.03         |

All tiers include:

- 99.95 % availability SLA
- 24/7 support
- Multi-region replication (paid regions)
- SOC 2, ISO 27001, GDPR compliance
- 30-day backup retention

## 2. Workload profiles

| Profile        | MAU     | RPS (peak) | Storage  | Egress / month | Tier        | Monthly cost |
| -------------- | ------- | ---------- | -------- | -------------- | ----------- | ------------ |
| MVP            | 1 000   | 50         | 10 GB    | 50 GB          | Starter     | $7           |
| SMB            | 50 000  | 1 000      | 500 GB   | 2 TB           | Growth      | $1 099       |
| Mid-market     | 500 000 | 10 000     | 5 TB     | 20 TB          | Growth      | $8 099       |
| Enterprise A   | 5 000 000 | 100 000  | 50 TB    | 200 TB         | Enterprise  | $49 999      |
| Enterprise B   | 20 000 000 | 500 000 | 500 TB   | 2 PB           | Enterprise  | $199 999     |

## 3. Cost optimisation tips

1. **Cache at the edge** — reduce egress by 50-80 % using Cloudflare.
2. **Use `pk` keys in browsers** — they hit the WAF cache tier, not the data plane.
3. **Aggregate writes** — batch inserts are 5x cheaper.
4. **Tune retention** — shorter time-series retention = less storage.
5. **Reserve capacity** — annual contracts include a 20 % discount.

## 4. Cost calculator (formula)

```text
monthly_cost = base
            + (requests_per_month / 1_000_000) * per_million_requests
            + storage_gb * per_gb_storage
            + egress_gb  * per_gb_egress
```

## 5. Comparison vs Parse-Server self-hosted

| Cost component         | Self-hosted Parse-Server | Zenith (Enterprise) |
| ---------------------- | ------------------------ | ------------------- |
| EC2 (3 × m5.2xlarge)   | $1 200                   | included            |
| DocumentDB (3 nodes)   | $4 200                   | included            |
| ElastiCache Redis      | $400                     | included            |
| S3 + data transfer     | $1 000                   | included            |
| CloudFront / WAF       | $500                     | included            |
| Vault (HA)             | $300                     | included            |
| Datadog / monitoring   | $1 200                   | included            |
| SRE on-call (1 FTE)    | $12 000                  | included            |
| **Total / month**      | **$20 800**              | **$4 999+**         |
| **Annual**             | **$249 600**             | **$60 000+**        |

Self-hosted is **4x more expensive** at scale, excluding the opportunity cost
of running the platform instead of the product.

## 6. Volume discounts

Annual contracts include:

| Annual commit  | Discount |
| -------------- | -------- |
| $50 K          | 5 %      |
| $100 K         | 10 %     |
| $250 K         | 15 %     |
| $500 K         | 20 %     |
| $1 M+          | negotiable |

Multi-year commits (2-3 yr) add 5 % on top of the annual discount.

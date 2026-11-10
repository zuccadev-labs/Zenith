# Zenith AWS Infrastructure (Terraform)

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../../docs/index.md).

Production-grade Terraform module for deploying Zenith on AWS.

## Architecture

```
                     ┌──────────────────┐
                     │  Route53 + ACM   │
                     └────────┬─────────┘
                              │
                     ┌────────▼─────────┐
                     │  ALB (TLS 1.3)   │
                     └────────┬─────────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
┌──────▼──────┐       ┌───────▼───────┐       ┌──────▼──────┐
│  EKS        │       │  EKS          │       │  EKS        │
│  us-east-1a │       │  us-east-1b   │       │  us-east-1c │
└──────┬──────┘       └───────┬───────┘       └──────┬──────┘
       │                      │                      │
       └──────────────────────┼──────────────────────┘
                              │
       ┌──────────────┬───────┴───────┬──────────────┐
       │              │               │              │
┌──────▼──────┐ ┌─────▼─────┐ ┌───────▼────┐ ┌───────▼────┐
│  DocumentDB │ │  Redis    │ │  S3 (uploads) │  S3 (logs)│
│  (3 nodes)  │ │  (3 nodes)│ │  KMS-encrypted│ KMS-encrypted│
└─────────────┘ └───────────┘ └──────────────┘ └───────────┘
```

## What this module creates

| Resource           | Type               | Notes                                |
| ------------------ | ------------------ | ------------------------------------ |
| VPC                | 3 AZs              | Public + private subnets, NAT GW     |
| EKS cluster        | Kubernetes 1.29    | 1 managed node group                 |
| DocumentDB         | MongoDB-compatible | 3 instances, encryption at rest      |
| ElastiCache Redis  | Cluster mode       | TLS + auth token                     |
| S3 buckets         | uploads, logs      | KMS-encrypted, lifecycle, CRR (prod) |
| ALB                | Application LB     | TLS 1.3, ACM cert, WAF ready         |
| Route53 + ACM      | DNS + TLS          | Auto-validated via DNS               |
| IAM roles          | IRSA, replication  | Least privilege                      |
| KMS keys           | uploads, mongo, redis, logs | Customer-managed, rotation enabled |

## Module structure

```
zenith-aws/
├── main/
│   ├── versions.tf
│   ├── vpc.tf
│   ├── eks.tf
│   ├── mongodb.tf
│   ├── redis.tf
│   ├── s3.tf
│   └── dns-alb.tf
├── variables/
│   └── variables.tf
├── outputs/
│   └── outputs.tf
└── iam/
    └── iam.tf
```

## Usage

```hcl
# envs/prod/main.tf
module "zenith" {
  source = "../modules/zenith-aws"

  environment = "prod"
  aws_region  = "us-east-1"

  cluster_name       = "zenith-prod"
  kubernetes_version = "1.29"

  mongodb_instance_class = "db.r6g.2xlarge"
  redis_node_type        = "cache.r6g.xlarge"

  domain_name = "api.zenith.io"
}
```

## Deploy

```bash
cd infra/terraform/envs/prod
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

## Cost estimate (us-east-1, prod)

| Resource              | Monthly cost (USD) |
| --------------------- | ------------------ |
| EKS cluster           | $73                |
| EKS nodes (12 × c6i.2xlarge) | $3 500        |
| DocumentDB (3 × db.r6g.2xlarge) | $4 200      |
| ElastiCache (3 × cache.r6g.xlarge) | $1 100   |
| ALB                   | $25 + LCU          |
| S3 (1 TB + Glacier)  | $40                |
| KMS                   | $5                 |
| Data transfer         | ~$300              |
| **Total**             | **~$9 200 / month**|

For 10 K RPS sustained at 70 % utilization. See `docs/customer/tco.md`.

# Zenith Helm Chart

> The chart is not published to a chart repository: install it from this folder. Tested on kind with Calico on
> 2026-11-11 (`docs/development/02-pruebas.md`).

Production-grade Helm chart for deploying Zenith BaaS on Kubernetes.

## TL;DR

```bash
helm install zenith k8s/helm/zenith \
  --namespace zenith --create-namespace \
  --values k8s/helm/zenith/values-prod.yaml
```

## Prerequisites

- Kubernetes 1.27+
- Helm 3.10+
- Cert-manager (for TLS)
- Prometheus Operator (for ServiceMonitor + PrometheusRule)
- An ingress controller (nginx recommended)

## Configuration

See `values.yaml` for the full list of options. Common overrides:

| Parameter            | Description                          | Default                |
| -------------------- | ------------------------------------ | ---------------------- |
| `replicaCount`       | number of pods                       | `2`                    |
| `image.tag`          | image tag                            | `latest`               |
| `zenith.appId`       | Zenith app id                        | `zenith-production`    |
| `ingress.hosts[0].host` | public hostname                  | `api.zenith.example.com` |
| `autoscaling.maxReplicas` | HPA max                         | `50`                   |
| `resources.limits.cpu` | CPU limit                          | `2000m`                 |
| `resources.limits.memory` | Memory limit                   | `1Gi`                   |
| `networkPolicy.enabled` | enable microsegmentation         | `false`                 |
| `serviceMonitor.enabled` | Prometheus scraping             | `false`                 |
| `prometheusRule.enabled` | alert rules                    | `false`                 |

## Production deployment

```bash
# 1. Create namespace + secrets
kubectl create namespace zenith
kubectl -n zenith create secret generic zenith-secrets \
  --from-literal=APP1_MASTER_KEY=$(openssl rand -hex 40) \
  --from-literal=APP2_MASTER_KEY=$(openssl rand -hex 40) \
  --from-literal=MONGO_URI='mongodb://…' \
  --from-literal=SCYLLA_URI='…' \
  --from-literal=FILE_SIGNING_KEY=$(openssl rand -hex 32) \
  --from-literal=AUDIT_SIGNING_KEY=$(openssl rand -hex 32) \
  --from-literal=WEBHOOK_SECRETS_KEY=$(openssl rand -hex 32)

# 2. Install with production values
helm install zenith k8s/helm/zenith \
  --namespace zenith \
  --values values-prod.yaml
```

The image reads `APP1_MASTER_KEY` and `APP2_MASTER_KEY` (64 characters or more, `zenith-backend/apps.config.ts`)
and the database URIs from the environment. Deploying the full `values-prod.yaml` (ingress-nginx, Vault,
cert-manager) on a test cluster is still pending (`docs/development/10-lo-que-falta.md`).

## Upgrading

```bash
helm upgrade zenith ./zenith \
  --namespace zenith \
  --values values-prod.yaml \
  --wait
```

## Uninstalling

```bash
helm uninstall zenith --namespace zenith
```

## Testing the chart

```bash
helm install zenith ./zenith --dry-run --debug
helm install zenith ./zenith --namespace zenith-test --create-namespace
helm test zenith --namespace zenith-test
```

## Chart structure

```
zenith/
├── Chart.yaml
├── values.yaml
├── values-prod.yaml
├── .helmignore
├── README.md
└── templates/
    ├── _helpers.tpl
    ├── configmap.yaml
    ├── deployment.yaml
    ├── hpa.yaml
    ├── ingress.yaml
    ├── networkpolicy.yaml
    ├── pdb.yaml
    ├── prometheusrule.yaml
    ├── secret.yaml
    ├── service.yaml
    ├── serviceaccount.yaml
    ├── servicemonitor.yaml
    └── tests/
        └── test-connection.yaml
```

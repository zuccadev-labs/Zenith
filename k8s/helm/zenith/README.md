# Zenith Helm Chart

Production-grade Helm chart for deploying Zenith BaaS on Kubernetes.

## TL;DR

```bash
helm repo add zenith https://charts.zenith.io
helm install zenith zenith/zenith \
  --namespace zenith --create-namespace \
  --values values-prod.yaml
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
  --from-literal=MASTER_KEY=$(openssl rand -hex 32) \
  --from-literal=JWT_SECRET=$(openssl rand -hex 64) \
  --from-literal=SURREAL_PASS=$(openssl rand -hex 32) \
  --from-literal=QDRANT_API_KEY=$(openssl rand -hex 32)

# 2. Install with production values
helm install zenith ./zenith \
  --namespace zenith \
  --values values-prod.yaml
```

See `docs/runbooks/01_production_deployment.md` for the full procedure.

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

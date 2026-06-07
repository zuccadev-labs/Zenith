module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.8"

  name               = var.cluster_name
  kubernetes_version = var.kubernetes_version

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids

  cluster_endpoint_public_access  = true
  cluster_endpoint_private_access = true

  cluster_addons = {
    coredns = {
      most_recent = true
      configuration_values = jsonencode({
        tolerations = [
          { key = "CriticalAddonsOnly", operator = "Exists" }
        ]
      })
    }
    kube-proxy = { most_recent = true }
    vpc-cni = {
      most_recent              = true
      service_account_role_arn = module.vpc_cni_irsa.iam_role_arn
    }
    aws-ebs-csi-driver = { most_recent = true }
  }

  eks_managed_node_groups = {
    main = {
      name            = "main"
      instance_types  = var.node_instance_types
      min_size        = var.node_group_min_size
      max_size        = var.node_group_max_size
      desired_size    = var.node_group_desired_size
      capacity_type   = "ON_DEMAND"

      block_device_mappings = {
        xvda = {
          device_name = "/dev/xvda"
          ebs = {
            volume_size           = 100
            volume_type           = "gp3"
            iops                  = 3000
            throughput            = 125
            encrypted             = true
            delete_on_termination = true
          }
        }
      }

      labels = {
        role = "main"
      }

      tags = {
        "k8s.io/cluster-autoscaler/enabled"             = "true"
        "k8s.io/cluster-autoscaler/${var.cluster_name}" = "owned"
      }
    }
  }

  manage_aws_auth_configmap = true
  aws_auth_roles = [
    {
      rolearn  = module.eks_admin_role.iam_role_arn
      username = "admin"
      groups   = ["system:masters"]
    },
  ]

  tags = {
    Environment = var.environment
  }
}

module "vpc_cni_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts"
  version = "~> 5.30"

  name = "zenith-${var.environment}-vpc-cni"

  attach_vpc_cni_policy = true
  vpc_cni_enable_ipv4   = true

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:vpc-cni"]
    }
  }
}

resource "aws_iam_role" "eks_admin" {
  name = "zenith-${var.environment}-eks-admin"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action = "sts:AssumeRole"
      },
    ]
  })
}

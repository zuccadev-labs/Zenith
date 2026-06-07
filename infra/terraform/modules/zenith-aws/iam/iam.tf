data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

provider "aws" {
  alias  = "replica"
  region = "us-west-2"
}

resource "aws_iam_role" "zenith" {
  name = "zenith-${var.environment}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = module.eks.oidc_provider_arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "${replace(module.eks.cluster_oidc_issuer_url, "https://", "")}:sub" = "system:serviceaccount:zenith:zenith"
          }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "zenith" {
  name = "zenith-${var.environment}-policy"
  role = aws_iam_role.zenith.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
        ]
        Resource = [
          module.s3_uploads.s3_bucket_arn,
          "${module.s3_uploads.s3_bucket_arn}/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey",
        ]
        Resource = aws_kms_key.uploads.arn
      },
    ]
  })
}

resource "aws_iam_role" "s3_replication" {
  name = "zenith-${var.environment}-s3-replication"
  # ... replication role
}

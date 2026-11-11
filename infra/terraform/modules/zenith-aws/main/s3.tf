module "s3_uploads" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 4.0"

  bucket = "zenith-${var.environment}-uploads"

  versioning = { enabled = true }
  lifecycle_rule = [{
    id      = "expire-old-uploads"
    enabled = true
    expiration = {
      days = 365
    }
    transition = [{
      days          = 90
      storage_class = "STANDARD_IA"
    }]
  }]

  server_side_encryption_configuration = {
    rule = {
      apply_server_side_encryption_by_default = {
        sse_algorithm     = "aws:kms"
        kms_master_key_id = aws_kms_key.uploads.arn
      }
    }
  }

  cross_region_replication = var.environment == "prod" ? {
    role_arn = aws_iam_role.s3_replication.arn
    destination = {
      bucket = module.s3_uploads_replica.bucket
      storage_class = "STANDARD_IA"
    }
  } : null

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

module "s3_uploads_replica" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 4.0"
  count   = var.environment == "prod" ? 1 : 0
  providers = {
    aws = aws.replica
  }

  bucket = "zenith-${var.environment}-uploads-replica"

  server_side_encryption_configuration = {
    rule = {
      apply_server_side_encryption_by_default = {
        sse_algorithm     = "aws:kms"
        kms_master_key_id = aws_kms_key.uploads_replica[0].arn
      }
      bucket_key_enabled = true
    }
  }
}

resource "aws_kms_key" "uploads_replica" {
  count                   = var.environment == "prod" ? 1 : 0
  provider                = aws.replica
  description             = "KMS key for the upload bucket replica"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

module "s3_logs" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 4.0"

  bucket = "zenith-${var.environment}-logs"

  versioning = { enabled = true }
  server_side_encryption_configuration = {
    rule = {
      apply_server_side_encryption_by_default = {
        sse_algorithm     = "aws:kms"
        kms_master_key_id = aws_kms_key.logs.arn
      }
      bucket_key_enabled = true
    }
  }
  lifecycle_rule = [{
    id      = "expire-old-logs"
    enabled = true
    expiration = {
      days = 2555  # 7 years for compliance
    }
    transition = [{
      days          = 90
      storage_class = "GLACIER"
    }]
  }]
}

resource "aws_kms_key" "uploads" {
  description             = "KMS key for upload bucket"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_key" "logs" {
  description             = "KMS key for the logs bucket"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

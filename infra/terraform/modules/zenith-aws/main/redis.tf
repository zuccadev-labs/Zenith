module "redis" {
  source  = "terraform-aws-modules/elasticache/aws"
  version = "~> 2.0"

  name                 = "zenith-${var.environment}-redis"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_nodes      = 3
  parameter_group_name = "default.redis7.1"
  port                 = 6379

  subnet_group_name    = aws_elasticache_subnet_group.redis.name
  security_group_ids   = [aws_security_group.redis.id]
  apply_immediately    = false
  maintenance_window   = "Sun:03:00-Sun:05:00"
  snapshot_window      = "05:00-07:00"
  snapshot_retention_limit = 7

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result
  kms_key_id                 = aws_kms_key.redis.arn

  tags = {
    Environment = var.environment
  }
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "zenith-${var.environment}-redis"
  subnet_ids = module.vpc.private_subnet_ids
}

resource "aws_security_group" "redis" {
  name        = "zenith-${var.environment}-redis"
  description = "Allow Redis access from EKS"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "Redis from EKS"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}

resource "aws_kms_key" "redis" {
  description             = "KMS key for Redis encryption at rest"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "random_password" "redis" {
  length  = 32
  special = false
}

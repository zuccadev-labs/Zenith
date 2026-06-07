module "mongodb" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.5"

  identifier = "zenith-${var.environment}-mongo"

  engine                = "docdb"
  engine_version        = "5.0.0"
  family                = "docdb5.0"
  major_engine_version  = "5.0"
  instance_class        = var.mongodb_instance_class
  allocated_storage     = var.mongodb_allocated_storage_gb
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.mongodb.arn

  username = "zenith"
  port     = 27017

  db_name  = "zenith"

  vpc_security_group_ids = [aws_security_group.mongodb.id]
  db_subnet_group_name   = aws_docdb_subnet_group.mongodb.name

  maintenance_window          = "Mon:00:00-Mon:03:00"
  backup_window               = "03:00-06:00"
  backup_retention_period     = var.backup_retention_days
  deletion_protection         = var.environment == "prod"
  skip_final_snapshot         = var.environment != "prod"
  final_snapshot_identifier   = "zenith-${var.environment}-mongo-final"
  create_cloudwatch_log_group = true
  enabled_cloudwatch_logs_exports = ["audit", "profiler"]

  tags = {
    Environment = var.environment
  }
}

resource "aws_docdb_subnet_group" "mongodb" {
  name       = "zenith-${var.environment}-mongo"
  subnet_ids = module.vpc.private_subnet_ids
}

resource "aws_security_group" "mongodb" {
  name        = "zenith-${var.environment}-mongo"
  description = "Allow MongoDB access from EKS nodes"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "MongoDB from EKS"
    from_port       = 27017
    to_port         = 27017
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_kms_key" "mongodb" {
  description             = "KMS key for MongoDB encryption at rest"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

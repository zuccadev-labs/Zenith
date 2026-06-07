provider "aws" {
  region = "us-east-1"
}

terraform {
  backend "s3" {
    bucket         = "zenith-tfstate-prod"
    key            = "zenith/prod/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "zenith-tfstate-lock"
    encrypt        = true
  }
}

module "zenith" {
  source = "../modules/zenith-aws"

  environment = "prod"
  aws_region  = "us-east-1"

  cluster_name        = "zenith-prod"
  kubernetes_version  = "1.29"
  node_instance_types = ["c6i.2xlarge", "c6i.4xlarge", "c7i.2xlarge"]
  node_group_min_size = 12
  node_group_max_size = 100
  node_group_desired_size = 12

  mongodb_instance_class        = "db.r6g.2xlarge"
  mongodb_allocated_storage_gb  = 2000
  redis_node_type               = "cache.r6g.xlarge"

  domain_name          = "api.zenith.io"
  vault_address        = "https://vault.zenith.internal:8200"
  backup_retention_days = 30
}

output "cluster_endpoint" {
  value     = module.zenith.cluster_endpoint
  sensitive = true
}

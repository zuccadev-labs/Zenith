variable "environment" {
  description = "Environment name (dev, staging, prod)."
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "cluster_name" {
  description = "EKS cluster name."
  type        = string
  default     = "zenith-prod"
}

variable "kubernetes_version" {
  description = "Kubernetes version for EKS."
  type        = string
  default     = "1.29"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of AZs to use."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets."
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets."
  type        = list(string)
  default     = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]
}

variable "node_instance_types" {
  description = "EC2 instance types for the EKS node group."
  type        = list(string)
  default     = ["c6i.2xlarge", "c6i.4xlarge"]
}

variable "node_group_min_size" {
  type    = number
  default = 6
}

variable "node_group_max_size" {
  type    = number
  default = 50
}

variable "node_group_desired_size" {
  type    = number
  default = 6
}

variable "mongodb_instance_class" {
  type    = string
  default = "db.r6g.xlarge"
}

variable "mongodb_allocated_storage_gb" {
  type    = number
  default = 1000
}

variable "redis_node_type" {
  type    = string
  default = "cache.r6g.large"
}

variable "domain_name" {
  type    = string
  default = "api.zenith.io"
}

variable "vault_address" {
  type    = string
  default = "https://vault.zenith.internal:8200"
}

variable "backup_retention_days" {
  type    = number
  default = 30
}

variable "cluster_admin_cidrs" {
  description = "Networks allowed to reach the EKS API publicly (e.g. the office VPN). Empty: private endpoint only."
  type        = list(string)
  default     = []
}

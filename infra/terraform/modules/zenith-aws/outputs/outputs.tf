output "cluster_id" {
  description = "EKS cluster ID."
  value       = module.eks.cluster_id
}

output "cluster_endpoint" {
  description = "EKS API endpoint."
  value       = module.eks.cluster_endpoint
  sensitive   = true
}

output "cluster_security_group_id" {
  description = "Security group ID attached to the EKS cluster."
  value       = module.eks.cluster_security_group_id
}

output "vpc_id" {
  description = "VPC ID."
  value       = module.vpc.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnet IDs."
  value       = module.vpc.private_subnet_ids
}

output "mongodb_endpoint" {
  description = "MongoDB endpoint (without credentials)."
  value       = module.mongodb.endpoint
  sensitive   = true
}

output "redis_endpoint" {
  description = "ElastiCache Redis endpoint."
  value       = module.redis.endpoint
  sensitive   = true
}

output "s3_bucket_uploads" {
  description = "S3 bucket for user uploads."
  value       = module.s3_uploads.bucket_id
}

output "s3_bucket_logs" {
  description = "S3 bucket for logs (Loki cold storage)."
  value       = module.s3_logs.bucket_id
}

output "route53_zone_id" {
  description = "Route53 hosted zone ID."
  value       = module.dns.zone_id
}

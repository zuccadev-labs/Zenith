terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.30"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.24"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.12"
    }
    vault = {
      source  = "hashicorp/vault"
      version = "~> 4.4"
    }
  }

  backend "s3" {
    # bucket         = "zenith-tfstate-prod"
    # key            = "zenith/prod/terraform.tfstate"
    # region         = "us-east-1"
    # dynamodb_table = "zenith-tfstate-lock"
    # encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "zenith"
      Environment = var.environment
      ManagedBy   = "terraform"
      Owner       = "platform@zenith.io"
      CostCenter  = "engineering"
    }
  }
}

provider "kubernetes" {
  config_path = "~/.kube/config"
}

provider "helm" {
  kubernetes {
    config_path = "~/.kube/config"
  }
}

provider "vault" {
  address = var.vault_address
}

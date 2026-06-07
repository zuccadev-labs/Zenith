module "dns" {
  source  = "terraform-aws-modules/route53/aws//modules/zone"
  version = "~> 3.0"

  name = var.domain_name

  tags = {
    Environment = var.environment
  }
}

resource "aws_route53_record" "api" {
  zone_id = module.dns.zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  alias {
    name                   = module.alb.lb_dns_name
    zone_id                = module.alb.lb_zone_id
    evaluate_target_health = true
  }
}

module "acm" {
  source  = "terraform-aws-modules/acm/aws"
  version = "~> 5.0"

  domain_name = var.domain_name
  zone_id     = module.dns.zone_id

  validation_method = "DNS"

  wait_for_validation = true
}

module "alb" {
  source  = "terraform-aws-modules/alb/aws"
  version = "~> 9.0"

  name               = "zenith-${var.environment}-alb"
  load_balancer_type = "application"
  vpc_id             = module.vpc.vpc_id
  subnets            = module.vpc.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]

  http_tcp_listeners = [
    {
      port               = 80
      protocol           = "HTTP"
      target_group_index = 0
      action_type        = "redirect"
      redirect = {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    },
  ]

  https_listeners = [
    {
      port               = 443
      protocol           = "HTTPS"
      target_group_index = 0
      certificate_arn    = module.acm.acm_certificate_arn
      ssl_policy         = "ELBSecurityPolicy-TLS13-1-2-2021-06"
    },
  ]

  target_groups = [
    {
      name             = "zenith-${var.environment}"
      backend_protocol = "HTTP"
      backend_port     = 8080
      target_type      = "ip"
      health_check = {
        enabled  = true
        path     = "/health"
        port     = "8080"
        protocol = "HTTP"
        matcher  = "200"
      }
    },
  ]
}

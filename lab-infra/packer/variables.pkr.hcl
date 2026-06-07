variable "proxmox_api_url" {
  type        = string
  description = "URL to the Proxmox API (e.g. http://192.168.14.44:8006/api2/json)"
}

variable "proxmox_api_token_id" {
  type        = string
  description = "API Token ID (e.g. root@pam!packer)"
}

variable "proxmox_api_token_secret" {
  type        = string
  description = "API Token Secret"
  sensitive   = true
}

variable "proxmox_node" {
  type        = string
  description = "The Proxmox Node name (e.g. pve)"
  default     = "pve"
}

variable "template_name" {
  type        = string
  description = "Name of the base Debian Cloud-Init template to clone from (created from base-so/)"
  default     = "debian-13-cloudinit"
}

variable "vm_id" {
  type        = number
  description = "ID for the Packer golden image VM (Pulumi VM will use 902)"
  default     = 901
}

variable "vm_name" {
  type        = string
  description = "Name of the Packer golden image"
  default     = "zenith-lab-golden"
}

variable "vm_storage" {
  type        = string
  description = "Storage pool for the Packer VM disk"
  default     = "local-lvm-1tb"
}

variable "ssh_username" {
  type        = string
  description = "SSH user configured in the cloud-init template"
  default     = "debian"
}

variable "ssh_private_key_file" {
  type        = string
  description = "Path to your private SSH key (matching the public key in the template)"
  default     = "~/.ssh/id_rsa"
}

packer {
  required_plugins {
    proxmox = {
      version = ">= 1.1.3"
      source  = "github.com/hashicorp/proxmox"
    }
  }
}

source "proxmox-clone" "zenith" {
  proxmox_url              = var.proxmox_api_url
  username                 = var.proxmox_api_token_id
  token                    = var.proxmox_api_token_secret
  node                     = var.proxmox_node
  insecure_skip_tls_verify = true
  task_timeout             = "30m"

  # ── Clonar desde el template base en el HDD debian-13-hdd (ID 9005) ───
  full_clone  = true            # full clone → independiente del template
  clone_vm    = "debian-13-hdd"
  vm_id       = 901
  vm_name     = var.vm_name

  os       = "l26"
  cpu_type = "host"
  cores    = 4
  memory   = 12288

  # El disco de 60GB ya viene incluido en el template 9005 (en local-lvm-1tb)

  scsi_controller = "virtio-scsi-single"

  network_adapters {
    model  = "virtio"
    bridge = "vmbr0"
  }

  # ── Cloud-Init: IP fija 192.168.14.50 ─────────────────────────────
  cloud_init              = true
  cloud_init_storage_pool = "local"

  # ── SSH (Packer necesita conectar para provisionar) ────────────────
  ssh_username         = var.ssh_username
  ssh_host             = "192.168.14.49"
  ssh_timeout          = "15m"
  # Dejamos que Packer auto-genere la llave temporal y la inyecte vía cloud-init
}

build {
  sources = ["source.proxmox-clone.zenith"]

  # ── Step 1: Instalar Docker, Ansible, Docker Compose ──────────────
  provisioner "shell" {
    execute_command = "chmod +x {{ .Path }}; sudo {{ .Path }}"
    script = "scripts/setup.sh"
  }

  # ── Step 2: Subir docker-compose y .env ───────────────────────────
  provisioner "file" {
    source      = "../docker/docker-compose.yml"
    destination = "/opt/zenith-lab/docker-compose.yml"
  }

  provisioner "file" {
    source      = "../.env"
    destination = "/opt/zenith-lab/.env"
  }

  # ── Step 3: Subir repos (luxdb, postal-config) ────────────────────
  provisioner "shell" {
    execute_command = "chmod +x {{ .Path }}; sudo {{ .Path }}"
    inline = [
      "mkdir -p /opt/zenith-lab/repos",
      "mkdir -p /opt/zenith-lab/configs",
      "chown -R debian:debian /opt/zenith-lab"
    ]
  }

  provisioner "file" {
    source      = "../repos/"
    destination = "/opt/zenith-lab/repos/"
  }

  # ── Step 4: Subir configuraciones de CoreDNS y OTel ───────────────
  provisioner "file" {
    source      = "../docker/configs/"
    destination = "/opt/zenith-lab/configs/"
  }

  # ── Step 5: Subir playbooks Ansible ───────────────────────────────
  provisioner "file" {
    source      = "../ansible/"
    destination = "/opt/zenith-lab/ansible/"
  }

  # ── Step 6: Configurar servicios systemd y finalizar ──────────────
  provisioner "file" {
    source      = "scripts/finalize.sh"
    destination = "/tmp/finalize.sh"
  }

  provisioner "shell" {
    execute_command = "chmod +x {{ .Path }}; sudo {{ .Path }}"
    inline = [
      "chmod +x /tmp/finalize.sh",
      "/tmp/finalize.sh",
      "echo '=== Pulling Docker images for pre-packaging ==='",
      "cd /opt/zenith-lab && docker compose --env-file .env pull"
    ]
  }
}

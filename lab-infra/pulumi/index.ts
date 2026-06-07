import * as pulumi from "@pulumi/pulumi";
import * as proxmoxve from "@muhlemmer/proxmoxve";

// ── Configuración del Laboratorio ────────────────────────────────────
const targetNode   = "pve";
const storageId    = "local-lvm-1tb";  // pool del SDD reparado
const templateVmId = 901;              // golden image generada por Packer
const vmId         = 902;
const vmName       = "zenith-lab";

// ── IP Fija de la VM ─────────────────────────────────────────────────
// Esta IP debe estar reservada en el router para este MAC/hostname.
// CoreDNS expondrá el puerto 53 en esta IP → agregar al router como DNS.
const vmStaticIp  = "192.168.14.50";
const vmGateway   = "192.168.14.1";   // Ajustar si tu router es diferente
const vmSubnet    = "24";             // /24 = 255.255.255.0

// ── Crear la Máquina Virtual Zenith ──────────────────────────────────
const zenithLabVm = new proxmoxve.vm.VirtualMachine(vmName, {
    nodeName: targetNode,
    vmId:     vmId,
    name:     vmName,
    description: [
        "Zenith Lab — VM principal de infraestructura",
        "IP: " + vmStaticIp,
        "DNS: CoreDNS expuesto en " + vmStaticIp + ":53",
        "Dominio: *.zen.ll",
        "Aprovisionado por Pulumi + Packer (Debian 13 Cloud-Init)",
    ].join("\n"),
    tags: ["zenith", "lab", "dev", "dns"],

    // ── Hardware ──────────────────────────────────────────────────────
    cpu: {
        cores:  4,
        type:   "host",   // rendimiento máximo para un lab
        sockets: 1,
    },
    memory: {
        dedicated: 12288,  // 12 GB
    },

    // ── Disco principal (en el pool local-lvm-1tb) ────────────────────
    disks: [{
        datastoreId: storageId,
        interface:   "scsi0",
        size:        60,         // 60 GB — suficiente para todos los contenedores
        fileFormat:  "raw",
        discard:     "on",       // TRIM para SSD/SSD-like
        iothread:    true,
    }],

    // ── Red ───────────────────────────────────────────────────────────
    networkDevices: [{
        bridge: "vmbr0",
        model:  "virtio",
    }],

    // ── Arranque ──────────────────────────────────────────────────────
    bootOrders: ["scsi0", "net0"],
    operatingSystem: {
        type: "l26",
    },

    // ── Clonar desde la golden image generada por Packer ─────────────
    clone: {
        vmId:     templateVmId,
        nodeName: targetNode,
        full:     false,   // linked clone — más rápido para lab
    },

    // ── QEMU Guest Agent ──────────────────────────────────────────────
    agent: {
        enabled: true,
        trim:    true,
    },

    // ── Cloud-Init: IP FIJA 192.168.14.50 ────────────────────────────
    initialization: {
        type: "nocloud",
        datastoreId: "local",   // cloud-init ISO se guarda en local
        userAccount: {
            username: "zenith",
            // La clave pública SSH se inyecta para acceso sin contraseña
            keys: [
                // Añade tu clave pública aquí, o usa pulumi config set
                // "ssh-ed25519 AAAA... tu-clave@tupc"
            ],
        },
        ipConfigs: [{
            ipv4: {
                address: vmStaticIp + "/" + vmSubnet,
                gateway: vmGateway,
            },
        }],
        dns: {
            // La VM se apunta a sí misma como DNS (CoreDNS corre en ella)
            // Fallback a Cloudflare por si CoreDNS no arranca aún
            servers: [vmStaticIp, "1.1.1.1"],
            domain:  "zen.ll",
        },
    },
});

// ── Exports ───────────────────────────────────────────────────────────
export const vmIpAddress   = pulumi.output(vmStaticIp);
export const vmId_exported = pulumi.output(vmId);
export const dnsServer     = pulumi.output(vmStaticIp + ":53");
export const webServices   = pulumi.output({
    postal:   "http://" + vmStaticIp + ":50614",
    keycloak: "http://" + vmStaticIp + ":8080",
    zitadel:  "http://" + vmStaticIp + ":8081",
    novu:     "http://" + vmStaticIp + ":4614",
    rustfs:   "http://" + vmStaticIp + ":8615",
});

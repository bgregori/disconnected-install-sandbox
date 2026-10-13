# Disconnected OpenShift 4 — AWS Sandbox

Ansible playbooks that provision an isolated AWS sandbox simulating a **disconnected OpenShift 4** installation target. The private subnet is fully air-gapped — no NAT gateway, no internet gateway routes, no VPC endpoints.

## What Gets Built

```
                 ┌──────────────────────────────────────────────────────┐
                 │              VPC 10.0.0.0/16                        │
  INTERNET       │                                                      │
  ──────► IGW ───┤  Public Subnet 10.0.1.0/24                          │
  :443/:6443     │    bastion (t3.xlarge) + HAProxy + EIP                │
                 │      │                                               │
                 │  ────│── Private Subnet 10.0.2.0/24 ──────────────  │
                 │      │                                               │
                 │      ├── services (t3.large, 50 GiB)                         │
                 │      │     BIND9 DNS + Chrony NTP                    │
                 │      │     Keycloak OIDC issuer (:8443) + PostgreSQL │
                 │      │                                               │
                 │      ├── registry (t3.large + 500 GiB)               │
                 │      │     provisioned, not configured                │
                 │      │                                               │
                 │      └── kvm (m5.metal + data vol) [optional]        │
                 │            libvirt/KVM + sushy-emulator (Redfish)     │
                 │            ├── ocp-master-0 VM (10.0.2.100)          │
                 │            ├── ocp-master-1 VM (10.0.2.101)          │
                 │            ├── ocp-master-2 VM (10.0.2.102)          │
                 │            ├── API VIP     (10.0.2.103, keepalived)   │
                 │            └── Ingress VIP (10.0.2.104, keepalived)   │
                 │                                                      │
                 │      *** NO route to internet ***                    │
                 └──────────────────────────────────────────────────────┘
```

**3-4 hosts** across 2 subnets (4 when KVM is enabled), with split-horizon DNS (Route53 external, BIND9 internal), HAProxy L4 TCP passthrough for API/console ingress, FIPS 140-3 enabled, and DISA STIG applied on all hosts.

**KVM bare metal simulation (optional, default: enabled):** An m5.metal EC2 instance runs libvirt/KVM with the OCP node VMs for the selected [cluster topology](#cluster-topology), using bridge networking with proxy ARP — VMs appear as real hosts on the private subnet. sushy-emulator provides a Redfish BMC API, enabling the **OpenShift Agent-Based Installer (ABI)** — the standard method for disconnected bare metal deployments. Toggle with `enable_kvm_host: false` to skip (environment works the same as before, with OCP nodes deferred to the IPI installer).

**OIDC identity provider (optional, default: disabled):** The services host can run the Red Hat
build of Keycloak (RHBK) with a PostgreSQL backing store, both as podman containers managed by
Quadlet, serving an issuer at `https://keycloak.ocp.{sandbox_domain}:8443/realms/openshift` for a
cluster to federate to. Opt in with `-e enable_keycloak_idp=true`, which adds both the image
staging and the role, and sizes the services host up from `t3.medium` to `t3.large` — the two
container memory limits come to 2.25 GiB, which leaves too little headroom on a 4 GiB host that is
also serving DNS and NTP. The images cannot be pulled on an air-gapped host, so the bastion pulls them
and `podman save`s them into the same httpd document root that already serves the yum repo. That
pull needs Red Hat registry credentials, which is why the IdP is off by default:

```bash
ansible-playbook playbooks/phase2_configure.yml -i inventory/aws_ec2.yml \
  -e sandbox_domain=example.com \
  -e enable_keycloak_idp=true \
  -e bastion_repo_registry_auth_file=~/pull-secret.json
```

Without those credentials Phase 2 fails fast with an explanatory message. See
`roles/keycloak_idp/defaults/main.yml` for what the role does and does not do about FIPS,
and for Red Hat's support posture on running RHBK under podman.

**One root of trust:** the first thing Phase 2 does is create a sandbox root CA and install it in
every host's trust store, before anything else needs TLS — including the bastion package repo, which
a host cannot install from over a connection it does not yet trust. Every TLS endpoint in the
environment chains to that root: the bastion repo, the Keycloak issuer, and the Redfish BMC. The CA
private key is generated on the **controller** (your workstation) and never leaves it — hosts
generate their own leaf keys and send only a CSR to be signed, so no sandbox host can read the root.
`validate.yml` checks that each endpoint presents a chain the hosts trust. See
[Certificates and the sandbox CA](#certificates-and-the-sandbox-ca) for the artifacts handed to you.

The **registry host** is provisioned as infrastructure only — registry software setup using Red Hat's `mirror-registry` binary and `oc mirror v2` is handled by a separate project. Its certificate, however, is already issued and waiting.

## Prerequisites

- Ansible >= 2.15 with Python >= 3.9
- boto3 >= 1.28.0
- Collections: `amazon.aws >= 9.0.0`, `community.crypto >= 2.0.0`, `ansible.posix >= 1.6.0`, `community.general >= 8.0.0`
- An AWS account with permissions to create VPC, EC2, Route53, and security group resources
- A Route53 hosted zone for your domain (the playbooks create A records in an existing zone)

```bash
ansible-galaxy collection install -r requirements.yml
pip install boto3 botocore
```

> **Note for Red Hat OpenShift Solutions Architects:** You can use the **Open AWS Environment** catalog item in the [Red Hat Demo Platform](https://demo.redhat.com) to get an ephemeral AWS account with a delegated Route53 domain — ideal for sandbox use without touching personal or customer AWS accounts.

## Quick Start

1. **Export your AWS credentials**:

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="wJalr..."
```

> **Never commit these credentials to a git repository.**

2. **Run the full provision + configure**:

```bash
ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32
```

This runs both phases sequentially and builds a **3-node compact cluster** (the
default). Add `-e ocp_topology=sno` or `-e ocp_topology=standard` for the other
shapes — see [Cluster Topology](#cluster-topology) for all three commands.

To skip the KVM bare metal host (saves ~$4.60/hr):

```bash
ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32 \
  -e enable_kvm_host=false
```

You can also run the phases independently:

```bash
# Phase 1 only — AWS infrastructure (VPC, SGs, EC2, SSH config, Route53)
ansible-playbook playbooks/phase1_provision.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32

# Phase 2 only — configure RHEL 9 services (requires Phase 1 complete)
ansible-playbook playbooks/phase2_configure.yml
```

3. **Validate the environment**:

```bash
ansible-playbook playbooks/validate.yml \
  -e sandbox_domain=example.com
```

4. **Tear down everything** when done:

```bash
ansible-playbook playbooks/teardown.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com
```

## Required Variables

These have **no defaults** — playbooks fail fast if not provided:

| Variable | Source | Example |
|---|---|---|
| `aws_region` | Your choice | `us-east-2` |
| `sandbox_domain` | Your Route53 hosted zone | `example.com` |
| `admin_cidr` | Your public IP + /32 | `203.0.113.42/32` |

## Cluster Topology

`ocp_topology` is the single knob for cluster shape. Pick one and the node count,
node IPs, VIPs, DNS records, per-VM sizing, and the KVM host data volume are all
derived from it — there is nothing else to size by hand.

| `ocp_topology` | Nodes | Per-VM sizing | KVM data volume |
|---|---|---|---|
| `sno` | 1 master (schedulable) | 32 vCPU, 128 GiB, 120 GiB boot + 500 GiB storage disk | 750 GiB |
| `compact` *(default)* | 3 masters (schedulable) | 16 vCPU, 48 GiB, 120 GiB boot + 150 GiB storage disk | 1000 GiB |
| `standard` | 3 masters + 3 workers | 8 vCPU, 24 GiB (master) / 32 GiB (worker), 120 GiB boot | 900 GiB |

### Single-node OpenShift (SNO)

One schedulable master. Sized for an OpenShift Virtualization POC — it gets the
secondary disk for the LVM Storage Operator and enough RAM to run nested VMs.

```bash
ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32 \
  -e ocp_topology=sno
```

Produces `ocp-master-0` at 10.0.2.100. Both VIPs collapse onto that address, so
`api.ocp.<domain>` and `*.apps.ocp.<domain>` resolve to 10.0.2.100 internally.

### 3-node compact cluster (default)

Three schedulable masters, no dedicated workers. This is what you get if you omit
`ocp_topology` entirely.

```bash
ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32 \
  -e ocp_topology=compact
```

Produces `ocp-master-0..2` at 10.0.2.100-102, API VIP 10.0.2.103, ingress VIP
10.0.2.104. Each master keeps a smaller 150 GiB secondary disk for LVM Storage.

### 3 masters + 3 workers

A dedicated control plane with three worker nodes. Workers are sized for ordinary
container workloads and get no secondary disk.

```bash
ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32 \
  -e ocp_topology=standard
```

Produces `ocp-master-0..2` at 10.0.2.100-102 and `ocp-worker-0..2` at
10.0.2.103-105, API VIP 10.0.2.106, ingress VIP 10.0.2.107. Set
`controlPlane.replicas: 3` and `compute[0].replicas: 3` in `install-config.yaml`
to match — see [docs/agent-based-install.md](docs/agent-based-install.md).

### Naming and addressing

Whichever topology you pick, VMs are named `ocp-master-N` / `ocp-worker-N` (the
prefix follows `cluster_name`), resolve as `master-N.ocp.<domain>` /
`worker-N.ocp.<domain>` in BIND9, and get matching `ocp-master-N-sandbox` SSH
config aliases. Masters are allocated first from `10.0.2.100`, then workers, with
the API and ingress VIPs on the two addresses after the last node.

Phase 1 prints the resolved topology, the full node-to-IP map, and the VIPs when
it finishes, so you can copy them straight into `agent-config.yaml`.

All presets fit an m5.metal host (96 vCPU / 384 GiB) with headroom reserved for
the hypervisor. Phase 1 fails fast if the data volume is too small for the
topology, and the `kvm_host` role refuses to define VMs that overcommit the host.

### Overriding a preset

Every derived value stays individually overridable, so you only set what you want
to change:

```bash
# 3 masters + 5 workers, more worker RAM, bigger data volume
ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 -e sandbox_domain=example.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32 \
  -e ocp_topology=standard \
  -e ocp_worker_count=5 \
  -e ocp_worker_memory_mb=65536 \
  -e kvm_data_volume_size=1600
```

Available overrides: `ocp_master_count`, `ocp_worker_count`,
`ocp_{master,worker}_{vcpu,memory_mb,disk_gb,storage_disk,storage_disk_gb}`,
`kvm_data_volume_size`, `kvm_instance_type`, and `kvm_reserved_{vcpu,memory_mb}`.

> `kvm_data_volume_size` only takes effect on a fresh provision. Growing it on an
> existing sandbox means resizing the EBS volume and XFS filesystem by hand.

## Two-Phase Execution

### Phase 1 — Provision AWS Infrastructure

Runs on `localhost` via boto3 API calls. Creates:

- VPC with public and air-gapped private subnets
- 4-5 security groups with strict isolation rules (including `sg-ocp-nodes` and optional `sg-kvm-host`)
- 3-4 EC2 instances (RHEL 9) with static private IPs (4 when KVM is enabled: includes m5.metal)
- Elastic IP for bastion
- SSH config with ProxyCommand for private host access
- Route53 A records (`api.ocp.*`, `*.apps.ocp.*`) pointing to bastion EIP

### Phase 2 — Configure RHEL 9 Services

Runs on remote hosts via SSH through the bastion ProxyCommand tunnel:

1. **Environment PKI** — create the sandbox root CA on the controller, trust it on every host, and issue the registry and cluster certificates into `artifacts/pki/cluster/`. First, because the bastion repo below is itself a TLS endpoint.
2. **Bastion local repo** — httpd on :8080 serving RPMs for air-gapped hosts, over TLS using a certificate from the sandbox CA (`bastion_repo_tls=false` falls back to plain HTTP)
3. **RHUI disable + bastion repo config** — disable cloud repos on private hosts, point to bastion
4. **FIPS 140-3** — enabled on all hosts with reboot
5. **BIND9 DNS** — authoritative zone for `ocp.{sandbox_domain}`
6. **Chrony NTP** — local stratum 10 server (no upstream — air-gapped)
7. **DNS/NTP clients** — all private hosts pointed at services host
8. **HAProxy** — L4 TCP passthrough on bastion for OCP API (:6443) and apps (:443/:80), routes to keepalived VIPs
9. **KVM host** (when enabled) — libvirt/KVM with 3 OCP node VMs using bridge networking with proxy ARP
10. **Redfish BMC** (when enabled) — sushy-emulator for Redfish API access to VMs
11. **DISA STIG** — OpenSCAP remediation on private hosts first, then bastion
12. **Keycloak OIDC issuer** — RHBK + PostgreSQL in podman on the services host, after the
    private-host STIG pass and before the bastion's

STIG runs on private hosts before bastion so the bastion's httpd repo remains available while private hosts install `openscap-scanner` and `scap-security-guide` from it. The STIG remediation and sudo NOPASSWD restoration run in a single shell command to prevent lockout.

## Accessing the Environment

After provisioning, the bastion bridges the air gap:

**SSH to private hosts:**
```bash
ssh -F ~/.ssh/config.d/disconnected-sandbox services-sandbox
ssh -F ~/.ssh/config.d/disconnected-sandbox registry-sandbox
ssh -F ~/.ssh/config.d/disconnected-sandbox kvm-sandbox       # when KVM enabled
```

**Redfish BMC** (from bastion, when KVM enabled):
```bash
# List OCP node VMs
curl http://10.0.2.30:8000/redfish/v1/Systems/
# Power on a VM
curl -X POST http://10.0.2.30:8000/redfish/v1/Systems/<uuid>/Actions/ComputerSystem.Reset \
  -H 'Content-Type: application/json' -d '{"ResetType": "On"}'
# Mount agent ISO
curl -X POST http://10.0.2.30:8000/redfish/v1/Managers/<uuid>/VirtualMedia/Cd/Actions/VirtualMedia.InsertMedia \
  -H 'Content-Type: application/json' -d '{"Image": "file:///var/lib/libvirt/images/agent.x86_64.iso"}'
```

**Agent-Based Installer workflow** (after mirror-registry is configured):
1. Generate the agent ISO: `openshift-install agent create image`
2. SCP the ISO to the KVM host: `scp -F ~/.ssh/config.d/disconnected-sandbox agent.x86_64.iso kvm-sandbox:/var/lib/libvirt/images/`
3. From the bastion, mount the ISO and boot each VM via Redfish API
4. VMs boot from the ISO, discover peers, and form the OpenShift cluster

**OpenShift endpoints** (after OCP installation):
- API: `https://api.ocp.{sandbox_domain}:6443`
- Console: `https://console-openshift-console.apps.ocp.{sandbox_domain}`

Both resolve via Route53 to the bastion EIP, where HAProxy forwards to the keepalived VIPs over the private network.

## Split-Horizon DNS

Two DNS views serve the same names with different targets:

| Record | External (Route53) | Internal (BIND9) |
|---|---|---|
| `api.ocp.*` | Bastion EIP (HAProxy) | API VIP `10.0.2.103` (keepalived) |
| `api-int.ocp.*` | not published | API VIP `10.0.2.103` (keepalived) |
| `*.apps.ocp.*` | Bastion EIP (HAProxy) | Ingress VIP `10.0.2.104` (keepalived) |

Both external and internal traffic routes through the VIPs. External clients (browser, `oc` CLI) hit Route53 -> bastion EIP -> HAProxy -> VIPs. Internal clients (OCP nodes, pods) resolve via BIND9 -> VIPs directly. OpenShift's keepalived manages the VIPs across control plane nodes for HA failover. The KVM host bridge uses proxy ARP and /32 routes so AWS routes traffic to the VIPs correctly.

## Certificates and the Sandbox CA

`roles/pki` creates one certificate authority for the whole environment, replacing what used to be
two unrelated private CAs and two plaintext services. It runs first in Phase 2, because every TLS
endpoint after it chains to this root.

**Where things live:**

| Path | What it is |
|---|---|
| `artifacts/pki/sandbox-ca.crt` / `.key` | The root CA. On the **controller only** — no sandbox host ever holds the key. |
| `/etc/pki/ca-trust/source/anchors/sandbox-ca.crt` | The anchor on each host, compiled in by `update-ca-trust`. |
| `artifacts/pki/cluster/` | Pre-issued certificates for the registry and the cluster, plus a `README.md` with the commands. |

**Pre-issued handoff artifacts** — issued up front so that whoever stands up the mirror registry or
runs the installer finds a certificate from this environment's root already waiting, rather than
reaching that step, finding nothing, and generating a self-signed one:

| File | Used by |
|---|---|
| `registry.crt` / `.key` | `mirror-registry --sslCert/--sslKey` (SANs: `registry.ocp.*`, registry private IP) |
| `api.crt` / `.key` | `APIServer` named certificate (SANs: `api.ocp.*`, `api-int.ocp.*`, API VIP) |
| `ingress.crt` / `.key` | `IngressController` default certificate (SANs: `*.apps.ocp.*`, ingress VIP) |
| `install-config-additionalTrustBundle.yaml` | Paste straight into `install-config.yaml` — this is what lets the installer and every node verify the mirror registry |

**Details that matter:**

- **RSA 3072 / SHA-256**, both FIPS 140-3 approved. RSA rather than EC sidesteps any question about which curves the host crypto policy still offers after `fips-mode-setup`, and 3072 bits clears RHBK's 2048-bit strict-FIPS floor.
- **Leaf validity is 397 days.** Apple rejects TLS server certificates valid longer than 398 days, and the error names the wrong problem entirely. `openssl` accepts longer happily, so it only surfaces when an operator opens the endpoint in a browser on macOS.
- **The CA survives a teardown**, like the SSH key — anything you taught to trust this sandbox once keeps working after a reprovision. Teardown does not touch `artifacts/`, and the role only writes the key when it is missing; delete `artifacts/pki/` by hand to mint a fresh root. (`sandbox_preserve_ca` states that intent but is currently read by nothing.)
- **Rotating a leaf:** delete the `.crt` and re-run. Changing `pki_cert_validity` alone does not reissue — `community.crypto` ignores timestamp drift by design.
- **Adding a TLS endpoint:** include the role with `tasks_from: issue.yml` (the contract is documented at the top of that file; the private key is generated on the target host and only the CSR travels to the controller), and add the endpoint to the list in `playbooks/validate.yml`.

## Project Structure

```
playbooks/             Orchestration playbooks (site, phase1, phase2, teardown, validate)
roles/infra_vpc        Phase 1 — VPC, subnets, IGW, route tables
roles/infra_security_groups  Phase 1 — Security groups with strict isolation rules
roles/infra_ec2        Phase 1 — EC2 instances, SSH key pair (locally generated)
roles/infra_route53    Phase 1 — Route53 DNS records
roles/infra_ssh_config Phase 1 — Local SSH config with ProxyCommand
roles/pki              Phase 2 — Sandbox root CA, host trust, leaf certificate issuance
roles/data_volume      Phase 2 — Format and mount an EBS data volume by UUID
roles/bastion_repo     Phase 2 — Local yum repo on bastion
roles/bind_dns         Phase 2 — BIND9 DNS server
roles/chrony_ntp       Phase 2 — Chrony NTP server
roles/common_client    Phase 2 — DNS/NTP client config for all private hosts
roles/keycloak_idp     Phase 2 — Red Hat build of Keycloak as an OIDC issuer
roles/bastion_haproxy  Phase 2 — HAProxy reverse proxy
roles/kvm_host         Phase 2 — KVM/libvirt host with OCP node VMs (optional)
roles/redfish_bmc      Phase 2 — sushy-emulator Redfish BMC (optional)
roles/rhel_hardening   Phase 2 — FIPS 140-3 + DISA STIG
roles/ocp_node_prep    Validation — OCP node prerequisites (DNS, NTP, FIPS checks)
inventory/             Dynamic inventory (aws_ec2 plugin) + group_vars
artifacts/pki/         Sandbox root CA + pre-issued cluster certificates (gitignored)
docs/                  Operational guides (agent-based-install)
scripts/               Helper scripts (RPM download)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full blueprint: AWS resource mapping, security group matrix, execution workflow, and variable hierarchy.

## Dynamic Inventory

The `amazon.aws.aws_ec2` plugin discovers hosts by `Project: disconnected-sandbox` tag and groups them by `sandbox_role` tag. It uses `hostvars_prefix: aws_` to avoid collisions with Ansible's reserved `tags` variable and composes `ansible_host` from public IP (bastion) or private IP (everyone else). A `private_hosts` group auto-applies ProxyCommand SSH args for tunneling through the bastion.

## Debugging

```bash
# Verbose output
ansible-playbook playbooks/site.yml -vvv

# Test SSH through bastion
ssh -F ~/.ssh/config.d/disconnected-sandbox services-sandbox hostname

# Test dynamic inventory
ansible-inventory -i inventory/aws_ec2.yml --graph

# Validate air-gap (should show only local route)
aws ec2 describe-route-tables \
  --filters "Name=tag:Name,Values=disconnected-sandbox-private-rt" \
  --query 'RouteTables[].Routes'
```

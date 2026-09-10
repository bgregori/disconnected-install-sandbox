# Disconnected OpenShift 4 — AWS Sandbox

Ansible playbooks that provision an isolated AWS sandbox simulating a **disconnected OpenShift 4** installation target. The private subnet is fully air-gapped — no NAT gateway, no internet gateway routes, no VPC endpoints.

Designed for [OPENTLC Open AWS Environments](https://labs.opentlc.com) where users receive ephemeral AWS credentials and a delegated Route53 domain.

## What Gets Built

```
                 ┌──────────────────────────────────────────────────────┐
                 │              VPC 10.0.0.0/16                        │
  INTERNET       │                                                      │
  ──────► IGW ───┤  Public Subnet 10.0.1.0/24                          │
  :443/:6443     │    bastion (t3.medium) + HAProxy + EIP               │
                 │      │                                               │
                 │  ────│── Private Subnet 10.0.2.0/24 ──────────────  │
                 │      │                                               │
                 │      ├── services (t3.medium)                        │
                 │      │     BIND9 DNS + Chrony NTP                    │
                 │      │                                               │
                 │      ├── registry (t3.large + 200 GiB)               │
                 │      │     provisioned, not configured                │
                 │      │                                               │
                 │      └── kvm (m5.metal + 500 GiB) [optional]         │
                 │            libvirt/KVM + sushy-emulator (Redfish)     │
                 │            ├── ocp-node-0 VM (10.0.2.100)            │
                 │            ├── ocp-node-1 VM (10.0.2.101)            │
                 │            ├── ocp-node-2 VM (10.0.2.102)            │
                 │            ├── API VIP     (10.0.2.103, keepalived)   │
                 │            └── Ingress VIP (10.0.2.104, keepalived)   │
                 │                                                      │
                 │      *** NO route to internet ***                    │
                 └──────────────────────────────────────────────────────┘
```

**3-4 hosts** across 2 subnets (4 when KVM is enabled), with split-horizon DNS (Route53 external, BIND9 internal), HAProxy L4 TCP passthrough for API/console ingress, FIPS 140-3 enabled, and DISA STIG applied on all hosts.

**KVM bare metal simulation (optional, default: enabled):** An m5.metal EC2 instance runs libvirt/KVM with 3 OCP node VMs using macvtap networking — VMs appear as real hosts on the private subnet. sushy-emulator provides a Redfish BMC API, enabling the **OpenShift Agent-Based Installer (ABI)** — the standard method for disconnected bare metal deployments. Toggle with `enable_kvm_host: false` to skip (environment works the same as before, with OCP nodes deferred to the IPI installer).

The **registry host** is provisioned as infrastructure only — registry software setup using Red Hat's `mirror-registry` binary and `oc mirror v2` is handled by a separate project.

## Prerequisites

- Ansible >= 2.15 with Python >= 3.9
- boto3 >= 1.28.0
- An OPENTLC Open AWS Environment (provides AWS credentials + Route53 domain)

```bash
ansible-galaxy collection install -r requirements.yml
pip install boto3 botocore
```

## Quick Start

1. **Export your AWS credentials** (from your OPENTLC environment email):

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="wJalr..."
```

> **Never commit these credentials.** If detected, your OPENTLC environment will be deleted without warning.

2. **Run the full provision + configure**:

```bash
ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=sandbox2229.opentlc.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32
```

This runs both phases sequentially. To skip the KVM bare metal host (saves ~$4.60/hr):

```bash
ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=sandbox2229.opentlc.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32 \
  -e enable_kvm_host=false
```

You can also run the phases independently:

```bash
# Phase 1 only — AWS infrastructure (VPC, SGs, EC2, SSH config, Route53)
ansible-playbook playbooks/phase1_provision.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=sandbox2229.opentlc.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32

# Phase 2 only — configure RHEL 9 services (requires Phase 1 complete)
ansible-playbook playbooks/phase2_configure.yml
```

3. **Validate the environment**:

```bash
ansible-playbook playbooks/validate.yml \
  -e sandbox_domain=sandbox2229.opentlc.com
```

4. **Tear down everything** when done:

```bash
ansible-playbook playbooks/teardown.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=sandbox2229.opentlc.com
```

## Required Variables

These have **no defaults** — playbooks fail fast if not provided:

| Variable | Source | Example |
|---|---|---|
| `aws_region` | Your choice | `us-east-2` |
| `sandbox_domain` | OPENTLC environment email | `sandbox2229.opentlc.com` |
| `admin_cidr` | Your public IP + /32 | `203.0.113.42/32` |

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

1. **Bastion local repo** — httpd on :8080 serving RPMs for air-gapped hosts
2. **RHUI disable + bastion repo config** — disable cloud repos on private hosts, point to bastion
3. **FIPS 140-3** — enabled on all hosts with reboot
4. **BIND9 DNS** — authoritative zone for `ocp.{sandbox_domain}`
5. **Chrony NTP** — local stratum 10 server (no upstream — air-gapped)
6. **DNS/NTP clients** — all private hosts pointed at services host
7. **HAProxy** — L4 TCP passthrough on bastion for OCP API (:6443) and apps (:443/:80), routes to keepalived VIPs
8. **KVM host** (when enabled) — libvirt/KVM with 3 OCP node VMs using macvtap networking
9. **Redfish BMC** (when enabled) — sushy-emulator for Redfish API access to VMs
10. **DISA STIG** — OpenSCAP remediation on private hosts first, then bastion

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

Both resolve via Route53 to the bastion EIP, where HAProxy forwards to the OCP nodes over the private network.

## Split-Horizon DNS

Two DNS views serve the same names with different targets:

| Record | External (Route53) | Internal (BIND9) |
|---|---|---|
| `api.ocp.*` | Bastion EIP (HAProxy) | API VIP `10.0.2.103` (keepalived) |
| `api-int.ocp.*` | not published | API VIP `10.0.2.103` (keepalived) |
| `*.apps.ocp.*` | Bastion EIP (HAProxy) | Ingress VIP `10.0.2.104` (keepalived) |

Both external and internal traffic routes through the VIPs. External clients (browser, `oc` CLI) hit Route53 -> bastion EIP -> HAProxy -> VIPs. Internal clients (OCP nodes, pods) resolve via BIND9 -> VIPs directly. OpenShift's keepalived manages the VIPs across control plane nodes for HA failover. The VIPs (`api_vip`, `ingress_vip`) are registered as secondary IPs on the KVM host ENI so AWS routes the traffic correctly.

## Project Structure

```
playbooks/           Orchestration playbooks (site, phase1, phase2, teardown, validate)
roles/infra_*        Phase 1 — AWS resource provisioning (runs on localhost)
roles/bind_dns       Phase 2 — BIND9 DNS server
roles/chrony_ntp     Phase 2 — Chrony NTP server
roles/bastion_repo   Phase 2 — Local yum repo on bastion
roles/bastion_haproxy Phase 2 — HAProxy reverse proxy
roles/kvm_host       Phase 2 — KVM/libvirt host with OCP node VMs (optional)
roles/redfish_bmc    Phase 2 — sushy-emulator Redfish BMC (optional)
roles/rhel_hardening Phase 2 — FIPS 140-3 + DISA STIG
roles/common_client  Phase 2 — DNS/NTP client config for all private hosts
roles/ocp_node_prep  Validation — OCP node prerequisites (DNS, NTP, FIPS checks)
inventory/           Dynamic inventory (aws_ec2 plugin) + group_vars
scripts/             Helper scripts (RPM download)
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

# Disconnected OpenShift 4 — AWS Sandbox

Ansible playbooks that provision an isolated AWS sandbox simulating a **disconnected OpenShift 4** installation target. The private subnet is fully air-gapped — no NAT gateway, no internet gateway routes, no VPC endpoints.

Designed for [OPENTLC Open AWS Environments](https://labs.opentlc.com) where users receive ephemeral AWS credentials and a delegated Route53 domain.

## What Gets Built

```
                 ┌─────────────────────────────────────────────┐
                 │              VPC 10.0.0.0/16                │
  INTERNET       │                                             │
  ──────► IGW ───┤  Public Subnet 10.0.1.0/24                 │
  :443/:6443     │    bastion (t3.medium) + HAProxy + EIP      │
                 │      │                                      │
                 │  ────│── Private Subnet 10.0.2.0/24 ─────  │
                 │      │                                      │
                 │      ├── services (t3.medium)               │
                 │      │     BIND9 DNS + Chrony NTP           │
                 │      │                                      │
                 │      ├── registry (t3.large + 200 GiB)      │
                 │      │     provisioned, not configured       │
                 │      │                                      │
                 │      ├── ocp-node-0 (m5.2xlarge)            │
                 │      ├── ocp-node-1 (m5.2xlarge)            │
                 │      └── ocp-node-2 (m5.2xlarge)            │
                 │                                             │
                 │      *** NO route to internet ***           │
                 └─────────────────────────────────────────────┘
```

**6 hosts** across 2 subnets, with split-horizon DNS (Route53 external, BIND9 internal), HAProxy L4 TCP passthrough for API/console ingress, FIPS 140-3 enabled, and DISA STIG applied on all hosts.

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

This runs both phases sequentially. You can also run them independently:

```bash
# Phase 1 only — AWS infrastructure (VPC, SGs, EC2, Route53)
ansible-playbook playbooks/phase1_provision.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=sandbox2229.opentlc.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32

# Phase 2 only — configure RHEL 9 services (requires Phase 1 complete)
ansible-playbook playbooks/phase2_configure.yml -i inventory/aws_ec2.yml
```

3. **Validate the environment**:

```bash
ansible-playbook playbooks/validate.yml -i inventory/aws_ec2.yml
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
- 4 security groups with strict isolation rules
- 6 EC2 instances (RHEL 9) with static private IPs
- Elastic IP for bastion
- SSH config with ProxyCommand for private host access

### Phase 2 — Configure RHEL 9 Services

Runs on remote hosts via SSH through the bastion ProxyCommand tunnel:

1. **Bastion local repo** — httpd on :8080 serving RPMs for air-gapped hosts
2. **FIPS 140-3** — enabled on all hosts with reboot
3. **BIND9 DNS** — authoritative zone for `ocp.{sandbox_domain}`
4. **Chrony NTP** — local stratum 10 server (no upstream — air-gapped)
5. **DNS/NTP clients** — all private hosts pointed at services host
6. **HAProxy** — L4 TCP passthrough on bastion for OCP API (:6443) and apps (:443/:80)
7. **Route53** — external A records pointing to bastion EIP
8. **DISA STIG** — OpenSCAP remediation on all hosts
9. **OCP node prep** — final validation of DNS, NTP, FIPS on cluster nodes

## Accessing the Environment

After provisioning, the bastion bridges the air gap:

**SSH to private hosts:**
```bash
ssh -F ~/.ssh/config.d/disconnected-sandbox services-sandbox
ssh -F ~/.ssh/config.d/disconnected-sandbox registry-sandbox
```

**OpenShift endpoints** (after OCP installation):
- API: `https://api.ocp.{sandbox_domain}:6443`
- Console: `https://console-openshift-console.apps.ocp.{sandbox_domain}`

Both resolve via Route53 to the bastion EIP, where HAProxy forwards to the OCP nodes over the private network.

## Project Structure

```
playbooks/           Orchestration playbooks (site, phase1, phase2, teardown, validate)
roles/infra_*        Phase 1 — AWS resource provisioning (runs on localhost)
roles/bind_dns       Phase 2 — BIND9 DNS server
roles/chrony_ntp     Phase 2 — Chrony NTP server
roles/bastion_repo   Phase 2 — Local yum repo on bastion
roles/bastion_haproxy Phase 2 — HAProxy reverse proxy
roles/rhel_hardening Phase 2 — FIPS 140-3 + DISA STIG
roles/common_client  Phase 2 — DNS/NTP client config for all private hosts
roles/ocp_node_prep  Phase 2 — OCP node prerequisites and validation
inventory/           Dynamic inventory (aws_ec2 plugin) + group_vars
scripts/             Helper scripts (RPM download)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full blueprint: AWS resource mapping, security group matrix, execution workflow, and variable hierarchy.

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

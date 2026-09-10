# Disconnected OpenShift AWS Sandbox — Architecture Blueprint

## 0. Operator Environment (OPENTLC Open Environment)

Users provision an **Open AWS Environment** via OPENTLC, which provides:

| Credential                | Example Value                                    | Handling                         |
|---------------------------|--------------------------------------------------|----------------------------------|
| `AWS_ACCESS_KEY_ID`       | `AKIA...`                                        | Export as env var, NEVER commit  |
| `AWS_SECRET_ACCESS_KEY`   | `wJalr...`                                       | Export as env var, NEVER commit  |
| Route53 domain            | `.sandbox2229.opentlc.com`                       | Required variable: `sandbox_domain` |
| AWS Console URL           | `https://859881501468.signin.aws.amazon.com/console` | For manual verification only  |
| AWS Console credentials   | `open-environment-txd6c-admin / ********`        | For manual verification only     |
| AWS Region                | User's choice (no default)                       | Required variable: `aws_region`  |

**Required user-provided variables (no defaults — playbook fails fast if missing):**

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="wJalr..."

ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=sandbox2229.opentlc.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32
```

The domain `sandbox_domain` is the OPENTLC-delegated Route53 zone. All DNS records
are created under `ocp.{{ sandbox_domain }}` (e.g., `api.ocp.sandbox2229.opentlc.com`).

---

## 1. Repository Structure

```
disconnected-openshift-aws-sandbox/
├── CLAUDE.md                               # Dev guidelines, lint rules, execution commands
├── ansible.cfg                             # Ansible configuration
├── requirements.yml                        # Galaxy collection & role dependencies
│
├── inventory/
│   ├── group_vars/
│   │   ├── all.yml                         # Global: networking, IPs, instance types, hardening, SSH
│   │   ├── bastion.yml                     # Direct SSH — no ProxyCommand
│   │   ├── services.yml                    # NTP allow subnet
│   │   ├── registry.yml                    # Infrastructure-only marker (mirror-registry is separate)
│   │   └── private_hosts.yml               # ProxyCommand SSH args for bastion tunnel
│   ├── host_vars/                          # Per-host overrides (rarely needed)
│   └── aws_ec2.yml                         # amazon.aws.aws_ec2 dynamic inventory plugin config
│
├── playbooks/
│   ├── site.yml                            # Master orchestrator (imports phase1 + phase2)
│   ├── phase1_provision.yml                # AWS infrastructure (runs on localhost)
│   ├── phase2_configure.yml                # RHEL 9 services (runs via bastion proxy)
│   ├── teardown.yml                        # Idempotent destroy of all tagged resources
│   └── validate.yml                        # End-to-end smoke tests
│
├── roles/
│   ├── infra_vpc/                          # VPC, subnets, IGW, route tables
│   │   ├── tasks/main.yml
│   │   ├── defaults/main.yml
│   │   └── meta/main.yml
│   │
│   ├── infra_security_groups/              # All SG definitions with cross-references
│   │   ├── tasks/main.yml
│   │   ├── defaults/main.yml
│   │   └── meta/main.yml
│   │
│   ├── infra_ec2/                          # EC2 instances (bastion, services, registry, kvm) + EIP
│   │   ├── tasks/main.yml
│   │   ├── tasks/bastion.yml
│   │   ├── tasks/private_hosts.yml         # Services + registry only (OCP nodes via IPI)
│   │   ├── tasks/kvm.yml                   # KVM host (m5.metal) + secondary IPs + src/dst check
│   │   ├── defaults/main.yml
│   │   └── meta/main.yml
│   │
│   ├── infra_ssh_config/                   # Generate ~/.ssh/config stanza + ProxyCommand
│   │   ├── tasks/main.yml
│   │   ├── templates/ssh_config.j2
│   │   └── defaults/main.yml
│   │
│   ├── infra_route53/                      # Route53 A records in OPENTLC-delegated zone
│   │   ├── tasks/main.yml
│   │   ├── defaults/main.yml
│   │   └── meta/main.yml
│   │
│   ├── bastion_repo/                       # Local yum repo on bastion for air-gapped hosts
│   │   ├── tasks/main.yml
│   │   ├── templates/repo-httpd.conf.j2
│   │   ├── defaults/main.yml
│   │   ├── handlers/main.yml
│   │   └── meta/main.yml
│   │
│   ├── rhel_hardening/                     # FIPS 140-3 enablement + DISA STIG application
│   │   ├── tasks/main.yml
│   │   ├── tasks/fips.yml                  # fips-mode-setup + reboot + verify
│   │   ├── tasks/stig.yml                  # OpenSCAP STIG remediation + sudo restore
│   │   ├── defaults/main.yml
│   │   ├── handlers/main.yml
│   │   └── meta/main.yml
│   │
│   ├── bastion_haproxy/                    # HAProxy reverse proxy for OCP API + apps ingress
│   │   ├── tasks/main.yml
│   │   ├── templates/haproxy.cfg.j2
│   │   ├── defaults/main.yml
│   │   ├── handlers/main.yml
│   │   └── meta/main.yml
│   │
│   ├── bind_dns/                           # BIND9 authoritative DNS
│   │   ├── tasks/main.yml
│   │   ├── templates/named.conf.j2
│   │   ├── templates/db.forward.j2
│   │   ├── templates/db.reverse.j2
│   │   ├── defaults/main.yml
│   │   ├── handlers/main.yml
│   │   └── meta/main.yml
│   │
│   ├── chrony_ntp/                         # Chrony NTP server (stratum 10 local clock)
│   │   ├── tasks/main.yml
│   │   ├── templates/chrony-server.conf.j2
│   │   ├── defaults/main.yml
│   │   ├── handlers/main.yml
│   │   └── meta/main.yml
│   │
│   ├── common_client/                      # DNS + NTP client config for all private hosts
│   │   ├── tasks/main.yml
│   │   ├── templates/resolv.conf.j2
│   │   ├── templates/chrony-client.conf.j2
│   │   ├── defaults/main.yml
│   │   └── meta/main.yml
│   │
│   ├── kvm_host/                           # KVM/libvirt host with OCP node VMs (optional)
│   │   ├── tasks/main.yml
│   │   ├── templates/vm-domain.xml.j2
│   │   ├── defaults/main.yml
│   │   ├── handlers/main.yml
│   │   └── meta/main.yml
│   │
│   ├── redfish_bmc/                        # sushy-emulator Redfish BMC (optional)
│   │   ├── tasks/main.yml
│   │   ├── templates/sushy-emulator.conf.j2
│   │   ├── templates/sushy-emulator.service.j2
│   │   ├── defaults/main.yml
│   │   ├── handlers/main.yml
│   │   └── meta/main.yml
│   │
│   └── ocp_node_prep/                      # OCP node prerequisites (validation role)
│       ├── tasks/main.yml                  # Validate DNS, NTP, FIPS
│       ├── defaults/main.yml
│       └── meta/main.yml
│
├── files/
│   └── rpms/                               # Staging dir for offline RPM bundles (gitignored)
│
├── scripts/
│   └── download_rpms.sh                    # Pre-fetch RPMs on internet-connected machine
│
├── .ansible-lint                           # ansible-lint configuration
├── .yamllint                               # yamllint configuration
├── .gitignore
└── .github/
    └── workflows/
        └── lint.yml                        # CI: ansible-lint + yamllint
```

### Key Design Decisions

**Why `aws_ec2.yml` dynamic inventory instead of a custom plugin:**
The `amazon.aws.aws_ec2` inventory plugin is production-grade, supports tag-based grouping,
and eliminates custom code. Instances are tagged with `sandbox_role: bastion|services|registry`
and the plugin auto-populates groups. A `private_hosts` group is derived via expression to
apply ProxyCommand SSH args automatically. The `hostvars_prefix: aws_` avoids collision with
Ansible's reserved `tags` variable.

**Why separate `infra_*` roles instead of one monolith:**
Each infrastructure role maps to a distinct AWS resource lifecycle. `infra_vpc` must complete
before `infra_security_groups` (SGs reference VPC ID), which must complete before `infra_ec2`
(instances reference SG IDs). Separation makes teardown ordering trivial and enables selective reprovisioning.

**Why OCP nodes are NOT provisioned here:**
The OpenShift IPI installer creates its own EC2 instances at install time. This repo provisions
only the infrastructure the installer needs — VPC, subnets, security groups (`sg-ocp-nodes`),
DNS records, and HAProxy backends. The `ocp_node_ips` in `all.yml` are pre-defined so BIND9
zones and HAProxy config are ready before the installer runs.

**Why `common_client` role:**
Every private host (services, registry) needs identical DNS resolver and NTP client
configuration. Factoring this out prevents drift and deduplicates identical task lists.

**Package installation strategy (air-gap):**
Private subnet hosts have zero internet access. The bastion runs httpd on port 8080, serving
a local yum repo built by `bastion_repo` role. During Phase 2, private hosts are configured
to use `http://10.0.1.10:8080/rhel9-local/` after RHUI repos are disabled. Packages are
downloaded with `dnf download --resolve --alldeps` on the bastion (which has internet) and
served via createrepo metadata.

**Why Route53 runs in Phase 1:**
Route53 needs the bastion EIP, which is a `set_fact` from `infra_ec2`. Running Route53 in
Phase 2 would require cross-play variable passing through hostvars, which is fragile — Jinja2
eagerly evaluates `default()` arguments, so `groups['role_bastion'][0]` errors when the
dynamic inventory has no running hosts. Phase 1 avoids this entirely since `set_fact` values
persist within the same play.

---

## 2. AWS Resource Mapping

### 2.1 Networking Resources

| Resource              | Name / Tag                        | Configuration                                    |
|-----------------------|-----------------------------------|--------------------------------------------------|
| VPC                   | `disconnected-sandbox-vpc`        | CIDR: `10.0.0.0/16`, DNS hostnames enabled       |
| Internet Gateway      | `disconnected-sandbox-igw`        | Attached to VPC                                  |
| Public Subnet         | `disconnected-sandbox-public`     | CIDR: `10.0.1.0/24`, AZ: `{region}a`, auto-assign public IP |
| Private Subnet        | `disconnected-sandbox-private`    | CIDR: `10.0.2.0/24`, AZ: `{region}a`, NO auto-assign public IP |
| Public Route Table    | `disconnected-sandbox-public-rt`  | Routes: `10.0.0.0/16 → local`, `0.0.0.0/0 → IGW` |
| Private Route Table   | `disconnected-sandbox-private-rt` | Routes: `10.0.0.0/16 → local` ONLY (air-gapped) |
| Elastic IP            | `disconnected-sandbox-bastion-eip`| Associated with bastion ENI                      |
| Route53 A Record      | `api.ocp.{{ sandbox_domain }}`    | → Bastion EIP (HAProxy → OCP nodes :6443)        |
| Route53 A Record      | `*.apps.ocp.{{ sandbox_domain }}` | → Bastion EIP (HAProxy → OCP nodes :443)          |

**Route53 note:** The OPENTLC Open Environment provides a delegated hosted zone for
`{{ sandbox_domain }}`. We create records in that existing zone — no new zone needed.
Route53 records are created in Phase 1 (alongside EC2 provisioning) using the bastion EIP
from `infra_ec2`. The bastion EIP is the public entry point; HAProxy on the bastion
L4-forwards to private OCP nodes.

### 2.2 EC2 Instances

| Host               | Subnet  | Instance Type | Private IP     | Security Group(s)        | Root Vol | Additional Vol |
|--------------------|---------|---------------|----------------|--------------------------|----------|----------------|
| bastion            | Public  | t3.medium     | 10.0.1.10      | sg-bastion               | 50 GiB   | —              |
| services           | Private | t3.medium     | 10.0.2.10      | sg-services              | 50 GiB   | —              |
| registry           | Private | t3.large      | 10.0.2.20      | sg-registry              | 50 GiB   | 200 GiB (images)|
| kvm (optional)     | Private | m5.metal      | 10.0.2.30      | sg-kvm-host + sg-ocp-nodes | 200 GiB  | 500 GiB (VM images)|

**KVM host** (when `enable_kvm_host: true`, default): An m5.metal bare metal instance running
libvirt/KVM with 3 OCP node VMs using macvtap networking. OCP node IPs (10.0.2.100–102) and
VIPs (10.0.2.103–104) are assigned as secondary private IPs on the KVM host's ENI, and
source/destination check is disabled.
The host gets dual security groups: sg-kvm-host for host traffic (SSH, Redfish) and sg-ocp-nodes
for VM traffic. sushy-emulator provides a Redfish BMC API on port 8000, enabling the Agent-Based
Installer (ABI) to mount ISOs and power-cycle VMs as if they were real bare metal servers.

**OCP nodes (10.0.2.100–102)** are simulated as KVM VMs when the KVM host is enabled, or
provisioned by the OpenShift IPI installer when it is disabled. In both cases, the IPs are
pre-defined in `all.yml` so DNS records and HAProxy backends are ready.

**Registry host note:** The registry host is provisioned as infrastructure only (EC2 instance, security group,
DNS record, 200 GiB data volume). Registry software configuration is handled by a separate project
using Red Hat's `mirror-registry` binary and `oc mirror v2`.

**AMI:** RHEL 9 latest (`ami-xxxxxxxxx` — resolved at runtime via `amazon.aws.ec2_ami_info` filter on `owner: 309956199498`, `name: RHEL-9*`).

**Key Pair:** `disconnected-sandbox-key` — generated by `infra_ec2` role, private key written to `~/.ssh/disconnected-sandbox.pem`.

All instances tagged: `Project: disconnected-sandbox`, `Environment: sandbox`, `sandbox_role: <role>`.

### 2.3 Resource Dependency Graph

```
VPC
 ├── Internet Gateway
 ├── Public Subnet ──► Public Route Table (0.0.0.0/0 → IGW)
 │    └── Bastion EC2 ──► Elastic IP ──► Route53 A records
 │         └── sg-bastion
 ├── Private Subnet ──► Private Route Table (local only, NO default route)
 │    ├── Services EC2
 │    │    └── sg-services
 │    ├── Registry EC2
 │    │    └── sg-registry
 │    └── KVM EC2 (m5.metal, optional)
 │         ├── sg-kvm-host + sg-ocp-nodes (dual SG)
 │         ├── Secondary IPs: 10.0.2.{100,101,102,103,104} on ENI
 │         ├── Source/dest check disabled
 │         └── VMs: ocp-node-{0,1,2} via macvtap
 └── Security Groups (all reference VPC ID)
      ├── sg-ocp-nodes (for KVM VMs or IPI installer)
      └── sg-kvm-host (optional, when enable_kvm_host)
```

---

## 3. Security Group Matrix

All security groups are **stateful** — return traffic for allowed inbound rules is automatically permitted.

### 3.1 sg-bastion (Bastion Host + HAProxy Ingress + Local Repo)

| Direction | Protocol | Port(s)    | Source / Destination     | Purpose                           |
|-----------|----------|------------|--------------------------|-----------------------------------|
| Ingress   | TCP      | 22         | `{admin_cidr}`           | SSH from operator workstation     |
| Ingress   | TCP      | 443        | `0.0.0.0/0`              | HAProxy → OCP apps ingress        |
| Ingress   | TCP      | 6443       | `0.0.0.0/0`              | HAProxy → OCP Kubernetes API      |
| Ingress   | TCP      | 80         | `0.0.0.0/0`              | HAProxy → OCP HTTP redirect       |
| Ingress   | TCP      | 8080       | `10.0.2.0/24`            | Local yum repo for air-gapped hosts |
| Egress    | TCP      | 22         | `10.0.2.0/24`            | SSH to all private subnet hosts   |
| Egress    | TCP      | 443        | `0.0.0.0/0`              | HTTPS — download content/packages |
| Egress    | TCP      | 80         | `0.0.0.0/0`              | HTTP — download content/packages  |
| Egress    | TCP      | 6443       | `10.0.2.0/24`            | HAProxy backend → OCP API nodes   |
| Egress    | TCP      | 53         | `10.0.2.10/32`           | DNS queries to services host      |
| Egress    | UDP      | 53         | `10.0.2.10/32`           | DNS queries to services host      |
| Egress    | TCP      | 8443       | `10.0.2.20/32`           | Registry HTTPS — oc mirror push   |
| Egress    | TCP      | 8000       | `10.0.2.30/32`           | Redfish BMC on KVM host (when enabled) |

### 3.2 sg-services (DNS + NTP Host)

| Direction | Protocol | Port(s)    | Source / Destination     | Purpose                           |
|-----------|----------|------------|--------------------------|-----------------------------------|
| Ingress   | TCP      | 22         | `sg-bastion`             | SSH from bastion only             |
| Ingress   | TCP      | 53         | `10.0.0.0/16`            | DNS (TCP) from entire VPC         |
| Ingress   | UDP      | 53         | `10.0.0.0/16`            | DNS (UDP) from entire VPC         |
| Ingress   | UDP      | 123        | `10.0.2.0/24`            | NTP from private subnet hosts     |
| Egress    | ALL      | ALL        | `10.0.0.0/16`            | VPC-internal only (NO internet)   |

### 3.3 sg-registry (Mirror Registry Host)

| Direction | Protocol | Port(s)    | Source / Destination     | Purpose                           |
|-----------|----------|------------|--------------------------|-----------------------------------|
| Ingress   | TCP      | 22         | `sg-bastion`             | SSH from bastion only             |
| Ingress   | TCP      | 5000       | `10.0.2.0/24`            | Container registry (HTTP)         |
| Ingress   | TCP      | 8443       | `10.0.2.0/24`            | Container registry (HTTPS) from private subnet |
| Ingress   | TCP      | 8443       | `sg-bastion`             | Container registry (HTTPS) from bastion — oc mirror push |
| Egress    | TCP      | 53         | `10.0.2.10/32`           | DNS to services host              |
| Egress    | UDP      | 53         | `10.0.2.10/32`           | DNS to services host              |
| Egress    | UDP      | 123        | `10.0.2.10/32`           | NTP to services host              |
| Egress    | TCP      | 8080       | `10.0.1.10/32`           | Bastion local yum repo            |

### 3.4 sg-ocp-nodes (OpenShift 4 Compact Cluster — 3 Nodes)

This security group is pre-created for the IPI installer. No EC2 instances are assigned to it
by this repo — the installer assigns it to nodes it creates.

#### External-facing ingress (from VPC)

| Direction | Protocol | Port(s)       | Source / Destination     | Purpose                           |
|-----------|----------|---------------|--------------------------|-----------------------------------|
| Ingress   | TCP      | 22            | `sg-bastion`             | SSH from bastion only             |
| Ingress   | TCP      | 80            | `10.0.2.0/24`            | HTTP routes (HAProxy router)      |
| Ingress   | TCP      | 443           | `10.0.2.0/24`            | HTTPS routes (HAProxy router)     |
| Ingress   | TCP      | 6443          | `10.0.0.0/16`            | Kubernetes API server             |
| Ingress   | TCP      | 22623         | `10.0.2.0/24`            | Machine Config Server             |

#### Inter-node ingress (control plane + OVN-Kubernetes)

| Direction | Protocol | Port(s)       | Source / Destination     | Purpose                           |
|-----------|----------|---------------|--------------------------|-----------------------------------|
| Ingress   | TCP      | 2379–2380     | `sg-ocp-nodes`           | etcd server + peer                |
| Ingress   | TCP      | 9000–9999     | `sg-ocp-nodes`           | Host-level services (node-exporter, etc.) |
| Ingress   | TCP      | 10250         | `sg-ocp-nodes`           | Kubelet API                       |
| Ingress   | TCP      | 10257         | `sg-ocp-nodes`           | kube-controller-manager           |
| Ingress   | TCP      | 10259         | `sg-ocp-nodes`           | kube-scheduler                    |
| Ingress   | UDP      | 4789          | `sg-ocp-nodes`           | VXLAN (OVN-Kubernetes)            |
| Ingress   | UDP      | 6081          | `sg-ocp-nodes`           | Geneve (OVN-Kubernetes)           |
| Ingress   | UDP      | 500           | `sg-ocp-nodes`           | IPsec IKE (if enabled)            |
| Ingress   | UDP      | 4500          | `sg-ocp-nodes`           | IPsec NAT-T (if enabled)          |
| Ingress   | TCP      | 30000–32767   | `10.0.2.0/24`            | NodePort services                 |
| Ingress   | UDP      | 30000–32767   | `10.0.2.0/24`            | NodePort services                 |

#### Egress (VPC-internal only — NO internet)

| Direction | Protocol | Port(s)       | Source / Destination     | Purpose                           |
|-----------|----------|---------------|--------------------------|-----------------------------------|
| Egress    | TCP      | 53            | `10.0.2.10/32`           | DNS to services host              |
| Egress    | UDP      | 53            | `10.0.2.10/32`           | DNS to services host              |
| Egress    | UDP      | 123           | `10.0.2.10/32`           | NTP to services host              |
| Egress    | TCP      | 5000          | `10.0.2.20/32`           | Registry (HTTP)                   |
| Egress    | TCP      | 8443          | `10.0.2.20/32`           | Registry (HTTPS)                  |
| Egress    | TCP      | 8080          | `10.0.1.10/32`           | Bastion local yum repo            |
| Egress    | TCP      | 2379–2380     | `sg-ocp-nodes`           | etcd                              |
| Egress    | TCP      | 6443          | `sg-ocp-nodes`           | Kubernetes API                    |
| Egress    | TCP      | 10250         | `sg-ocp-nodes`           | Kubelet                           |
| Egress    | UDP      | 4789          | `sg-ocp-nodes`           | VXLAN                             |
| Egress    | UDP      | 6081          | `sg-ocp-nodes`           | Geneve                            |
| Egress    | TCP      | 9000–9999     | `sg-ocp-nodes`           | Host services                     |
| Egress    | TCP      | 22623         | `sg-ocp-nodes`           | Machine Config Server             |

### 3.5 sg-kvm-host (KVM Bare Metal Host — Optional)

Created when `enable_kvm_host: true`. The KVM host also gets `sg-ocp-nodes` assigned so VM traffic from macvtap passes through the OCP nodes rules.

| Direction | Protocol | Port(s)    | Source / Destination     | Purpose                           |
|-----------|----------|------------|--------------------------|-----------------------------------|
| Ingress   | TCP      | 22         | `sg-bastion`             | SSH from bastion only             |
| Ingress   | TCP      | 8000       | `sg-bastion`             | Redfish BMC API from bastion      |
| Egress    | TCP      | 53         | `10.0.2.10/32`           | DNS to services host              |
| Egress    | UDP      | 53         | `10.0.2.10/32`           | DNS to services host              |
| Egress    | UDP      | 123        | `10.0.2.10/32`           | NTP to services host              |
| Egress    | TCP      | 8080       | `10.0.1.10/32`           | Bastion local yum repo            |
| Egress    | TCP      | 8443       | `10.0.2.20/32`           | Registry HTTPS                    |

### 3.6 Security Group Cross-Reference Diagram

```
  Route53: api.ocp.{domain}    ──┐
  Route53: *.apps.ocp.{domain} ──┤
                                  ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │                    VPC 10.0.0.0/16                      │
  INTERNET       │                                                         │
  ────────►IGW───┤  ┌──────────── Public Subnet 10.0.1.0/24 ──────────┐   │
  admin_cidr:22  │  │                                                   │   │
  :443/:6443/:80 │  │  BASTION (sg-bastion) + HAProxy + yum repo :8080  │   │
  ◄──────────────│──│──► 10.0.1.10 + EIP                                │   │
                 │  │      │  SSH:22 (ProxyCommand)                     │   │
                 │  │      │  :6443 → OCP nodes (API)                   │   │
                 │  │      │  :443  → OCP nodes (apps)                  │   │
                 │  └──────│────────────────────────────────────────────┘   │
                 │         │
                 │  ┌──────▼──── Private Subnet 10.0.2.0/24 ──────────┐   │
                 │  │                                                   │   │
                 │  │  SERVICES (sg-services)   ◄── DNS:53/NTP:123 ──┐ │   │
                 │  │    10.0.2.10                                    │ │   │
                 │  │                                                  │ │   │
                 │  │  REGISTRY (sg-registry)   ──► 5000/8443         │ │   │
                 │  │    10.0.2.20                                    │ │   │
                 │  │                                                  │ │   │
                 │  │  KVM HOST (sg-kvm-host + sg-ocp-nodes) [optional]│ │   │
                 │  │    10.0.2.30 (m5.metal)                        │ │   │
                 │  │    ├── ocp-node-0 VM (10.0.2.100, macvtap)     │ │   │
                 │  │    ├── ocp-node-1 VM (10.0.2.101, macvtap)     │ │   │
                 │  │    └── ocp-node-2 VM (10.0.2.102, macvtap)     │ │   │
                 │  │    sushy-emulator :8000 (Redfish BMC) ─────────┘ │   │
                 │  │                                                   │   │
                 │  │  *** NO route to IGW — NO NAT Gateway ***         │   │
                 │  └───────────────────────────────────────────────────┘   │
                 └─────────────────────────────────────────────────────────┘
```

---

## 4. Execution Workflow Strategy

### 4.1 Prerequisites (Operator Workstation)

- Ansible >= 2.15, Python >= 3.9
- `amazon.aws` collection >= 7.0.0
- `community.crypto` collection (available for TLS operations if needed)
- AWS credentials exported as env vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- OPENTLC Open Environment provisioned (provides Route53 domain + credentials)
- Operator's public IP known (`admin_cidr` variable)

### 4.2 Phase 1 — Provision AWS Infrastructure

**Runs on:** `localhost` (operator workstation)
**Connection:** `local` (AWS API calls via boto3)
**Playbook:** `playbooks/phase1_provision.yml`

```
Step 1.1: infra_vpc role
  ├── Create VPC (10.0.0.0/16)
  ├── Create Internet Gateway, attach to VPC
  ├── Create Public Subnet (10.0.1.0/24)
  ├── Create Private Subnet (10.0.2.0/24)
  ├── Create Public Route Table (0.0.0.0/0 → IGW), associate
  └── Create Private Route Table (local only), associate
      └── VALIDATION: Assert private RT has NO 0.0.0.0/0 route

Step 1.2: infra_security_groups role
  ├── Create sg-bastion (rules per §3.1, includes Redfish egress when KVM enabled)
  ├── Create sg-services (rules per §3.2)
  ├── Create sg-registry (rules per §3.3)
  ├── Create sg-kvm-host (rules per §3.5) — when enable_kvm_host
  └── Create sg-ocp-nodes (rules per §3.4) — for KVM VMs or IPI installer
      └── VALIDATION: Assert sg-ocp-nodes egress has NO 0.0.0.0/0 rule

Step 1.3: infra_ec2 role
  ├── Resolve latest RHEL 9 AMI ID via ec2_ami_info
  ├── Create/import EC2 key pair
  ├── Launch bastion (public subnet, static private IP 10.0.1.10)
  ├── Allocate Elastic IP, associate with bastion
  ├── Launch services host (private subnet, 10.0.2.10)
  ├── Launch registry host (private subnet, 10.0.2.20, +200GiB EBS)
  ├── (When KVM enabled) Launch KVM host (m5.metal, 10.0.2.30, +500GiB EBS)
  │     ├── Assign secondary IPs (10.0.2.100–104: 3 nodes + 2 VIPs) on ENI
  │     └── Disable source/destination check on ENI
  └── Wait for all instances to reach "running" state

Step 1.4: infra_ssh_config role
  ├── Write SSH private key to ~/.ssh/disconnected-sandbox.pem (mode 0600)
  ├── Generate SSH config block with ProxyCommand for all private hosts
  └── Register dynamic inventory refresh

Step 1.5: infra_route53 role
  ├── Look up existing hosted zone for {{ sandbox_domain }}
  ├── Create A record: api.ocp.{{ sandbox_domain }} → {{ bastion_eip }}
  ├── Create A record: *.apps.ocp.{{ sandbox_domain }} → {{ bastion_eip }}
  └── Uses infra_ec2_bastion_eip set_fact from Step 1.3
```

**Generated SSH Config (`~/.ssh/config.d/disconnected-sandbox`):**

```
Host bastion-sandbox
    HostName <bastion_eip>
    User ec2-user
    IdentityFile ~/.ssh/disconnected-sandbox.pem
    StrictHostKeyChecking accept-new

Host services-sandbox
    HostName 10.0.2.10
    User ec2-user
    IdentityFile ~/.ssh/disconnected-sandbox.pem
    ProxyCommand ssh -W %h:%p bastion-sandbox
    StrictHostKeyChecking accept-new

Host registry-sandbox
    HostName 10.0.2.20
    User ec2-user
    IdentityFile ~/.ssh/disconnected-sandbox.pem
    ProxyCommand ssh -W %h:%p bastion-sandbox
    StrictHostKeyChecking accept-new

# When enable_kvm_host is true:
Host kvm-sandbox
    HostName 10.0.2.30
    User ec2-user
    IdentityFile ~/.ssh/disconnected-sandbox.pem
    ProxyCommand ssh -W %h:%p bastion-sandbox
    StrictHostKeyChecking accept-new
```

### 4.3 Phase 2 — Configure RHEL 9 Services

**Runs on:** Remote hosts (via SSH through bastion ProxyCommand)
**Connection:** `ssh` with `ansible_ssh_common_args` for ProxyCommand
**Playbook:** `playbooks/phase2_configure.yml`
**Inventory:** `inventory/aws_ec2.yml` (dynamic, tag-based grouping)

```
Step 2.0: bastion_repo role (bastion)
  ├── Install httpd, createrepo, yum-utils on bastion (has internet)
  ├── Download all RPMs + dependencies for private hosts:
  │     openscap-scanner, scap-security-guide, libxslt, bind, bind-utils,
  │     chrony, tmux, tcpdump, nmap-ncat
  ├── Run createrepo to build yum repo metadata
  ├── Restore SELinux contexts on repo directory
  ├── Disable httpd default Listen 80 (conflicts with HAProxy)
  ├── Configure httpd VirtualHost on port 8080 → /var/www/html/repos/
  ├── Configure SELinux for custom port
  └── Start httpd — repo available at http://10.0.1.10:8080/rhel9-local/

Step 2.0.1: Disable RHUI + configure bastion repo (services, registry, kvm)
  ├── dnf config-manager --disable '*rhui*'
  └── Add yum_repository: bastion-local → http://10.0.1.10:8080/rhel9-local
      NOTE: Private hosts have no internet. RHUI repos fail immediately and
            must be disabled before any dnf operations.

Step 2.1: rhel_hardening role — FIPS pass (bastion, then private hosts)
  ├── fips-mode-setup --enable
  ├── Reboot (Ansible waits for SSH reconnection)
  ├── Verify: fips-mode-setup --check → "FIPS mode is enabled"
  └── Verify: /proc/sys/crypto/fips_enabled == 1
      NOTE: FIPS is applied BEFORE service configuration so all
            crypto operations (TLS certs, SSH, DNS) use FIPS-approved algorithms.

Step 2.2: bind_dns role (services host)
  ├── Install bind, bind-utils via dnf (from bastion-local repo)
  ├── Generate /etc/named.conf from template
  │     ├── listen-on: 10.0.2.10
  │     ├── allow-query: 10.0.0.0/16
  │     ├── forwarders: (none — authoritative only, air-gapped)
  │     └── recursion: no
  ├── Generate forward zone: ocp.{{ sandbox_domain }}
  │     ├── api.ocp.{{ sandbox_domain }}      → 10.0.2.103 (API VIP)
  │     ├── api-int.ocp.{{ sandbox_domain }}  → 10.0.2.103 (API VIP)
  │     ├── *.apps.ocp.{{ sandbox_domain }}   → 10.0.2.104 (Ingress VIP)
  │     ├── services.ocp.{{ sandbox_domain }} → 10.0.2.10
  │     ├── registry.ocp.{{ sandbox_domain }} → 10.0.2.20
  │     ├── bastion.ocp.{{ sandbox_domain }}  → 10.0.1.10
  │     ├── kvm.ocp.{{ sandbox_domain }}      → 10.0.2.30
  │     ├── node-0.ocp.{{ sandbox_domain }}   → 10.0.2.100
  │     ├── node-1.ocp.{{ sandbox_domain }}   → 10.0.2.101
  │     └── node-2.ocp.{{ sandbox_domain }}   → 10.0.2.102
  ├── Generate reverse zone: 2.0.10.in-addr.arpa
  ├── Enable and start named.service
  └── VALIDATION: dig @10.0.2.10 api.ocp.{{ sandbox_domain }} (from bastion)

Step 2.3: chrony_ntp role (services host)
  ├── Configure /etc/chrony.conf
  │     ├── local stratum 10 (orphan mode — no upstream, air-gapped)
  │     ├── allow 10.0.2.0/24
  │     └── driftfile /var/lib/chrony/drift
  ├── Enable and start chronyd.service
  └── VALIDATION: chronyc sources (from services host)

Step 2.4: common_client role (services, registry, kvm)
  ├── Set resolv.conf nameserver to 10.0.2.10
  ├── Configure chrony client to NTP server 10.0.2.10
  └── VALIDATION: dig, chronyc tracking from each host

NOTE: The registry host (10.0.2.20) is provisioned as infrastructure only.
      Registry configuration (mirror-registry binary + oc mirror v2) is handled
      by a separate project. The host, DNS record, security group, and 200 GiB
      data volume are ready for that project to consume.

Step 2.5: bastion_haproxy role (bastion)
  ├── Install haproxy via dnf (bastion has internet)
  ├── Generate /etc/haproxy/haproxy.cfg from template
  │     ├── frontend api :6443 → backend ocp-api (TCP mode)
  │     ├── frontend apps :443 → backend ocp-apps (TCP mode)
  │     ├── frontend apps-http :80 → backend ocp-apps-http (TCP mode)
  │     └── stats socket for monitoring
  ├── Configure SELinux for HAProxy port bindings
  ├── Enable and start haproxy.service
  └── VALIDATION: curl -k https://api.ocp.{{ sandbox_domain }}:6443/version
      (expect connection refused until OCP is installed)

Step 2.6: kvm_host role (kvm host) — when enable_kvm_host
  ├── Install qemu-kvm, libvirt, virt-install from bastion-local repo
  ├── Format /dev/nvme1n1 as XFS, mount at /var/lib/libvirt/images
  ├── Enable and start libvirtd
  ├── Destroy default NAT network (macvtap replaces it)
  ├── Create qcow2 disk images (120 GiB each, 3 VMs)
  ├── Define VM domains from XML template:
  │     ├── ocp-node-{0,1,2}: 16 vCPU, 64 GiB RAM each
  │     ├── Network: macvtap on ens5 (bridge mode — VMs on private subnet)
  │     ├── Disk: virtio, qcow2
  │     ├── CDROM: empty (ISO mounted via Redfish)
  │     └── CPU: host-passthrough
  └── VMs are defined but NOT started (ABI will power them on)

Step 2.7: redfish_bmc role (kvm host) — when enable_kvm_host
  ├── Install python3-pip from bastion-local repo
  ├── Install sushy-tools from pip wheels (offline):
  │     pip install --no-index --find-links http://10.0.1.10:8080/pip-wheels sushy-tools
  ├── Deploy /etc/sushy/sushy-emulator.conf (libvirt URI, listen IP/port)
  ├── Deploy systemd unit: sushy-emulator.service
  ├── Enable and start sushy-emulator
  └── VALIDATION: Redfish API responds at http://10.0.2.30:8000/redfish/v1/Systems/
      (lists 3 VM UUIDs)

      NOTE: When KVM is enabled, bastion_repo (Step 2.0) also downloads KVM
            packages (qemu-kvm, libvirt, etc.) and pip wheels for sushy-tools
            so they are available offline to the KVM host.

Step 2.8: rhel_hardening role — STIG pass (private hosts FIRST, then bastion)
  ├── Install openscap-scanner, scap-security-guide
  │     Private hosts: from bastion local repo
  │     Bastion: direct dnf install
  ├── Apply STIG remediation + restore sudo NOPASSWD in single shell command:
  │     oscap xccdf eval --remediate ... ; echo 'ec2-user ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/99-ansible-user
  ├── oscap exit code 2 is expected (some controls need manual remediation)
  └── Report: /var/log/openscap/stig-remediation.html

      ORDERING NOTE: Private hosts STIG before bastion. STIG's httpd
      remediation can break the bastion repo — running private hosts first
      ensures they can still download openscap packages from the repo.

      SUDO NOTE: STIG's sudo_remove_nopasswd control removes ALL NOPASSWD
      entries including from /etc/sudoers.d/. The remediation and sudo
      restoration must run in a single shell command (as root) to prevent
      Ansible lockout.
```

### 4.4 Ansible Connection Model

```
┌──────────────┐     SSH:22      ┌──────────┐   SSH:22 (tunnel)   ┌─────────────┐
│   Operator   │ ──────────────► │ Bastion  │ ──────────────────► │ Private     │
│  Workstation │  (EIP, direct)  │ 10.0.1.10│  (ProxyCommand)     │ Hosts       │
│              │                 │          │                      │ 10.0.2.x    │
└──────────────┘                 └──────────┘                      └─────────────┘

ansible.cfg:
  [ssh_connection]
  ssh_args = -o ControlMaster=auto -o ControlPersist=60s
  pipelining = true

  [defaults]
  host_key_checking = false

group_vars/private_hosts.yml:
  ansible_ssh_common_args: >-
    -o ProxyCommand="ssh -W %h:%p -i {{ ssh_key_path }}
    ec2-user@{{ hostvars[groups['role_bastion'][0]].ansible_host }}"

group_vars/all.yml:
  ansible_user: ec2-user
  ansible_ssh_private_key_file: {{ ssh_key_path }}
```

The bastion group overrides `ansible_ssh_common_args` to empty (direct connection).
The `private_hosts` group is auto-populated by the dynamic inventory for all non-bastion hosts.

### 4.5 Dynamic Inventory Configuration

**`inventory/aws_ec2.yml`:**
```yaml
plugin: amazon.aws.aws_ec2
regions:
  - "{{ lookup('env', 'AWS_REGION') | default('us-east-2', true) }}"
filters:
  tag:Project: disconnected-sandbox
  instance-state-name: running
hostvars_prefix: aws_
keyed_groups:
  - key: aws_tags.sandbox_role
    prefix: role
    separator: "_"
groups:
  private_hosts: aws_tags.sandbox_role != 'bastion'
hostnames:
  - private-ip-address
compose:
  ansible_host: aws_public_ip_address | default(aws_private_ip_address)
```

This produces groups: `role_bastion`, `role_services`, `role_registry`, `role_kvm` (when KVM enabled), `private_hosts`.

Key details:
- `hostvars_prefix: aws_` prevents collision with Ansible's reserved `tags` variable
- `private_hosts` group auto-applies ProxyCommand SSH args via `group_vars/private_hosts.yml`
- `compose.ansible_host` uses public IP for bastion (EIP), private IP for everyone else
- Hostnames use private IP addresses as the inventory hostname

### 4.6 Teardown Strategy

**Playbook:** `playbooks/teardown.yml`

Reverse-order destruction, all filtered by `tag:Project=disconnected-sandbox`:

1. Terminate all EC2 instances (wait for termination)
2. Release Elastic IP
3. Delete key pair
4. Remove Route53 A records (api.ocp.*, *.apps.ocp.*)
5. Delete security groups (must be after instance termination)
6. Delete subnets
7. Detach and delete Internet Gateway
8. Delete route tables (non-main)
9. Delete VPC
10. Remove local SSH key and config files

All resources are discovered by tag, making teardown idempotent and safe
against partial provisioning failures. Lingering ENIs from recently terminated
instances can cause `DependencyViolation` errors on VPC deletion — re-running
teardown after a brief wait resolves this.

---

## 5. Variable Hierarchy

```
inventory/group_vars/all.yml          # Lowest precedence — global defaults
  │
  │ REQUIRED (no defaults — must be provided at runtime):
  ├── aws_region: (none)              # e.g., us-east-2
  ├── sandbox_domain: (none)          # e.g., sandbox2229.opentlc.com
  ├── admin_cidr: (none)              # e.g., 203.0.113.42/32
  │
  │ NETWORKING:
  ├── vpc_cidr: 10.0.0.0/16
  ├── public_subnet_cidr: 10.0.1.0/24
  ├── private_subnet_cidr: 10.0.2.0/24
  │
  │ DOMAIN:
  ├── cluster_name: ocp              # subdomain prefix → ocp.{{ sandbox_domain }}
  ├── cluster_domain: {{ cluster_name }}.{{ sandbox_domain }}  # derived
  │
  │ TAGGING & SSH:
  ├── project_tag: disconnected-sandbox
  ├── ssh_key_name: {{ project_tag }}-key
  ├── ssh_key_path: ~/.ssh/{{ project_tag }}.pem
  ├── ansible_user: ec2-user
  ├── ansible_ssh_private_key_file: {{ ssh_key_path }}
  │
  │ STATIC PRIVATE IPs:
  ├── bastion_private_ip: 10.0.1.10
  ├── services_private_ip: 10.0.2.10
  ├── registry_private_ip: 10.0.2.20
  ├── ocp_node_ips: [10.0.2.100, 10.0.2.101, 10.0.2.102]  # for DNS + HAProxy
  ├── api_vip: 10.0.2.103                 # keepalived API VIP (BIND9 api/api-int)
  ├── ingress_vip: 10.0.2.104             # keepalived Ingress VIP (BIND9 *.apps)
  │
  │ INSTANCE TYPES & VOLUMES (here, not per-group, because Phase 1 runs
  │ on localhost which does not load per-group group_vars):
  ├── bastion_instance_type: t3.medium
  ├── bastion_root_volume_size: 50
  ├── services_instance_type: t3.medium
  ├── services_root_volume_size: 50
  ├── registry_instance_type: t3.large
  ├── registry_root_volume_size: 50
  ├── registry_data_volume_size: 200
  ├── registry_port: 8443
  ├── bastion_repo_port: 8080
  │
  │ KVM BARE METAL SIMULATION (optional):
  ├── enable_kvm_host: true               # Toggle KVM host provisioning
  ├── kvm_private_ip: 10.0.2.30
  ├── kvm_instance_type: m5.metal
  ├── kvm_root_volume_size: 200
  ├── kvm_data_volume_size: 500
  ├── kvm_vm_vcpu: 16                     # Per VM
  ├── kvm_vm_memory_mb: 65536             # Per VM (64 GiB)
  ├── kvm_vm_disk_gb: 120                 # Per VM
  ├── redfish_port: 8000
  │
  │ HARDENING:
  ├── rhel_hardening_enable_fips: true
  ├── rhel_hardening_apply_stig: true
  └── rhel_hardening_stig_profile: xccdf_org.ssgproject.content_profile_stig

inventory/group_vars/bastion.yml
  └── ansible_ssh_common_args: ""     # Direct connection (no ProxyCommand)

inventory/group_vars/private_hosts.yml
  └── ansible_ssh_common_args: >-     # ProxyCommand through bastion
        -o ProxyCommand="ssh -W %h:%p -i {{ ssh_key_path }}
        ec2-user@{{ hostvars[groups['role_bastion'][0]].ansible_host }}"

inventory/group_vars/services.yml
  └── ntp_allow_subnet: 10.0.2.0/24

inventory/group_vars/registry.yml
  └── (infrastructure-only marker — no vars beyond all.yml)
```

---

## 6. Risk Register & Design Trade-offs

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| Static private IPs | Less flexible than DHCP | Required for DNS zone files and SG rules to use specific IPs; OCP needs stable IPs for etcd |
| Bastion as content relay | Bastion does double duty | Avoids VPC endpoints or NAT; faithful simulation of air-gap sneakernet model |
| Registry host provisioned, not configured | Requires separate project to set up mirror-registry | Clean separation of concerns; infrastructure is reusable across registry implementations |
| OCP nodes deferred to IPI | SG + DNS pre-provisioned but no instances | IPI handles node lifecycle; pre-creating nodes would conflict with installer |
| Single AZ | No HA | Sandbox/lab scope; keeps costs and complexity down |
| Local stratum 10 chrony | Time drift over days | Air-gapped; no upstream NTP. Acceptable for sandbox lifespan |
| Bastion httpd repo (:8080) | Extra SG ingress on bastion | More scalable than SCP per-host; realistic pattern for disconnected environments |
| HAProxy on bastion | Bastion is ingress + jump host | Only public-subnet host; alternative is NLB ($$) or SSH tunnels (fragile) |
| Route53 records → bastion EIP | External DNS bypasses internal BIND9 | Split-horizon: external clients hit bastion HAProxy, internal clients hit OCP directly |
| Route53 in Phase 1 | Tighter coupling to infra_ec2 | Avoids cross-play variable passing; set_fact values persist within the same play |
| FIPS before services | Requires reboot early in Phase 2 | All crypto must be FIPS from the start; SSH reconnection via `ansible.builtin.reboot` is reliable |
| STIG after services | Some controls may conflict with configs | Applying STIG first would break service setup; post-service STIG is standard for hardened labs |
| STIG private hosts first | Ordering constraint on Phase 2 | STIG can break bastion httpd; private hosts must finish while repo is available |
| STIG + sudo in one shell | Combines remediation with sudo restore | STIG removes NOPASSWD from sudoers.d/; must restore in same command to avoid Ansible lockout |
| STIG exit code 2 expected | Not 100% compliant | Some STIG controls require manual steps or are N/A in cloud; compliance report is generated for audit |
| RHUI disable on private hosts | Extra play in Phase 2 | Private hosts have no internet; RHUI repos cause dnf timeouts and must be disabled first |
| Instance types in all.yml | Against role-prefix lint convention | Phase 1 runs on localhost which doesn't load per-group group_vars; all.yml is the only option |
| m5.metal for KVM | ~$4.60/hr cost | Required for nested virtualization (bare metal access); only EC2 type with real hardware KVM |
| macvtap bridge mode | No VM-to-host communication | VMs appear as real hosts on the subnet; KVM host communicates via Redfish only, not SSH to VMs |
| Dual SG on KVM host | Complexity | sg-kvm-host for host traffic (SSH, Redfish), sg-ocp-nodes for VM traffic — avoids duplicating all OCP SG rules |
| Secondary IPs on ENI | Manual IP assignment | AWS routes traffic to ENI owner; macvtap VMs need the IPs registered on the ENI |
| Source/dest check disabled | Less AWS network filtering | Required for macvtap — the ENI forwards traffic to/from VMs with different MAC addresses |
| sushy-tools pip wheels | Extra bastion repo step | Air-gapped pip install; bastion downloads wheels while it has internet, KVM host installs offline |
| KVM host optional | Feature toggle complexity | `enable_kvm_host` (default true); when false, all KVM resources skip and role_kvm group is empty |

---

## 7. Ingress Architecture (Bastion HAProxy + Route53)

The private subnet is air-gapped, but operators and end users need to reach the OpenShift
Console and API from the internet. The bastion bridges this gap as an L4 reverse proxy.

### 7.1 Traffic Flow

```
  Browser / oc CLI
       │
       ▼
  Route53: api.ocp.sandbox2229.opentlc.com → Bastion EIP
  Route53: *.apps.ocp.sandbox2229.opentlc.com → Bastion EIP
       │
       ▼
  ┌─────────────────────────────────────┐
  │ BASTION (Public Subnet)             │
  │                                     │
  │  HAProxy (TCP mode, L4)             │
  │  ├── *:6443 → backend api           │
  │  │     server api-vip 10.0.2.103    │
  │  ├── *:443  → backend apps          │
  │  │     server ingress-vip 10.0.2.104│
  │  └── *:80   → backend apps-http     │
  │        server ingress-vip 10.0.2.104│
  └──────────────────┬──────────────────┘
                     │ VPC local route (10.0.0.0/16)
                     ▼
  ┌─────────────────────────────────────┐
  │ OCP NODES (Private Subnet, KVM VMs)  │
  │  10.0.2.{100,101,102}               │
  │  API VIP: 10.0.2.103 (keepalived)   │
  │  Ingress VIP: 10.0.2.104 (keepalvd) │
  │  *** Still NO internet access ***   │
  └─────────────────────────────────────┘
```

### 7.2 Split-Horizon DNS

Two DNS views serve the same names with different targets:

| Record                                  | External (Route53)   | Internal (BIND9)          |
|-----------------------------------------|----------------------|---------------------------|
| `api.ocp.{{ sandbox_domain }}`          | → Bastion EIP        | → 10.0.2.103 (API VIP)    |
| `api-int.ocp.{{ sandbox_domain }}`      | (not published)      | → 10.0.2.103 (API VIP)    |
| `*.apps.ocp.{{ sandbox_domain }}`       | → Bastion EIP        | → 10.0.2.104 (Ingress VIP)|
| `registry.ocp.{{ sandbox_domain }}`     | (not published)      | → 10.0.2.20               |

External clients (browser, `oc` CLI) resolve via Route53 → bastion EIP → HAProxy → OCP nodes
(round-robin across all 3 nodes). Internal clients (OCP nodes, pods) resolve via BIND9 →
keepalived VIPs, which float between nodes for HA failover. The VIPs are separate IPs not
assigned to any specific node — OpenShift's keepalived manages them across the control plane.
Both VIPs are registered as secondary IPs on the KVM host ENI so AWS routes the traffic.

### 7.3 Why HAProxy in TCP Mode

- **No TLS termination on bastion** — HAProxy passes encrypted traffic through. The bastion
  never sees OCP API tokens or console session cookies. TLS terminates on the OCP nodes.
- **Preserves OCP certificate validation** — `oc login` validates the OCP-generated API cert,
  which is issued for `api.ocp.{{ sandbox_domain }}`. TCP passthrough means the cert matches.
- **Simple configuration** — no cert management on the bastion for OCP traffic.

### 7.4 Air-Gap Integrity

The HAProxy ingress does NOT break the air-gap:
- OCP nodes still have zero outbound internet routes (private RT unchanged)
- HAProxy forwards **inbound** traffic only — it initiates connections to private IPs
- The bastion is the only host with an internet-facing interface
- No new routes, NAT, or VPC endpoints are added to the private subnet

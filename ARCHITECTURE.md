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
│   │   ├── all.yml                         # Global: VPC CIDR, domain, region, AMI IDs, SSH key
│   │   ├── bastion.yml                     # Bastion instance type, EIP toggle
│   │   ├── services.yml                    # DNS zones, NTP config, package list
│   │   ├── registry.yml                    # Registry host instance config (not configured — see mirror-registry project)
│   │   └── ocp_nodes.yml                   # Instance type, count, disk layout
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
│   ├── infra_ec2/                          # EC2 instances + EIP for bastion
│   │   ├── tasks/main.yml
│   │   ├── tasks/bastion.yml
│   │   ├── tasks/private_hosts.yml
│   │   ├── defaults/main.yml
│   │   └── meta/main.yml
│   │
│   ├── infra_route53/                      # Route53 A records in OPENTLC-delegated zone
│   │   ├── tasks/main.yml
│   │   ├── defaults/main.yml
│   │   └── meta/main.yml
│   │
│   ├── infra_ssh_config/                   # Generate ~/.ssh/config stanza + ProxyCommand
│   │   ├── tasks/main.yml
│   │   ├── templates/ssh_config.j2
│   │   └── defaults/main.yml
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
│   │   ├── tasks/stig.yml                  # OpenSCAP STIG remediation + compliance report
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
│   │   ├── templates/chrony.conf.j2
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
│   └── ocp_node_prep/                      # OCP node prerequisites
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
and eliminates custom code. Instances are tagged with `sandbox_role: bastion|services|registry|ocp_node`
and the plugin auto-populates groups. A custom inventory plugin adds maintenance burden with no benefit here.

**Why separate `infra_*` roles instead of one monolith:**
Each infrastructure role maps to a distinct AWS resource lifecycle. `infra_vpc` must complete
before `infra_security_groups` (SGs reference VPC ID), which must complete before `infra_ec2`
(instances reference SG IDs). Separation makes teardown ordering trivial and enables selective reprovisioning.

**Why `common_client` role:**
Every private host (services, registry, ocp_nodes) needs identical DNS resolver and NTP client
configuration. Factoring this out prevents drift and deduplicates three identical task lists.

**Package installation strategy (air-gap):**
Private subnet hosts have zero internet access. The `scripts/download_rpms.sh` script runs on an
internet-connected machine (or bastion) to pre-fetch RPMs into `files/rpms/`. During Phase 2,
Ansible transfers RPMs via SCP over the bastion ProxyCommand tunnel and installs locally with `dnf localinstall`.

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
The bastion EIP is the public entry point; HAProxy on the bastion L4-forwards to private OCP nodes.

### 2.2 EC2 Instances

| Host               | Subnet  | Instance Type | Private IP     | Security Group  | Root Vol | Additional Vol |
|--------------------|---------|---------------|----------------|-----------------|----------|----------------|
| bastion            | Public  | t3.medium     | 10.0.1.10      | sg-bastion      | 50 GiB   | —              |
| services           | Private | t3.medium     | 10.0.2.10      | sg-services     | 50 GiB   | —              |
| registry           | Private | t3.large      | 10.0.2.20      | sg-registry     | 50 GiB   | 200 GiB (images)|
| ocp-node-0         | Private | m5.2xlarge    | 10.0.2.100     | sg-ocp-nodes    | 120 GiB  | —              |
| ocp-node-1         | Private | m5.2xlarge    | 10.0.2.101     | sg-ocp-nodes    | 120 GiB  | —              |
| ocp-node-2         | Private | m5.2xlarge    | 10.0.2.102     | sg-ocp-nodes    | 120 GiB  | —              |

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
 │    └── Bastion EC2 ──► Elastic IP
 │         └── sg-bastion
 ├── Private Subnet ──► Private Route Table (local only, NO default route)
 │    ├── Services EC2
 │    │    └── sg-services
 │    ├── Registry EC2
 │    │    └── sg-registry
 │    └── OCP Nodes EC2 (×3)
 │         └── sg-ocp-nodes
 └── Security Groups (all reference VPC ID)
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

### 3.5 Security Group Cross-Reference Diagram

```
  Route53: api.ocp.{domain}    ──┐
  Route53: *.apps.ocp.{domain} ──┤
                                  ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │                    VPC 10.0.0.0/16                      │
  INTERNET       │                                                         │
  ────────►IGW───┤  ┌──────────── Public Subnet 10.0.1.0/24 ──────────┐   │
  admin_cidr:22  │  │                                                   │   │
  :443/:6443/:80 │  │  BASTION (sg-bastion) + HAProxy                   │   │
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
                 │  │  REGISTRY (sg-registry)   ──► 5000/8443 ──────┐│ │   │
                 │  │    10.0.2.20                                   ││ │   │
                 │  │                                                 ││ │   │
                 │  │  OCP-NODE-0 (sg-ocp-nodes) ◄──────────────────┘│ │   │
                 │  │    10.0.2.100  ◄──► etcd/VXLAN/Geneve ──►      │ │   │
                 │  │  OCP-NODE-1 (sg-ocp-nodes)    (inter-node)     │ │   │
                 │  │    10.0.2.101  ◄──► ──────────────────────►    │ │   │
                 │  │  OCP-NODE-2 (sg-ocp-nodes)                     │ │   │
                 │  │    10.0.2.102  ──► DNS/NTP ────────────────────┘ │   │
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
  ├── Create sg-bastion (rules per §3.1)
  ├── Create sg-services (rules per §3.2)
  ├── Create sg-registry (rules per §3.3)
  └── Create sg-ocp-nodes (rules per §3.4)
      └── VALIDATION: Assert sg-ocp-nodes egress has NO 0.0.0.0/0 rule

Step 1.3: infra_ec2 role
  ├── Resolve latest RHEL 9 AMI ID via ec2_ami_info
  ├── Create/import EC2 key pair
  ├── Launch bastion (public subnet, static private IP 10.0.1.10)
  ├── Allocate Elastic IP, associate with bastion
  ├── Launch services host (private subnet, 10.0.2.10)
  ├── Launch registry host (private subnet, 10.0.2.20, +200GiB EBS)
  ├── Launch ocp-node-{0,1,2} (private subnet, 10.0.2.{100,101,102})
  └── Wait for all instances to reach "running" state

Step 1.4: infra_ssh_config role
  ├── Write SSH private key to ~/.ssh/disconnected-sandbox.pem (mode 0600)
  ├── Generate SSH config block with ProxyCommand for all private hosts
  └── Register dynamic inventory refresh
```

**Generated SSH Config (`~/.ssh/config.d/disconnected-sandbox` or appended):**

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

Host ocp-node-*-sandbox
    HostName <resolved_from_tag>
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
  │     openscap-scanner, scap-security-guide, bind, bind-utils,
  │     haproxy, tmux, tcpdump, nmap-ncat
  ├── Run createrepo to build yum repo metadata
  ├── Configure httpd on port 8080 → /var/www/html/repos/
  ├── Configure SELinux for custom port
  └── Start httpd — repo available at http://10.0.1.10:8080/rhel9-local/

Step 2.1: rhel_hardening role — FIPS pass (ALL hosts)
  ├── fips-mode-setup --enable
  ├── Reboot all hosts (Ansible waits for SSH reconnection)
  ├── Verify: fips-mode-setup --check → "FIPS mode is enabled"
  └── Verify: /proc/sys/crypto/fips_enabled == 1
      NOTE: FIPS is applied BEFORE service configuration so all
            crypto operations (TLS certs, SSH, DNS) use FIPS-approved algorithms.

Step 2.2: bind_dns role (services host)
  ├── Add bastion local repo (/etc/yum.repos.d/bastion-local.repo)
  │     baseurl=http://10.0.1.10:8080/rhel9-local/
  ├── Transfer bind RPMs from bastion staging
  ├── Install bind, bind-utils via dnf localinstall
  ├── Generate /etc/named.conf from template
  │     ├── listen-on: 10.0.2.10
  │     ├── allow-query: 10.0.0.0/16
  │     ├── forwarders: (none — authoritative only, air-gapped)
  │     └── recursion: no
  ├── Generate forward zone: ocp.{{ sandbox_domain }}
  │     ├── api.ocp.{{ sandbox_domain }}      → 10.0.2.100 (VIP or first node)
  │     ├── api-int.ocp.{{ sandbox_domain }}  → 10.0.2.100
  │     ├── *.apps.ocp.{{ sandbox_domain }}   → 10.0.2.100 (wildcard A record)
  │     ├── services.ocp.{{ sandbox_domain }} → 10.0.2.10
  │     ├── registry.ocp.{{ sandbox_domain }} → 10.0.2.20
  │     ├── bastion.ocp.{{ sandbox_domain }}  → 10.0.1.10
  │     ├── node-0.ocp.{{ sandbox_domain }}   → 10.0.2.100
  │     ├── node-1.ocp.{{ sandbox_domain }}   → 10.0.2.101
  │     └── node-2.ocp.{{ sandbox_domain }}   → 10.0.2.102
  ├── Generate reverse zone: 2.0.10.in-addr.arpa
  ├── Enable and start named.service
  └── VALIDATION: dig @10.0.2.10 api.ocp.{{ sandbox_domain }} (from bastion)

Step 2.3: chrony_ntp role (services host)
  ├── Transfer chrony RPMs (or use RHEL 9 built-in chrony)
  ├── Configure /etc/chrony.conf
  │     ├── local stratum 10 (orphan mode — no upstream, air-gapped)
  │     ├── allow 10.0.2.0/24
  │     └── driftfile /var/lib/chrony/drift
  ├── Enable and start chronyd.service
  └── VALIDATION: chronyc sources (from services host)

Step 2.4: Apply common_client role (all private hosts except services)
  ├── Set resolv.conf nameserver to 10.0.2.10
  ├── Configure chrony client to NTP server 10.0.2.10
  └── VALIDATION: dig, chronyc tracking from each host

NOTE: The registry host (10.0.2.20) is provisioned as infrastructure only.
      Registry configuration (mirror-registry binary + oc mirror v2) is handled
      by a separate project. The host, DNS record, security group, and 200 GiB
      data volume are ready for that project to consume.

Step 2.5: ocp_node_prep role (ocp-node-0, ocp-node-1, ocp-node-2)
  ├── Configure bastion local repo
  ├── Validate DNS resolution (api.ocp.{{ sandbox_domain }}, *.apps.ocp.{{ sandbox_domain }})
  ├── Validate NTP sync (chronyc tracking)
  └── Validate FIPS mode enabled

Step 2.6: rhel_hardening role — STIG pass (ALL hosts)
  ├── Install openscap-scanner, scap-security-guide
  │     Bastion: direct dnf install
  │     Private hosts: from bastion local repo (http://10.0.1.10:8080/)
  ├── Apply STIG remediation:
  │     oscap xccdf eval --remediate
  │       --profile xccdf_org.ssgproject.content_profile_stig
  │       /usr/share/xml/scap/ssg/content/ssg-rhel9-ds.xml
  ├── Reboot after remediation
  ├── Generate post-remediation compliance report
  └── Report: /var/log/openscap/stig-compliance.html
      NOTE: STIG is applied AFTER services are configured to avoid
            remediation breaking service configurations. oscap exit code
            2 is expected (some controls require manual remediation).
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

group_vars/all.yml:
  ansible_ssh_common_args: >-
    -o ProxyCommand="ssh -W %h:%p -i ~/.ssh/disconnected-sandbox.pem
    ec2-user@{{ bastion_eip }}"
  ansible_user: ec2-user
  ansible_ssh_private_key_file: ~/.ssh/disconnected-sandbox.pem
```

The bastion group overrides `ansible_ssh_common_args` to empty (direct connection).

### 4.5 Dynamic Inventory Configuration

**`inventory/aws_ec2.yml`:**
```yaml
plugin: amazon.aws.aws_ec2
regions:
  - "{{ aws_region }}"             # required — no default
filters:
  tag:Project: disconnected-sandbox
  instance-state-name: running
keyed_groups:
  - key: tags.sandbox_role
    prefix: role
    separator: "_"
hostnames:
  - private-ip-address
compose:
  ansible_host: private_ip_address
```

This produces groups: `role_bastion`, `role_services`, `role_registry`, `role_ocp_node`.

### 4.6 Teardown Strategy

**Playbook:** `playbooks/teardown.yml`

Reverse-order destruction, all filtered by `tag:Project=disconnected-sandbox`:

1. Terminate all EC2 instances (wait for termination)
2. Release Elastic IP
3. Delete key pair
4. Delete security groups (must be after instance termination)
5. Delete subnets
6. Detach and delete Internet Gateway
7. Delete route tables (non-main)
8. Delete VPC

All resources are discovered by tag, making teardown idempotent and safe
against partial provisioning failures.

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
  │ DEFAULTS (override as needed):
  ├── vpc_cidr: 10.0.0.0/16
  ├── public_subnet_cidr: 10.0.1.0/24
  ├── private_subnet_cidr: 10.0.2.0/24
  ├── cluster_name: ocp              # subdomain prefix → ocp.{{ sandbox_domain }}
  ├── project_tag: disconnected-sandbox
  ├── ssh_key_name: disconnected-sandbox-key
  └── ssh_key_path: ~/.ssh/disconnected-sandbox.pem

inventory/group_vars/bastion.yml
  ├── bastion_instance_type: t3.medium
  ├── bastion_private_ip: 10.0.1.10
  └── ansible_ssh_common_args: ""     # Direct connection (override)

inventory/group_vars/services.yml
  ├── services_instance_type: t3.medium
  ├── services_private_ip: 10.0.2.10
  └── ntp_allow_subnet: 10.0.2.0/24
      # dns_zone derived: {{ cluster_name }}.{{ sandbox_domain }}

inventory/group_vars/registry.yml
  ├── registry_instance_type: t3.large
  ├── registry_private_ip: 10.0.2.20
  ├── registry_port: 8443
  └── registry_data_volume_size: 200
      # Host provisioned only — mirror-registry configured by separate project
      # Port defined here so SG rules open the correct network paths

inventory/group_vars/ocp_nodes.yml
  ├── ocp_instance_type: m5.2xlarge
  ├── ocp_node_count: 3
  ├── ocp_node_base_ip: 10.0.2.100
  └── ocp_root_volume_size: 120
```

---

## 6. Risk Register & Design Trade-offs

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| Static private IPs | Less flexible than DHCP | Required for DNS zone files and SG rules to use specific IPs; OCP needs stable IPs for etcd |
| Bastion as content relay | Bastion does double duty | Avoids VPC endpoints or NAT; faithful simulation of air-gap sneakernet model |
| Registry host provisioned, not configured | Requires separate project to set up mirror-registry | Clean separation of concerns; infrastructure is reusable across registry implementations |
| Single AZ | No HA | Sandbox/lab scope; keeps costs and complexity down |
| m5.2xlarge for OCP | Expensive | OCP 4 minimum for compact cluster (8 vCPU, 32 GiB RAM per node) |
| Local stratum 10 chrony | Time drift over days | Air-gapped; no upstream NTP. Acceptable for sandbox lifespan |
| `dnf localinstall` | Manual RPM management | Air-gap constraint; alternative is pre-baked AMIs (higher AMI maintenance) |
| HAProxy on bastion | Bastion is ingress + jump host | Only public-subnet host; alternative is NLB ($$) or SSH tunnels (fragile) |
| Route53 records → bastion EIP | External DNS bypasses internal BIND9 | Split-horizon: external clients hit bastion HAProxy, internal clients hit OCP directly |
| FIPS before services | Requires reboot early in Phase 2 | All crypto must be FIPS from the start; SSH reconnection via `ansible.builtin.reboot` is reliable |
| STIG after services | Some controls may conflict with configs | Applying STIG first would break service setup; post-service STIG is standard for hardened labs |
| Bastion HTTP repo (:8080) | Extra SG ingress on bastion | More scalable than SCP per-host; realistic pattern for disconnected environments |
| STIG exit code 2 expected | Not 100% compliant | Some STIG controls require manual steps or are N/A in cloud; compliance report is generated for audit |

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
  │  │     server node-0 10.0.2.100:6443│
  │  │     server node-1 10.0.2.101:6443│
  │  │     server node-2 10.0.2.102:6443│
  │  ├── *:443  → backend apps          │
  │  │     server node-0 10.0.2.100:443 │
  │  │     server node-1 10.0.2.101:443 │
  │  │     server node-2 10.0.2.102:443 │
  │  └── *:80   → backend apps-http     │
  │        server node-0 10.0.2.100:80  │
  │        server node-1 10.0.2.101:80  │
  │        server node-2 10.0.2.102:80  │
  └──────────────────┬──────────────────┘
                     │ VPC local route (10.0.0.0/16)
                     ▼
  ┌─────────────────────────────────────┐
  │ OCP NODES (Private Subnet)          │
  │  10.0.2.{100,101,102}               │
  │  *** Still NO internet access ***   │
  └─────────────────────────────────────┘
```

### 7.2 Split-Horizon DNS

Two DNS views serve the same names with different targets:

| Record                                  | External (Route53)   | Internal (BIND9)      |
|-----------------------------------------|----------------------|-----------------------|
| `api.ocp.{{ sandbox_domain }}`          | → Bastion EIP        | → 10.0.2.100          |
| `api-int.ocp.{{ sandbox_domain }}`      | (not published)      | → 10.0.2.100          |
| `*.apps.ocp.{{ sandbox_domain }}`       | → Bastion EIP        | → 10.0.2.100          |
| `registry.ocp.{{ sandbox_domain }}`     | (not published)      | → 10.0.2.20           |

External clients (browser, `oc` CLI) resolve via Route53 → bastion EIP → HAProxy → OCP nodes.
Internal clients (OCP nodes, registry) resolve via BIND9 → private IPs directly.

### 7.3 Why HAProxy in TCP Mode

- **No TLS termination on bastion** — HAProxy passes encrypted traffic through. The bastion
  never sees OCP API tokens or console session cookies. TLS terminates on the OCP nodes.
- **Preserves OCP certificate validation** — `oc login` validates the OCP-generated API cert,
  which is issued for `api.ocp.{{ sandbox_domain }}`. TCP passthrough means the cert matches.
- **Simple configuration** — no cert management on the bastion for OCP traffic.

### 7.4 Execution (Phase 2 addition)

```
Step 2.8: infra_route53 role (localhost — AWS API)
  ├── Look up existing hosted zone for {{ sandbox_domain }}
  ├── Create A record: api.ocp.{{ sandbox_domain }} → {{ bastion_eip }}
  ├── Create A record: *.apps.ocp.{{ sandbox_domain }} → {{ bastion_eip }}
  └── VALIDATION: dig +short api.ocp.{{ sandbox_domain }} returns bastion EIP

Step 2.7: bastion_haproxy role (bastion host)
  ├── Install haproxy via dnf (bastion has internet)
  ├── Generate /etc/haproxy/haproxy.cfg from template
  │     ├── frontend api :6443 → backend ocp-api (TCP mode)
  │     ├── frontend apps :443 → backend ocp-apps (TCP mode)
  │     ├── frontend apps-http :80 → backend ocp-apps-http (TCP mode)
  │     └── stats socket for monitoring
  ├── Configure SELinux for HAProxy port bindings
  ├── Enable and start haproxy.service
  └── VALIDATION: curl -k https://api.ocp.{{ sandbox_domain }}:6443/version (expect OCP API or connection refused until OCP is installed)
```

### 7.5 Air-Gap Integrity

The HAProxy ingress does NOT break the air-gap:
- OCP nodes still have zero outbound internet routes (private RT unchanged)
- HAProxy forwards **inbound** traffic only — it initiates connections to private IPs
- The bastion is the only host with an internet-facing interface
- No new routes, NAT, or VPC endpoints are added to the private subnet

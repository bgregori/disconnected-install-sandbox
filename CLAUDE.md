# CLAUDE.md — disconnected-openshift-aws-sandbox

## Project Overview

IaC repository for provisioning an isolated AWS sandbox that simulates a disconnected
OpenShift 4 installation target. All infrastructure is managed via Ansible playbooks
using the `amazon.aws` collection. The private subnet is fully air-gapped — no NAT
gateway, no internet gateway routes, no VPC endpoints.

## Architecture Reference

See `ARCHITECTURE.md` for the full blueprint: AWS resource mapping, security group matrix,
execution workflow, and variable hierarchy.

## Prerequisites

- Ansible >= 2.15 with Python >= 3.9
- Collections: `amazon.aws >= 9.0.0`, `ansible.posix >= 1.6.0`, `community.crypto >= 2.0.0`, `community.general >= 8.0.0`
- boto3 >= 1.28.0 (required by amazon.aws)
- AWS account with VPC/EC2/Route53/SG permissions + a Route53 hosted zone

Install dependencies:
```bash
ansible-galaxy collection install -r requirements.yml
pip install boto3 botocore
```

## Required Variables

These have NO defaults — playbooks fail fast if not provided:

| Variable | Source | Example |
|---|---|---|
| `aws_region` | User choice | `us-east-2` |
| `sandbox_domain` | Your Route53 hosted zone | `example.com` |
| `admin_cidr` | Operator's public IP | `203.0.113.42/32` |

`sandbox_domain` is needed by EVERY phase, not just Phase 1 — `cluster_domain` derives from it, and
`bind_dns`, `common_client`, `ocp_node_prep` and the DNS checks in `validate.yml` all read that. Omit
it from a Phase 2 or validate run and the run dies partway through on `'sandbox_domain' is undefined`,
after the earlier plays have already made changes.

AWS credentials MUST be exported as environment variables (never in playbooks):
```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="wJalr..."
```

## Cluster Topology

`ocp_topology` (in `inventory/group_vars/all.yml`) is the only knob for cluster shape —
`sno`, `compact` (default), or `standard` (3 masters + 3 workers). The preset in
`ocp_topology_presets` expands into `ocp_nodes`, the single source of truth for libvirt
domains, BIND9 records, SSH config entries, and the secondary IPs on the KVM host ENI.
Per-VM sizing and `kvm_data_volume_size` come from the same preset.

Never hardcode node counts, node names, or VM sizing — derive from `ocp_nodes`. Each
entry is `{name, hostname, role, ip, vcpu, memory_mb, disk_gb, storage_disk,
storage_disk_gb}`. When adding a consumer, loop over `ocp_nodes`, not an index range.

Every derived value stays individually overridable (`ocp_worker_count`,
`ocp_master_vcpu`, `kvm_data_volume_size`, …). Keep it that way when extending the
presets. See README "Cluster Topology" for the full table.

## Execution Commands

```bash
# Full provision + configure (add -e ocp_topology=standard to change cluster shape)
ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32

# Phase 1 only: AWS infrastructure
ansible-playbook playbooks/phase1_provision.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32

# Phase 2 only: configure RHEL services (requires Phase 1 complete)
ansible-playbook playbooks/phase2_configure.yml -i inventory/aws_ec2.yml \
  -e sandbox_domain=example.com

# Validate all services
ansible-playbook playbooks/validate.yml -i inventory/aws_ec2.yml \
  -e sandbox_domain=example.com

# Teardown everything
ansible-playbook playbooks/teardown.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com

# Lint
ansible-lint playbooks/ roles/
yamllint .
```

## Coding Conventions

### Ansible Style

- Target `ansible-core >= 2.15`. Do not use deprecated modules or syntax.
- Use FQCNs everywhere: `amazon.aws.ec2_instance`, never `ec2_instance`.
- Every task MUST have a `name:` field. Use lowercase imperative mood: "create vpc", not "Creating VPC" or "VPC Creation".
- Use `block/rescue` for AWS operations that need rollback awareness.
- Register results with descriptive names: `vpc_result`, not `result` or `r`.
- Prefix role variables with the role name: `bind_dns_listen_ip`, `chrony_ntp_allow_subnet`.
- Name per-group files in `inventory/group_vars/` for the group the `aws_ec2` plugin actually creates —
  `role_bastion.yml`, not `bastion.yml`. A file matching no group is silently ignored, with no warning.
- Use `ansible.builtin.assert` for validation checkpoints, not debug + fail.
- All AWS resources MUST be tagged with `Project: disconnected-sandbox` and `Environment: sandbox`.
- Use `amazon.aws.ec2_instance` (not the deprecated `ec2` module).
- Secrets (passwords, keys) go in `ansible-vault` encrypted files, never in plaintext vars.

### Role Structure

- Every role must have `defaults/main.yml` with all configurable variables and sane defaults.
- Every role must have `meta/main.yml` with `dependencies`, `min_ansible_version`, and `platforms`.
- Handlers must be in `handlers/main.yml`, not inline in tasks.
- Keep `tasks/main.yml` focused; use `include_tasks` to break up large task files when they exceed ~150 lines.
- Templates use `.j2` extension. No logic heavier than conditionals and loops in templates.

### YAML Style

- 2-space indentation, no tabs.
- Always use `true`/`false`, never `yes`/`no` for booleans.
- Quote strings only when YAML requires it (colons, special chars, booleans that aren't).
- One empty line between task blocks. No trailing whitespace.
- Maximum line length: 120 characters (yamllint rule).

### Security Rules

- Never hardcode AWS credentials in playbooks or variables.
- Never commit SSH private keys, TLS private keys, or pull secrets.
- All SG rules must be explicit — no `0.0.0.0/0` ingress rules except bastion SSH from admin_cidr.
- Private subnet egress rules must NEVER include `0.0.0.0/0` as destination.
- Validate air-gap: assert private route table has no default route after provisioning.

### Storage Rules

- NEVER write a device path to `/etc/fstab`. AWS assigns NVMe names in attach order at boot, so they move
  across reboots — the volume that is `/dev/nvme1n1` when a play formats it can be `/dev/nvme0n1` after the
  STIG reboot, and that is usually the root disk.
- Detect the device to decide what to format, then resolve its UUID after `community.general.filesystem`
  runs and mount with `src: "UUID=..."`. The device path must not outlive the play that found it.
- Resolve UUIDs with `blkid -c /dev/null -s UUID -o value <dev>`. `-c /dev/null` bypasses the blkid cache,
  so a filesystem created one task earlier is probed off the device instead of read from a stale entry.
- Assert the UUID is non-empty before mounting. An empty one writes a bare `UUID=` that fails at boot.
- Data volumes mount `nofail`, so a detached or misnamed volume cannot wedge the boot — which also means it
  fails silently. Every `nofail` mount needs a matching check in `playbooks/validate.yml`: mounted at all,
  backed by the data volume rather than the root disk, and pinned in fstab by UUID.

### Git Practices

- Conventional commit messages: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`.
- One role per commit when building new roles.
- PR descriptions must include which phase (1 or 2) is affected and which AWS resources change.

## Linting Configuration

### `.ansible-lint`

```yaml
skip_list:
  - yaml[line-length]    # handled by yamllint at 120
  - name[casing]         # we use lowercase imperative

warn_list:
  - experimental

enable_list:
  - fqcn
  - no-changed-when
  - no-handler

use_default_rules: true
offline: false
```

### `.yamllint`

```yaml
extends: default
rules:
  line-length:
    max: 120
    level: warning
  truthy:
    allowed-values: ['true', 'false']
    check-keys: true
  indentation:
    spaces: 2
    indent-sequences: true
  comments:
    min-spaces-from-content: 1
  comments-indentation: false
  braces:
    max-spaces-inside: 1
  octal-values:
    forbid-implicit-octal: true
    forbid-explicit-octal: true
```

## File Layout Quick Reference

```
playbooks/                  Orchestration playbooks (site, phase1, phase2, teardown, validate)
roles/infra_vpc             Phase 1 — VPC, subnets, internet gateway, route tables
roles/infra_security_groups Phase 1 — Security groups for bastion, services, registry, KVM
roles/infra_ec2             Phase 1 — EC2 instances, SSH key pair generation and import
roles/infra_route53         Phase 1 — Route53 DNS records
roles/infra_ssh_config      Phase 1 — Local SSH client configuration (~/.ssh/config.d)
roles/bastion_repo          Phase 2 — Local yum repo on bastion for air-gapped hosts
roles/rhel_hardening        Phase 2 — FIPS 140-3 enablement + DISA STIG application
roles/bastion_haproxy       Phase 2 — HAProxy reverse proxy for OCP API + apps ingress
roles/bind_dns              Phase 2 — BIND9 DNS server
roles/chrony_ntp            Phase 2 — Chrony NTP server
roles/common_client         Phase 2 — DNS/NTP client config for all private hosts
roles/keycloak_idp          Phase 2 — RHBK OIDC identity provider (podman + PostgreSQL)
roles/kvm_host              Phase 2 — KVM/libvirt host with OCP node VMs (optional)
roles/redfish_bmc           Phase 2 — sushy-emulator Redfish BMC (optional)
roles/ocp_node_prep         Phase 2 — OCP node prerequisites and validation
inventory/                  Dynamic inventory (aws_ec2 plugin) + group_vars
files/rpms/                 Staging directory for offline RPM bundles (gitignored)
scripts/                    Helper scripts (RPM download, pull-secret handling)
docs/                       Agent-based installer guide and operational procedures
```

## Operational Tips

Long-running operations on the bastion (e.g., `oc mirror`, large downloads) should run
inside `tmux` so they survive SSH disconnections. `tmux` is installed by the `bastion_repo`
role.

```bash
tmux new -s mirror        # start a named session
# ... run oc mirror ...
# if disconnected: ssh bastion-sandbox, then:
tmux attach -t mirror     # resume
```

Binaries extracted to `/usr/local/bin` on STIG'd hosts need correct ownership and SELinux
context — the tarball preserves the original UID which won't match:

```bash
sudo chown root:root /usr/local/bin/<binary>
sudo chmod 0755 /usr/local/bin/<binary>
sudo restorecon -v /usr/local/bin/<binary>
```

If `fapolicyd` is enabled (STIG default), manually placed binaries must also be trusted:

```bash
sudo fapolicyd-cli --file add /usr/local/bin/<binary>
sudo fapolicyd-cli --update
```

## Debugging

```bash
# Verbose Ansible output
ansible-playbook playbooks/site.yml -vvv

# Test SSH connectivity through bastion
ssh -F ~/.ssh/config services-sandbox hostname

# Test dynamic inventory
ansible-inventory -i inventory/aws_ec2.yml --graph
ansible-inventory -i inventory/aws_ec2.yml --list

# Check specific SG rules
aws ec2 describe-security-groups --filters "Name=tag:Project,Values=disconnected-sandbox" \
  --query 'SecurityGroups[].{Name:GroupName,Rules:IpPermissions}'

# Validate air-gap (should return only local route)
aws ec2 describe-route-tables --filters "Name=tag:Name,Values=disconnected-sandbox-private-rt" \
  --query 'RouteTables[].Routes'
```

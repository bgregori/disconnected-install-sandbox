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
- Collections: `amazon.aws >= 7.0.0`, `community.crypto >= 2.0.0`
- boto3 >= 1.28.0 (required by amazon.aws)
- OPENTLC Open Environment provisioned (provides AWS creds + Route53 domain)

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
| `sandbox_domain` | OPENTLC environment email | `sandbox2229.opentlc.com` |
| `admin_cidr` | Operator's public IP | `203.0.113.42/32` |

AWS credentials MUST be exported as environment variables (never in playbooks):
```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="wJalr..."
```

## Execution Commands

```bash
# Full provision + configure
ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=sandbox2229.opentlc.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32

# Phase 1 only: AWS infrastructure
ansible-playbook playbooks/phase1_provision.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=sandbox2229.opentlc.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32

# Phase 2 only: configure RHEL services (requires Phase 1 complete)
ansible-playbook playbooks/phase2_configure.yml -i inventory/aws_ec2.yml

# Validate all services
ansible-playbook playbooks/validate.yml -i inventory/aws_ec2.yml

# Teardown everything
ansible-playbook playbooks/teardown.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=sandbox2229.opentlc.com

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
- Use `ansible.builtin.assert` for validation checkpoints, not debug + fail.
- All AWS resources MUST be tagged with `Project: disconnected-sandbox` and `Environment: sandbox`.
- Use `amazon.aws.ec2_instance` (not the deprecated `ec2` module).
- Secrets (passwords, keys) go in `ansible-vault` encrypted files, never in plaintext vars.

### Role Structure

- Every role must have `defaults/main.yml` with all configurable variables and sane defaults.
- Every role must have `meta/main.yml` with `dependencies`, `min_ansible_version`, and `platforms`.
- Handlers must be in `handlers/main.yml`, not inline in tasks.
- Keep `tasks/main.yml` as an include dispatcher; put logic in sub-task files.
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
```

## File Layout Quick Reference

```
playbooks/           Orchestration playbooks (site, phase1, phase2, teardown, validate)
roles/infra_*        Phase 1 — AWS resource provisioning (runs on localhost)
roles/bind_dns       Phase 2 — BIND9 DNS server
roles/chrony_ntp     Phase 2 — Chrony NTP server
roles/mirror_registry Phase 2 — Podman container registry with self-signed TLS
roles/common_client  Phase 2 — DNS/NTP client config for all private hosts
roles/ocp_node_prep  Phase 2 — OCP node prerequisites and validation
inventory/           Dynamic inventory (aws_ec2 plugin) + group_vars
files/rpms/          Staging directory for offline RPM bundles (gitignored)
scripts/             Helper scripts (RPM download, pull-secret handling)
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

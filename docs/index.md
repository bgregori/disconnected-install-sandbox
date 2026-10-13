---
title: Disconnected OpenShift 4 — AWS Sandbox
description: Ansible that provisions an air-gapped AWS environment for practicing disconnected OpenShift 4 installations.
hero: true
hero_title: Disconnected OpenShift 4 on AWS
hero_tagline: >-
  Ansible that turns an empty AWS account into a genuinely air-gapped target for
  rehearsing a disconnected OpenShift 4 install — all the way to cluster nodes
  waiting on a Redfish BMC.
---

> The private subnet has **no NAT gateway, no internet gateway route, and no VPC
> endpoints**. Nothing in it can reach the internet. That is the whole point — every
> package, image, and certificate has to come across the bastion, exactly as it would in
> a real disconnected environment.

---

## What gets built

```
                 ┌──────────────────────────────────────────────────────┐
                 │              VPC 10.0.0.0/16                         │
  INTERNET       │                                                      │
  ──────► IGW ───┤  Public Subnet 10.0.1.0/24                           │
  :443/:6443     │    bastion — HAProxy, yum repo, EIP                  │
                 │      │                                               │
                 │  ────│── Private Subnet 10.0.2.0/24 ───────────────  │
                 │      │                                               │
                 │      ├── services   BIND9 DNS, Chrony NTP,           │
                 │      │              Keycloak OIDC (optional)         │
                 │      ├── registry   mirror registry host (500 GiB)   │
                 │      └── kvm        m5.metal — libvirt + sushy        │
                 │                     Redfish BMC, OCP node VMs        │
                 │                                                      │
                 │      *** NO route to the internet ***                │
                 └──────────────────────────────────────────────────────┘
```
{: .diagram}

| Piece | What you get |
|---|---|
| **Air-gapped VPC** | Public subnet for the bastion, private subnet with no path out. Provisioning asserts the private route table has no default route. |
| **Bastion** | The only bridge: SSH `ProxyCommand` jump host, HAProxy L4 passthrough for `:6443`/`:443`/`:80`, and an httpd yum repo so private hosts can still install RPMs. |
| **Split-horizon DNS** | Route53 serves `api.ocp.*` and `*.apps.ocp.*` to the bastion EIP; BIND9 serves the same names internally, pointed at the keepalived VIPs. |
| **Bare metal simulation** | An m5.metal host runs the OCP nodes as KVM VMs on a bridged, proxy-ARP network, fronted by a sushy-emulator Redfish BMC — so the **Agent-Based Installer** works just as it does on real hardware. |
| **Hardened by default** | FIPS 140-3 and DISA STIG remediation applied to every host, so you hit the same `fapolicyd`, SELinux, and sudo friction a customer would. |
| **One root of trust** | A sandbox root CA — created on your workstation, never on a sandbox host — signs every TLS endpoint and is installed in each host's trust store. Certificates for the mirror registry, `api`, and `*.apps` are pre-issued into `artifacts/pki/cluster/`, alongside a paste-ready `additionalTrustBundle` fragment for `install-config.yaml`. |
| **One knob for shape** | `ocp_topology` picks `sno`, `compact`, or `standard`; node counts, IPs, VIPs, DNS records, VM sizing, and disk sizes all derive from it. |

**Not in scope:** the registry host is provisioned as infrastructure only. Populating it
with `mirror-registry` and `oc mirror v2` is a separate project, and OpenShift itself is
installed by you, following [the agent-based install guide](agent-based-install.md). Both
steps find a certificate from the sandbox CA already waiting for them, so nothing has to
be self-signed on the way.

---

## Who this is for

Solutions architects, consultants, and engineers who need a disposable disconnected
target — to rehearse an air-gapped install before a customer engagement, to reproduce a
support case, or to demo the agent-based installer without shipping hardware anywhere.

It is a **sandbox**: built to be torn down. Single AZ, no backups, no HA on the
supporting services.

---

## How to use these docs

Read in this order the first time through:

| # | Page | Read it when |
|---|---|---|
| 1 | **This page** | Getting oriented and standing the environment up. |
| 2 | [Agent-Based Installer: ISO generation and VM boot](agent-based-install.md) | The sandbox is up and validated, your mirror registry is populated, and you're ready to install OpenShift onto the VMs. |

Three more references live in the repository rather than on this site, because they
track the code closely:

- **[README](https://github.com/bgregori/disconnected-install-sandbox/blob/main/README.md)** — the fullest command reference: every topology, every override, split-horizon DNS tables, dynamic inventory notes.
- **[ARCHITECTURE.md](https://github.com/bgregori/disconnected-install-sandbox/blob/main/ARCHITECTURE.md)** — the blueprint: AWS resource mapping, the security group matrix, execution workflow, variable hierarchy, and the environment PKI. Go here when you need to know *why* a rule or address exists.
- **[CLAUDE.md](https://github.com/bgregori/disconnected-install-sandbox/blob/main/CLAUDE.md)** — conventions for contributing: Ansible style, role structure, lint configuration, and the storage and security rules that are non-negotiable.

Each role's `defaults/main.yml` is also written to be read — it documents every variable
the role exposes and, in several cases, the reasoning behind the default.

---

## Getting started

### 1. Satisfy the prerequisites

- Ansible >= 2.15 on Python >= 3.9, plus `boto3 >= 1.28.0`
- An AWS account with VPC, EC2, Route53, and security group permissions
- A **Route53 hosted zone** you control — the playbooks create records in an existing zone, they do not create the zone

```bash
git clone https://github.com/bgregori/disconnected-install-sandbox.git
cd disconnected-install-sandbox
ansible-galaxy collection install -r requirements.yml
pip install boto3 botocore
```

> **Red Hat Solutions Architects:** the **Open AWS Environment** catalog item on the
> [Red Hat Demo Platform](https://demo.redhat.com) hands you an ephemeral AWS account
> with a delegated Route53 domain — ideal for this, and it keeps the sandbox out of
> personal and customer accounts.

### 2. Export your AWS credentials

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="wJalr..."
```

Credentials are read from the environment, never from a playbook or vars file. **Never
commit them.**

### 3. Know the three required variables

These have no defaults — a run fails fast without them.

| Variable | Where it comes from | Example |
|---|---|---|
| `aws_region` | Your choice | `us-east-2` |
| `sandbox_domain` | Your Route53 hosted zone | `example.com` |
| `admin_cidr` | Your public IP, as a `/32` | `203.0.113.42/32` |

`sandbox_domain` is needed by *every* phase, not just the provisioning one — pass it to
Phase 2 and to validation as well.

### 4. Pick a cluster topology

| `ocp_topology` | Nodes | Good for |
|---|---|---|
| `sno` | 1 schedulable master | Single-node OpenShift, OpenShift Virtualization POCs (gets a 500 GiB secondary disk) |
| `compact` *(default)* | 3 schedulable masters | The usual edge/compact footprint |
| `standard` | 3 masters + 3 workers | A conventional control plane / worker split |

Everything downstream — node names, IPs, VIPs, BIND9 records, SSH aliases, VM sizing,
and the KVM data volume — derives from this one value.

### 5. Build it

```bash
ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32
```

That runs both phases and gives you the default 3-node compact cluster. Add
`-e ocp_topology=sno` or `-e ocp_topology=standard` for a different shape.

Phase 1 provisions AWS (VPC, security groups, EC2, SSH config, Route53) from `localhost`
and prints the resolved topology, the node-to-IP map, and the VIPs — copy those straight
into your `agent-config.yaml` later. Phase 2 configures RHEL over SSH through the bastion
and includes two reboots for FIPS and the STIG remediation, so expect it to take a while.

To skip the KVM host entirely and save roughly **$4.60/hour**:

```bash
ansible-playbook playbooks/site.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com \
  -e admin_cidr=$(curl -s ifconfig.me)/32 \
  -e enable_kvm_host=false
```

### 6. Validate it

```bash
ansible-playbook playbooks/validate.yml -i inventory/aws_ec2.yml \
  -e sandbox_domain=example.com
```

This checks the air gap, FIPS, DNS in both views, NTP sync, HAProxy, the KVM host and
Redfish BMC, that every TLS endpoint chains to the sandbox root CA, and that the `nofail`
data volume mounts are genuinely backed by the data volume and pinned in `fstab` by UUID.
Treat a green validate as the gate before you start installing OpenShift.

### 7. Get in

```bash
ssh -F ~/.ssh/config.d/disconnected-sandbox bastion-sandbox
ssh -F ~/.ssh/config.d/disconnected-sandbox services-sandbox
ssh -F ~/.ssh/config.d/disconnected-sandbox registry-sandbox
ssh -F ~/.ssh/config.d/disconnected-sandbox kvm-sandbox       # when KVM is enabled
```

Private hosts are reached through the bastion automatically via `ProxyCommand`.

> Run anything long — `oc mirror`, large transfers — inside `tmux` on the bastion so it
> survives an SSH drop. `tmux new -s mirror`, then `tmux attach -t mirror` to get back.

### 8. Install OpenShift

Populate the mirror registry, then follow
[the agent-based install guide](agent-based-install.md): write `install-config.yaml` and
`agent-config.yaml`, generate the ISO, and boot the VMs through the Redfish BMC.

Phase 2 left the certificate material you need in `artifacts/pki/cluster/` —
`registry.crt`/`.key` for `mirror-registry --sslCert/--sslKey`, `api` and `ingress` pairs
for the cluster's named certificates, and
`install-config-additionalTrustBundle.yaml` to paste straight into `install-config.yaml`.
The `README.md` in that directory has the commands.

### 9. Tear it down

```bash
ansible-playbook playbooks/teardown.yml \
  -e aws_region=us-east-2 \
  -e sandbox_domain=example.com
```

An m5.metal instance is expensive and the teardown is idempotent — **run it as soon as
you're done.** It removes everything tagged `Project: disconnected-sandbox`.

---

## Optional components

| Component | Flag | Notes |
|---|---|---|
| KVM bare metal host | `enable_kvm_host` *(default `true`)* | The m5.metal instance, the node VMs, and the Redfish BMC. Turn it off for a cheaper DNS/NTP/registry-only sandbox. |
| Keycloak OIDC issuer | `enable_keycloak_idp` *(default `false`)* | RHBK + PostgreSQL under podman on the services host, serving `https://keycloak.ocp.<domain>:8443/realms/openshift`. Needs Red Hat registry credentials via `bastion_repo_registry_auth_file`, since the bastion has to pull and `podman save` the images for the air-gapped host. |

---

## Troubleshooting quick hits

```bash
# verbose run
ansible-playbook playbooks/site.yml -vvv

# does the dynamic inventory see the hosts?
ansible-inventory -i inventory/aws_ec2.yml --graph

# is the air gap intact? (should show only the local route)
aws ec2 describe-route-tables \
  --filters "Name=tag:Name,Values=disconnected-sandbox-private-rt" \
  --query 'RouteTables[].Routes'
```

Two things that bite people on STIG'd hosts: a binary you drop into `/usr/local/bin`
needs `chown root:root`, `chmod 0755`, and `restorecon` before it will run, and with
`fapolicyd` enabled it also needs
`fapolicyd-cli --file add <path> && fapolicyd-cli --update`.

The [agent-based install guide](agent-based-install.md) has a troubleshooting section
covering the install-time failures — DNS checks against `[::1]:53`, registry
connectivity, Redfish `InsertMedia` errors, and the KVM host's NVMe renaming.

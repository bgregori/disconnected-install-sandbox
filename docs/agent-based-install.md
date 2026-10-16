---
title: "Agent-Based Installer: ISO Generation and VM Boot"
description: Generate the agent ISO, transfer it to the KVM host, and boot the VMs over Redfish virtual media.
---

# Agent-Based Installer: ISO Generation and VM Boot

This guide covers the post-provisioning steps to generate an OpenShift agent-based
installer ISO on the registry host, transfer it to the KVM host, and boot the VMs
from it using Redfish virtual media.

## Prerequisites

- Phase 1 and Phase 2 playbooks have completed successfully
- Mirror registry on the registry host is populated (`oc mirror` has run), served with the
  `registry.crt`/`.key` pair Phase 2 left in `artifacts/pki/cluster/`
- DNS records for `api.ocp.<domain>`, `api-int.ocp.<domain>`, and
  `*.apps.ocp.<domain>` resolve correctly
- The KVM host VMs are defined but not running (`virsh list --all` shows them as `shut off`)
- Each VM has a secondary disk (`vdb`) for LVM Storage when the selected
  topology enables one (`sno` and `compact` do; `standard` does not)

## 1. Prepare installer configs on the registry host

SSH to the registry host and create a working directory:

```bash
ssh registry-sandbox
mkdir -p ~/ocp-installer
cd ~/ocp-installer
```

### install-config.yaml

```yaml
apiVersion: v1
metadata:
  name: ocp
baseDomain: <sandbox_domain>
networking:
  networkType: OVNKubernetes
  machineNetwork:
    - cidr: 10.0.2.0/24
  clusterNetwork:
    - cidr: 10.128.0.0/14
      hostPrefix: 23
  serviceNetwork:
    - 172.30.0.0/16
compute:
  - name: worker
    replicas: 0        # 3 when ocp_topology=standard
controlPlane:
  name: master
  replicas: 3          # match ocp_master_count: 3 for compact/standard, 1 for sno
platform:
  none: {}
pullSecret: '<pull-secret-json>'
sshKey: '<ssh-public-key>'
imageDigestSources:
  # Paste IDMS entries from oc-mirror results directory.
  # Convert from ImageDigestMirrorSet YAML to install-config format:
  #   source: -> - source:
  #   mirrors: -> mirrors:
  - source: quay.io/openshift-release-dev/ocp-release
    mirrors:
      - registry.ocp.<domain>:8443/openshift/release-images
  - source: quay.io/openshift-release-dev/ocp-v4.0-art-dev
    mirrors:
      - registry.ocp.<domain>:8443/openshift/release
additionalTrustBundle: |
  # Paste the sandbox root CA here — see below.
```

> **Note:** Use `imageDigestSources`, not the deprecated `imageContentSources`.

> **`additionalTrustBundle` is not optional here.** The mirror registry is served with a
> certificate from the sandbox root CA, and the installer and every node verify the registry
> against this bundle before they can pull a single image. Omit it and the cluster fails during
> bootstrap with image pull errors that never mention certificates.
>
> Phase 2 wrote the fragment for you, correctly indented, on the machine you ran Ansible from:
>
> ```bash
> cat artifacts/pki/cluster/install-config-additionalTrustBundle.yaml
> ```
>
> Paste its contents in place of the `additionalTrustBundle` stub above. The same directory holds
> `registry.crt`/`.key` for `mirror-registry`, and `api`/`ingress` pairs to apply after the cluster
> is up — its `README.md` has those commands.

### agent-config.yaml

The example below shows a single host entry. Add one `hosts` entry per node in
the selected topology, each with its own hostname, MAC address, and IP. The
hostnames and IPs match what Phase 1 printed and what BIND9 serves:

| `ocp_topology` | Hosts |
|---|---|
| `sno` | `master-0` (10.0.2.100) |
| `compact` | `master-0..2` (10.0.2.100-102) |
| `standard` | `master-0..2` (10.0.2.100-102), `worker-0..2` (10.0.2.103-105) |

`rendezvousIP` must be the first master, 10.0.2.100.

```yaml
apiVersion: v1alpha1
metadata:
  name: ocp
rendezvousIP: 10.0.2.100
hosts:
  - hostname: master-0
    role: master
    interfaces:
      - name: enp1s0
        macAddress: <mac-from-virsh-domiflist>
    networkConfig:
      interfaces:
        - name: enp1s0
          type: ethernet
          state: up
          ipv4:
            enabled: true
            dhcp: false
            address:
              - ip: 10.0.2.100
                prefix-length: 24
      dns-resolver:
        config:
          server:
            - 10.0.2.10
      routes:
        config:
          - destination: 0.0.0.0/0
            next-hop-address: 10.0.2.30
            next-hop-interface: enp1s0
  # Add the remaining masters and any workers the same way, changing
  # hostname, role, macAddress, and the ipv4 address.
```

> **Important:** The `next-hop-address` must be `10.0.2.30` (the KVM host bridge IP),
> not `10.0.2.1` (the AWS VPC router). The VM reaches the network through the Linux
> bridge with proxy ARP, not directly through the VPC.

#### Getting the VM MAC address

The VMs are defined by the `kvm_host` role but have auto-generated MAC addresses.
Retrieve them before writing agent-config.yaml:

```bash
# On the KVM host
sudo virsh domiflist ocp-master-0
# Output: vnet0  bridge  virbr1  virtio  52:54:00:9e:b0:15
```

Repeat for every VM (`virsh list --all --name` lists them) and add a `hosts` entry
per node with the corresponding MAC, IP, and hostname. The libvirt domain
`ocp-master-0` corresponds to agent-config hostname `master-0`.

## 2. Generate the agent ISO

```bash
cd ~/ocp-installer
openshift-install agent create image --dir .
```

This produces `agent.x86_64.iso` in the current directory. The `auth/` subdirectory
is also created with `kubeconfig` and `kubeadmin-password` for post-install access.

## 3. Transfer the ISO to the KVM host

`/var/lib/libvirt/images` is `root:root 0755`, so `ec2-user` cannot write into it
directly — the ISO has to land in the home directory first and then be moved into
place with `sudo`. Use `install` rather than `mv`: it sets the ownership and mode
in one step, and `restorecon` then gives the file the `virt_image_t` label libvirt
needs to open it. A file moved in without relabelling inherits `user_home_t` and
the domain fails to start with a permission denied that does not mention SELinux.

From the registry host:

```bash
scp -i ~/.ssh/disconnected-sandbox.pem \
  agent.x86_64.iso \
  ec2-user@10.0.2.30:/home/ec2-user/

ssh -i ~/.ssh/disconnected-sandbox.pem ec2-user@10.0.2.30 '
  sudo install -o root -g root -m 0644 \
    /home/ec2-user/agent.x86_64.iso /var/lib/libvirt/images/ &&
  sudo restorecon -v /var/lib/libvirt/images/agent.x86_64.iso &&
  rm -f /home/ec2-user/agent.x86_64.iso'
```

Confirm the label before moving on — this is the one failure that surfaces late:

```bash
ls -Z /var/lib/libvirt/images/agent.x86_64.iso
# system_u:object_r:virt_image_t:s0
```

## 4. Boot VMs via Redfish virtual media

The `redfish_bmc` role runs sushy-emulator on the KVM host (port 8000), and the
`kvm_host` role runs an HTTP server on port 8888 to serve the ISO.

Redfish is **https**: `sandbox_tls_everywhere` defaults to `true`, so sushy-emulator
is given `SUSHY_EMULATOR_SSL_CERT`/`_KEY` and serves TLS directly — nothing proxies
it. No `-k` is needed, because the hosts carry the sandbox root CA as a trust anchor.
The ISO server on 8888 is separate and stays plain HTTP, so the `Image` URL below is
`http://`, not a typo.

### Find the VM system UUID

```bash
curl -s https://10.0.2.30:8000/redfish/v1/Systems/ | python3 -m json.tool
```

Each VM appears as a Redfish system with its libvirt UUID.

### Insert the ISO and boot

```bash
VM_UUID=<uuid-from-above>
KVM_IP=10.0.2.30

# Insert the ISO as virtual media
curl -f -X POST \
  https://${KVM_IP}:8000/redfish/v1/Systems/${VM_UUID}/VirtualMedia/Cd/Actions/VirtualMedia.InsertMedia \
  -H 'Content-Type: application/json' \
  -d "{\"Image\": \"http://${KVM_IP}:8888/agent.x86_64.iso\", \"Inserted\": true}"

# Set boot to CD-ROM for next boot
curl -f -X PATCH \
  https://${KVM_IP}:8000/redfish/v1/Systems/${VM_UUID} \
  -H 'Content-Type: application/json' \
  -d '{"Boot": {"BootSourceOverrideTarget": "Cd", "BootSourceOverrideMode": "UEFI", "BootSourceOverrideEnabled": "Once"}}'

# Power on the VM
curl -f -X POST \
  https://${KVM_IP}:8000/redfish/v1/Systems/${VM_UUID}/Actions/ComputerSystem.Reset \
  -H 'Content-Type: application/json' \
  -d '{"ResetType": "On"}'
```

> **VirtualMedia lives under `Systems`, not `Managers`.** This emulator exposes it
> at `/redfish/v1/Systems/<uuid>/VirtualMedia/Cd`; the `Managers` path returns 404.
> That 404 is easy to miss, because the boot-override and power-on calls that follow
> it still return 204 — the VM powers on correctly with no media attached and sits
> at the UEFI shell or PXE-boots instead. Hence `-f` on each curl above: without it
> the insert failure is silent and only shows up minutes later on the VNC console.

Confirm the media actually attached before powering on:

```bash
curl -s https://${KVM_IP}:8000/redfish/v1/Systems/${VM_UUID}/VirtualMedia/Cd \
  | python3 -m json.tool
# "Inserted": true, "Image": "http://10.0.2.30:8888/agent.x86_64.iso"
```

For multi-node clusters, repeat for each VM UUID.

### Monitor via VNC

The VMs have VNC enabled on auto-assigned ports. From the KVM host:

```bash
sudo virsh vncdisplay ocp-master-0
# Output: 127.0.0.1:0
```

To connect from your workstation, SSH tunnel through the bastion:

```bash
ssh -L 5900:10.0.2.30:5900 bastion-sandbox
```

Then connect a VNC client to `localhost:5900`.

## 5. Monitor the installation

### From the registry host

```bash
cd ~/ocp-installer
openshift-install agent wait-for bootstrap-complete --dir . --log-level info
openshift-install agent wait-for install-complete --dir . --log-level info
```

> These need the registry to reach the nodes directly: 22 for `openshift-install
> gather`, 6443 for the API before the VIP is live, and 8090 for the
> assisted-service REST API that `agent wait-for bootstrap-complete` polls on the
> rendezvous node. `infra_security_groups` opens all three, per node, derived from
> `ocp_nodes` — nothing to add by hand.

### From the KVM host (VNC or SSH)

Once the agent boots, you can SSH in:

```bash
ssh -i ~/.ssh/disconnected-sandbox.pem core@10.0.2.100
journalctl -u assisted-service.service -f
```

### Signs of progress

| Stage | What you see |
|-------|-------------|
| Agent boot | VNC shows kernel loading, `nslookup` checks, registry connectivity checks |
| Bootstrap | `Waiting for services`, `Cluster installation in progress` |
| Pivot | Node reboots, installs RHCOS to disk |
| Operators | Cluster operators start reconciling |
| Complete | `Finished Bootkube`, `Reached target Multi-User System` |

## 6. Post-install: eject the ISO

After the node reboots into the installed OS, eject the CDROM so it doesn't boot
from the ISO again:

```bash
# On the KVM host
sudo virsh change-media ocp-master-0 sda --eject
```

For multi-node, repeat for each VM.

If the VM has already rebooted into the ISO instead of the installed OS, eject and
reboot:

```bash
sudo virsh change-media ocp-master-0 sda --eject
sudo virsh reboot ocp-master-0
```

## 7. Verify the cluster

From the registry host:

```bash
export KUBECONFIG=~/ocp-installer/auth/kubeconfig
oc get clusterversion
oc get nodes
oc get co
```

Or directly on the node:

```bash
ssh -i ~/.ssh/disconnected-sandbox.pem core@10.0.2.100
sudo oc --kubeconfig=/etc/kubernetes/static-pod-resources/kube-apiserver-certs/secrets/node-kubeconfigs/lb-ext.kubeconfig get clusterversion
```

## Troubleshooting

### Agent installer DNS checks fail

If nslookup fails with `[::1]:53`, the VM's gateway is misconfigured. Ensure
`agent-config.yaml` uses `next-hop-address: 10.0.2.30` (KVM bridge), not the
VPC router (`10.0.2.1`).

### Registry connectivity check fails

Verify the registry firewall allows port 8443:

```bash
# On the registry host
sudo firewall-cmd --list-ports
# If 8443/tcp is missing:
sudo firewall-cmd --add-port=8443/tcp --permanent
sudo firewall-cmd --reload
```

### Redfish InsertMedia fails with "Storage pool not found: default"

The libvirt `default` storage pool must exist. The `kvm_host` role creates it, but
if it was lost:

```bash
sudo virsh pool-define-as default dir --target /var/lib/libvirt/images
sudo virsh pool-start default
sudo virsh pool-autostart default
```

### VM unreachable after reboot

If the host key changed (expected when transitioning from ISO to installed OS):

```bash
ssh-keygen -R 10.0.2.100
ssh -i ~/.ssh/disconnected-sandbox.pem core@10.0.2.100
```

### KVM host boot loops after stop/start

The EBS data volume may get a different NVMe device name. The `kvm_host` role uses
`nofail` in fstab to prevent emergency mode. After boot, check if the volume mounted:

```bash
df -h /var/lib/libvirt/images
# If not mounted, find the correct device and mount:
lsblk
sudo mount /dev/nvmeXn1 /var/lib/libvirt/images
```

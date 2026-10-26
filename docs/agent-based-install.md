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
- The KVM host VMs are defined (`virsh list --all` lists them). Expect them to be `running`,
  not `shut off`: they are set to autostart, so the KVM host's STIG reboot starts them, and
  with no media attached they idle at the firmware. §4 powers them on in a way that works
  from either state.
- The services host serves NTP. `validate.yml` checks this ("validate ntp service"); without
  it the nodes have no time source at all — see
  [Node clock not synchronised](#node-clock-not-synchronised-nodeclocknotsynchronising).
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

`additionalNTPSources` is not optional either. RHCOS ships with only
`pool 0.rhel.pool.ntp.org`, which is unreachable from the air gap, so without the services
host here the nodes install and run with no time source: chrony sits at stratum 0 and the
installed cluster fires `NodeClockNotSynchronising` (critical) from day one. Don't read
anything into the install-time NTP validation either. It can flag the host as insufficient
and then pass a minute later without the clock ever having synced.

```yaml
apiVersion: v1alpha1
metadata:
  name: ocp
rendezvousIP: 10.0.2.100
additionalNTPSources:
  - 10.0.2.10          # services host (services_private_ip)
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

# Power on the VM -- or restart it if it is already running, which on a
# fresh build it usually is (see Prerequisites). "On" does nothing to a
# running VM, so it would never reach the ISO.
POWER=$(curl -fs https://${KVM_IP}:8000/redfish/v1/Systems/${VM_UUID} \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["PowerState"])')
if [ "$POWER" = "On" ]; then RESET=ForceRestart; else RESET=On; fi
curl -f -X POST \
  https://${KVM_IP}:8000/redfish/v1/Systems/${VM_UUID}/Actions/ComputerSystem.Reset \
  -H 'Content-Type: application/json' \
  -d "{\"ResetType\": \"${RESET}\"}"
```

> **Media changes only take effect on a power cycle.** sushy-emulator applies
> InsertMedia, EjectMedia and the boot override to the domain's *stored* libvirt
> definition. A running VM keeps the devices it was started with, and a reboot from
> inside the guest is not a power cycle, so it doesn't pick up the new definition.
> Only a Redfish power action (`On` from off, `ForceRestart`) starts the domain from
> the stored definition. That's why §6 ejects in a specific order.

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
| Pivot | `Writing image to disk: 100%` — **eject only, don't restart** (§6). The node reboots by itself |
| Operators | Cluster operators start reconciling |
| Complete | `Finished Bootkube`, `Reached target Multi-User System` |

## 6. Eject the ISO and boot the installed disk

The agent writes RHCOS to `vda`, then reboots the VM by itself. That reboot comes from
inside the guest, so the VM keeps its CD and boots the agent ISO again (see the note in
§4). Getting it onto the installed disk takes three steps in this order: eject, wait for
the guest's own reboot, then power-cycle.

> **Never power-cycle at `Writing image to disk: 100%`.** "100%" is reported before the
> installer has finished writing the disk out. A `ForceRestart` at that point corrupts
> the install. The node boots from disk into emergency mode with
> `mount: /sysroot: wrong fs type, bad superblock on /dev/vda4`, and the only way back
> is to reinstall from the ISO (§4).

**1. At `Writing image to disk: 100%`, eject the media. Do nothing else.**

```bash
curl -f -X POST \
  https://${KVM_IP}:8000/redfish/v1/Systems/${VM_UUID}/VirtualMedia/Cd/Actions/VirtualMedia.EjectMedia \
  -H 'Content-Type: application/json' -d '{}'
# 204 No Content; VirtualMedia/Cd now reports "Inserted": false
```

This changes only the stored definition. `virsh domblklist` still shows the CD with the
image attached to the running VM, and that's expected.

**2. Wait for the guest to reboot by itself.** It comes back up on the agent ISO. The new
agent has no cluster, so `agent wait-for` starts logging `404 v2GetClusterNotFound`.
That's your signal that the install has finished writing and the old agent has gone.

**3. Only then, power-cycle the VM.**

```bash
curl -f -X POST \
  https://${KVM_IP}:8000/redfish/v1/Systems/${VM_UUID}/Actions/ComputerSystem.Reset \
  -H 'Content-Type: application/json' -d '{"ResetType": "ForceRestart"}'
```

`ForceRestart` starts the domain from the stored definition, now without the CD, so it
boots RHCOS from disk and bootstrap-in-place carries on. Re-run `agent wait-for` if it
gave up during the 404s.

For multi-node clusters, do this per VM as each one reaches step 2.

> **Not `virsh change-media … sda`.** The domain is defined with its CD on `sda`, but
> sushy-emulator attaches virtual media as its own device (`sdx` on this build), so
> `sda` targets the wrong device. Use Redfish for every media change, so sushy's view
> and libvirt's stay in step.

### If the node lands in emergency mode

`wrong fs type, bad superblock on /dev/vda4` means the disk was power-cycled before the
write finished. Reinstall: insert the ISO and power the VM on again as in §4, then follow
this section's three steps.

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

### Node clock not synchronised (NodeClockNotSynchronising)

On a node, `chronyc sources` is empty or shows only `0.rhel.pool.ntp.org`, and
`chronyc tracking` reports stratum 0 with a reference time of 1970. There are two causes,
and a cluster usually has both.

**1. The services host isn't serving time.** On sandboxes built before the fix to
`group_vars/role_services.yml`, the STIG pass appended `port 0` to the services host's
`/etc/chrony.conf`. That turns chrony's NTP server off. chronyd still runs and still keeps
its own clock, and firewalld and the security groups still allow 123/udp, but nothing answers.
Every private host is affected, not just the cluster nodes. Check from any private host:

```bash
sudo chronyd -Q -t 20 "server 10.0.2.10 iburst maxsamples 1"
# Working: "System clock wrong by 0.000123 seconds (ignored)", exit 0
# Broken:  "No suitable source for synchronisation", exit 1
```

Fix it on the services host by removing the line and restarting chronyd. That's the same
deviation the playbooks now apply, and nothing else changes:

```bash
ssh services-sandbox
sudo sed -i '/^port 0$/d' /etc/chrony.conf
sudo systemctl restart chronyd
sudo ss -ulpn | grep ':123 '     # chronyd listening again
```

The RHEL hosts already point at 10.0.2.10 and resync within a few minutes.

**2. The cluster has no NTP source configured.** That's the case if `agent-config.yaml` had
no `additionalNTPSources` (§1). Point chrony at the services host with a MachineConfig. On
the machine where you run `oc` (the registry host), write the Butane source:

```yaml
# 99-master-chrony.bu
variant: openshift
version: 4.21.0          # your cluster's minor version
metadata:
  name: 99-master-chrony
  labels:
    machineconfiguration.openshift.io/role: master
storage:
  files:
    - path: /etc/chrony.conf
      mode: 0644
      overwrite: true
      contents:
        inline: |
          server 10.0.2.10 iburst
          driftfile /var/lib/chrony/drift
          makestep 1.0 3
          rtcsync
          logdir /var/log/chrony
```

```bash
butane 99-master-chrony.bu -o 99-master-chrony.yaml
oc apply -f 99-master-chrony.yaml
oc get mcp master -w        # UPDATED=True when done
```

`butane` isn't on the sandbox hosts by default. Fetch it while you're still connected, as
you did for `oc`, or render it on your workstation and copy the YAML over. For `standard`
(dedicated workers), apply a second copy named `99-worker-chrony` with
`role: worker`.

> **On SNO this reboots the only node,** so the API is down until it comes back. On
> `compact` and `standard` the Machine Config Operator reboots nodes one at a time.

Fix cause 1 first. Otherwise the MachineConfig points the nodes at a server that doesn't
answer, and they stay unsynced. Once a node syncs, `chronyc sources` shows `^* 10.0.2.10` and the alert clears on its next evaluation.

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

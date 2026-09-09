#!/bin/bash
set -euo pipefail

# Pre-fetch RPMs for air-gapped private subnet hosts.
# Run this on an internet-connected RHEL 9 machine (typically the bastion).
# The bastion_repo Ansible role automates this; this script is for manual use.

DEST_DIR="${1:-/var/www/html/repos/rhel9-local}"

PACKAGES=(
  # STIG/hardening
  openscap-scanner
  scap-security-guide
  # DNS
  bind
  bind-utils
  # HAProxy
  haproxy
  # General utilities
  tmux
  tcpdump
  nmap-ncat
)

echo "=== Downloading RPMs + dependencies ==="
echo "Destination: ${DEST_DIR}"
echo "Packages:    ${PACKAGES[*]}"
echo

mkdir -p "${DEST_DIR}"

dnf download \
  --resolve \
  --alldeps \
  --destdir "${DEST_DIR}" \
  "${PACKAGES[@]}"

echo
echo "=== Building repository metadata ==="
createrepo "${DEST_DIR}"

RPM_COUNT=$(find "${DEST_DIR}" -name '*.rpm' | wc -l)
echo
echo "=== Done: ${RPM_COUNT} RPMs in ${DEST_DIR} ==="

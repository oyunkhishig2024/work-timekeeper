#!/usr/bin/env bash
# One-time: gives a small server a 2 GB swap file, so a short memory peak (a deploy build, a heavy report) slows things down
# instead of killing a container. Safe to run again (does nothing when swap already exists).
#   sudo bash infra/deploy/swap.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash infra/deploy/swap.sh" >&2
  exit 1
fi
if [ "$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)" -gt 0 ]; then
  echo "Swap already exists:"
  swapon --show
  exit 0
fi

SIZE_MB=${SWAP_MB:-2048}
fallocate -l "${SIZE_MB}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="$SIZE_MB"
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
# Use swap only when memory is really short (the Ubuntu default of 60 swaps too eagerly for a database server).
echo 'vm.swappiness=10' >/etc/sysctl.d/99-timekeeper-swap.conf
sysctl -q -p /etc/sysctl.d/99-timekeeper-swap.conf
echo "Done:"
swapon --show
free -h

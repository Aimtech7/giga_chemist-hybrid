# Remote support for the pharmacy PC (optional, operator decision)

GIGA CHEMIST itself is managed from the phone (Remote Admin). This is only for the case where
Windows or the GIGA service itself is broken and someone must see the PC's desktop.

**Never expose** PostgreSQL (5432), the POS server (3000), SMB (445) or RDP (3389) to the internet
with port forwarding. Nothing in this repository installs remote-support software; install it only
with the owner's explicit approval.

## Recommended: Tailscale (private encrypted network) + Windows Remote Desktop over it

* Why: WireGuard-encrypted mesh, no inbound port on the router, per-device access control, MFA via
  the identity provider, devices can be removed instantly. RDP is reachable **only** inside the
  tailnet.
* Install (on site, as administrator): download from https://tailscale.com/download/windows, sign in
  with the owner's account (enable MFA), in the admin console disable key expiry for this PC only if
  unattended access is required, and add an ACL that allows only the owner's devices to reach this
  PC on TCP 3389.
* Startup: Tailscale runs as a Windows service (Automatic) and reconnects after reboot without logon.
* Windows: enable Remote Desktop for one dedicated, strong-password local account; keep the Windows
  Firewall RDP rule limited to the Tailscale interface / 100.64.0.0/10.
* Disable: Tailscale admin console → remove the device (immediate), or `tailscale down`, or uninstall.

## Alternative: RustDesk (screen sharing)

* Use only a **self-hosted** RustDesk ID/relay server or the official client with a permanent strong
  password and 2FA enabled; set "Accept sessions via password" + "Deny LAN discovery".
* Startup: installs a Windows service (Automatic). Disable by stopping/uninstalling the service.
* Simpler for screen help, but the public relay sees connection metadata; Tailscale is preferred.

## What to try remotely first (no desktop needed)
Phone → Remote Admin → Health / Alerts. If the PC is ONLINE but GIGA misbehaves, an approved update
or rollback can be done remotely. If the PC is OFFLINE, check power / internet on site (or via
someone at the pharmacy) — software cannot fix a powered-off PC (see TARGET_READINESS_CHECKLIST.md).

# Security Model & Self-Assessment

`portfolio.gerson-sec.com` gives anonymous visitors a **real shell** — every
connection spawns a disposable Alpine container on a Raspberry Pi. Handing a
shell to the internet is a security decision before it is a feature, so this
document records the controls in place and the results of attacking them.

All testing described here was performed by the author against the author's own
system. Method follows [MITRE ATT&CK for Containers](https://attack.mitre.org/matrices/enterprise/containers/).

---

## Architecture

```
Visitor ──HTTPS──> Cloudflare Tunnel ──> Node.js (WebSocket, non-root)
                                              │  spawns one container per session
                                              ▼
                              Alpine sandbox  (--network none, read-only,
                                               non-root, caps dropped, seccomp,
                                               64 MB / 0.5 CPU, pids-limit,
                                               auto-removed, 10-min timeout)
```

- **No inbound ports.** Exposure is via Cloudflare Tunnel; the origin IP is not published and the router forwards nothing.
- **The orchestrator is not root.** The Node.js process runs as an unprivileged service account under a hardened systemd unit (`ProtectSystem`, `ProtectHome`, `NoNewPrivileges`).
- **One container per visitor**, destroyed on disconnect or after 10 minutes. A global cap limits concurrent sessions.
- **The only mount into the sandbox** is the guestbook file, read-only. The Docker socket is never exposed to the container.

---

## Sandbox controls

| Control | Flag | Verified value |
|---|---|---|
| No network | `--network none` | `NetworkMode: none` |
| Read-only root | `--read-only` | `ReadonlyRootfs: true` |
| Non-root user | `--user visitante` | `uid=1000`, never `0` |
| All capabilities dropped | `--cap-drop ALL` | `CapEff: 0000000000000000` |
| No privilege escalation | `--security-opt no-new-privileges` | enforced |
| Seccomp filter | `--security-opt seccomp=default` | `Seccomp: 2` |
| Process limit | `--pids-limit 50` | enforced |
| Memory cap | `--memory 64m` | 64 MB |
| CPU cap | `--cpus 0.5` | enforced |
| No-exec scratch space | `--tmpfs /tmp:noexec,nosuid` | enforced |
| Ephemeral | `--rm` | `AutoRemove: true` |

---

## Adversarial testing

Each control was attacked from inside a live session.

| # | ATT&CK technique | Attempt | Result | Verdict |
|---|---|---|---|---|
| 1 | T1222 — modify filesystem | write to `/`, `/etc/passwd`, `$HOME` | `Read-only file system` | PASS |
| 2 | T1059 — execution | write + exec from `/tmp` | writes, but exec → `Permission denied` (`noexec`) | PASS |
| 3 | T1046 / egress | `ping`, `wget`, `/dev/tcp` | `Network unreachable` | PASS |
| 4 | T1548 — privilege escalation | `sudo`, `su`, check `id` | `sudo` absent, `su` non-suid, stays `uid=1000` | PASS |
| 5 | T1499 — resource exhaustion | fork bomb | contained by `pids-limit`; host and other sessions unaffected | PASS |
| 6 | T1082 — host/secret discovery | `/proc/1/environ`, `mount`, `/etc/shadow` | no host secrets, no docker socket, `/etc/shadow` denied | PASS |
| 7 | T1059.007 — stored XSS | sign guestbook with `<script>` | rendered as literal text (`textContent`) in web and dashboard | PASS |
| 8 | T1611 — namespace escape | `nsenter --target 1`, `readlink /proc/1/root` | `Operation not permitted` | PASS |
| 9 | seccomp coverage | read `/proc/self/status` | `Seccomp: 2` (strict-mode filter active) | PASS |

---

## Finding: seccomp profile was disabled by a config side-effect

The one real weakness was self-inflicted and worth documenting, because the
cause is a common Docker footgun.

**Observed.** `Seccomp: 0` — no syscall filter active — despite the sandbox
appearing hardened.

**Root cause.** The container was launched with a single
`--security-opt no-new-privileges`. Because `--security-opt` was set explicitly,
Docker applied *only* the options passed and silently dropped its **default
seccomp profile**, which is otherwise applied automatically. Adding one
protection removed another.

**Fix.** Pass both options explicitly:

```
--security-opt no-new-privileges
--security-opt seccomp=default
```

**Verification.** `/proc/self/status` now reports `Seccomp: 2`, confirming the
strict-mode filter is active.

**Impact.** Low in practice — `cap-drop ALL` and `no-new-privileges` already
closed most paths the missing filter would have exposed — but it removed a layer
of defence-in-depth that was assumed present. Layered controls are only worth
what verification proves they are.

---

## Informational (not vulnerabilities)

- **Backend fingerprinting.** `mount` reveals a containerd/overlayfs backend and host snapshot paths. Not writable, not escapable; disclosure only.
- **Session logging.** Commands and source IP are logged for security monitoring. This is disclosed to visitors on connect. IPs are truncated before storage and retained on a fixed window.

---

## Scope & disclosure

This assessment covers the sandbox and its host-facing surface. It is a personal
project, not a certified audit. If you find something these tests missed,
open an issue — that is the point of publishing this.

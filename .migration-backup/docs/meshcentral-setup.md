# MeshCentral Setup Guide

This app is a **client** of a real MeshCentral server. You host MeshCentral on your own VPS, and this app calls its Web API to list devices, launch remote desktop / terminal / file-manager sessions, and generate agent installer links you can give to customers.

You only need to do this **once**. After that, every device with the agent installed shows up automatically.

---

## 1. Pick a host

Any cheap Linux VPS works. Recommended specs to start: **1 vCPU, 1–2 GB RAM, 25 GB disk**.

| Provider | ~Cost / month | Notes |
| --- | --- | --- |
| Hetzner CX22 | ~$4 | Cheapest, EU/US regions |
| DigitalOcean Basic | $6 | Easiest UI |
| Vultr Cloud Compute | $6 | Many regions |
| AWS Lightsail | $5 | If you already use AWS |

Pick **Ubuntu 22.04 LTS** as the OS.

---

## 2. Point a DNS name at it

In your DNS provider (Cloudflare, Namecheap, GoDaddy, etc.), create an **A record**:

```
mesh.csdinc.com   →   <your VPS public IP>
```

Wait a couple of minutes for DNS to propagate.

> The hostname matters because MeshCentral will request a Let's Encrypt TLS certificate for it on first boot. Don't skip this.

---

## 3. Open the firewall

On the VPS, allow inbound TCP **80, 443, and 4433** (4433 is for agent traffic):

```bash
sudo ufw allow 22,80,443,4433/tcp
sudo ufw enable
```

If your VPS provider has its own firewall (DigitalOcean Cloud Firewall, AWS Security Group, etc.), allow those same ports there too.

---

## 4. Install MeshCentral

SSH into the VPS and run:

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Create a service directory
sudo mkdir -p /opt/meshcentral
sudo chown $USER:$USER /opt/meshcentral
cd /opt/meshcentral

# Install MeshCentral itself
npm install meshcentral

# Run once interactively to generate config and pull the TLS cert
node node_modules/meshcentral --cert mesh.csdinc.com --port 443 --redirport 80 --agentport 4433
```

Let it run for ~60 seconds — it will fetch a Let's Encrypt cert, create `meshcentral-data/`, and start the web UI. Press **Ctrl+C** when you see "MeshCentral HTTP server running on port 443."

---

## 5. Create your admin account

```bash
node node_modules/meshcentral/meshctrl.js AddUser \
  --user admin \
  --pass 'pick-a-strong-password' \
  --siteadmin
```

> **Save that password** — you'll paste it into Replit secrets in step 7.

---

## 6. Run MeshCentral as a service (so it survives reboots)

Create `/etc/systemd/system/meshcentral.service`:

```ini
[Unit]
Description=MeshCentral Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/meshcentral
ExecStart=/usr/bin/node /opt/meshcentral/node_modules/meshcentral
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now meshcentral
sudo systemctl status meshcentral
```

You should see "active (running)". Visit **https://mesh.csdinc.com** in a browser — log in as `admin`. You're now hosting MeshCentral.

---

## 7. Connect this app to your server

In Replit, open the **Secrets** panel (Tools → Secrets) and add:

| Secret | Value |
| --- | --- |
| `MESHCENTRAL_URL` | `https://mesh.csdinc.com` |
| `MESHCENTRAL_USERNAME` | `admin` |
| `MESHCENTRAL_PASSWORD` | the password from step 5 |

(Optional alternative: skip username/password and set `MESHCENTRAL_API_KEY` instead — generate one in MeshCentral under **My Account → API Keys**.)

Then say **"MeshCentral credentials are set"** in chat and I will:

- Verify `/api/meshcentral/status` returns `connected`
- Confirm `/api/meshcentral/devices` shows your real fleet
- Wire the **Remote Access** UI to the live device list and launch real desktop / terminal / file sessions

---

## 8. Install the agent on a customer machine

In MeshCentral's UI, **Add Devices → Add Agent** generates a one-line installer link or downloadable `.exe` / `.sh` your customer can run. Once it runs, the device appears in MeshCentral **and** in this app's Remote Access page automatically.

You can also use this app's `/api/meshcentral/agents` endpoint to get the same installer URLs programmatically — once the secrets above are set, we can put a "Download agent for this customer" button on each Lead/Job page.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Browser shows TLS warning at `mesh.csdinc.com` | Let's Encrypt didn't issue. Check that DNS points at the VPS and ports 80/443 are open, then `sudo systemctl restart meshcentral`. |
| Agent won't connect | Port 4433 not open in your VPS firewall. |
| `/api/meshcentral/status` returns `authentication_failed` | Wrong username/password — re-enter them in Replit Secrets. |
| `/api/meshcentral/status` returns `not_configured` after setting secrets | Restart the workflow in Replit so the new env vars load. |

# Documentation index

| Document | Audience | Contents |
|----------|----------|----------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Developers | System design, data flow, what is canonical |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Ops / client handoff | Deploy commands, testing, troubleshooting |
| [SNAPSHOT.md](./SNAPSHOT.md) | Ops | Golden Hetzner image build |
| [MANUAL-SNAPSHOT.md](./MANUAL-SNAPSHOT.md) | Ops | Manual snapshot fallback |
| [DEPLOY_FUNCTIONS.md](./DEPLOY_FUNCTIONS.md) | Ops | Cloud Functions IAM issues |
| [STEAM_LOGIN_SETUP.md](./STEAM_LOGIN_SETUP.md) | Ops | cPanel Steam + Firebase token setup |

## Quick reference

```bash
npm run deploy:all        # Full release (hosting + functions + verify)
npm run deploy:hosting    # Frontend only
npm run deploy:functions  # CS2 backend only
npm run verify:secrets    # Scan tracked files for leaked credentials
```
